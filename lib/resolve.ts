/**
 * The learning loop.
 *
 * This file is the product. Everything else is plumbing.
 *
 *   adjudicate a claim        → deterministic, via Tatum
 *   recompute trust           → Wilson lower bound, pure arithmetic
 *   append three memories     → resolution, score version, and nothing is edited
 *   update the projection     → so the UI reflects it on the next read
 *
 * The ordering matters. Memories are written before the projection is updated:
 * if the process dies between the two, the projection is merely stale and
 * `restore` fixes it. The reverse order would mean a verdict the system
 * believes but cannot prove.
 *
 * Writes are slow (~24s each, ~6s/item bulk). This function is designed to be
 * called from a background job, never from a request a user is waiting on.
 */
import "server-only";

import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { adjudicate } from "./adjudicate";
import { isIdempotencyConflict } from "./bounded";
import { getDb, schema } from "./db";
import { exclusionVerdict } from "./scoring-exclusion";
import { pendingWrites } from "./durable-writes";
import { findPersistedKeys } from "./persisted-keys";
import { recallMemory, writeMemoriesDurable, type MemoryWrite, type RecallHit } from "./memwal";
import { gateClaimResolve } from "./resolve-lock";
import { logMemories } from "./memory-log";
import { foldCategories, tallyCategories } from "./category-score";
import { claimMemory, resolutionMemory, scoreMemory, type ScoreMemoryCategories } from "./memory-text";
import { computeScore, replaceOutcome, type ScoreSnapshot } from "./score";
import {
  resolutionIdempotencyKey,
  resolutionRecallQuery,
  scoreIdempotencyKey,
  scoreRecallQuery,
  resolutionContentMatches,
  scoreContentMatches,
  selectStoredResolution,
  selectStoredResolutionForBlob,
  selectStoredScore,
  type StoredResolution,
  type StoredScore,
} from "./stored-resolution";
import { NS } from "./types";
import type { ClaimParams, ClaimType, BalanceSnapshot, Outcome } from "./types";

export interface ResolveReport {
  claimId: string;
  handle: string;
  externalId: string | null;
  outcome: "true" | "false" | "void";
  reason: string;
  scoreBefore: number;
  scoreAfter: number;
  blobs: { resolution?: string; score?: string };
  skipped?: string;
}

export interface ClaimLogContext {
  claimId: string;
  handle: string;
  externalId: string | null;
}

export interface ResolveHooks {
  onList?: (ids: readonly string[]) => void;
  onClaimStart?: (claimId: string) => void;
  /** Fires once the claim and its source row are loaded, before any network call. */
  onClaimLoaded?: (claim: ClaimLogContext) => void;
  onClaimDone?: (report: ResolveReport, elapsedMs: number) => void;
  onClaimError?: (claimId: string, error: string, elapsedMs: number) => void;
  /** Return true to stop the batch after the error has been recorded. */
  stopOnError?: (err: unknown) => boolean;
}

export interface ResolveBatch {
  reports: ResolveReport[];
  errors: Array<{ claimId: string; error: string }>;
  /** Set when `stopOnError` ended the batch before every id was tried. */
  stopped?: string;
}

export interface ResolveOptions {
  /**
   * Append a new resolution for a claim that already has one. The previous
   * Walrus memory stays. Only a void is re-checked, unless `force` is set.
   */
  supersede?: boolean;
  /** Re-check a true or false verdict too. Still appends; it does not edit. */
  force?: boolean;
  /**
   * A resolution row already points at a blob. Read that memory and, when
   * the stored verdict differs, project it. Does not call Tatum. Seed uses
   * this; the periodic pass does not, so it does not recall every resolution
   * every minute.
   */
  reconcile?: boolean;
}

/**
 * Resolve one claim and fold the result into the source's trust.
 *
 * The first resolution is idempotent: a claim that already has one returns
 * it without writing. `supersede` appends a new revision (`resolution:{id}:rN`)
 * and moves the projection to that verdict. The previous memory is left in
 * place. A void that becomes true adds one hit, the same count the Wilson
 * replay gets from keeping only the latest outcome.
 */
export async function resolveClaim(
  claimId: string,
  now = new Date(),
  opts: ResolveOptions = {},
  hooks?: Pick<ResolveHooks, "onClaimLoaded">,
): Promise<ResolveReport> {
  return gateClaimResolve(
    claimId,
    () => resolveClaimBody(claimId, now, opts, hooks),
    () => claimLockedReport(claimId),
  );
}

/** The other process is already resolving this claim. Do not adjudicate or write. */
async function claimLockedReport(claimId: string): Promise<ResolveReport> {
  const [row] = await getDb()
    .select({
      handle: schema.sources.handle,
      externalId: schema.claims.externalId,
      score: schema.sources.score,
    })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .where(eq(schema.claims.id, claimId))
    .limit(1);
  const context: ClaimLogContext = {
    claimId,
    handle: row?.handle ?? "unknown",
    externalId: row?.externalId ?? null,
  };
  return skippedReport(
    context,
    "void",
    "another resolver holds this claim",
    row?.score ?? 0,
    "resolve lock held",
  );
}

async function resolveClaimBody(
  claimId: string,
  now = new Date(),
  opts: ResolveOptions = {},
  hooks?: Pick<ResolveHooks, "onClaimLoaded">,
): Promise<ResolveReport> {
  const db = getDb();

  const [row] = await db
    .select({
      claim: schema.claims,
      source: schema.sources,
    })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .where(eq(schema.claims.id, claimId))
    .limit(1);

  if (!row) throw new Error(`claim not found: ${claimId}`);
  const { claim, source } = row;
  const context: ClaimLogContext = {
    claimId: claim.id,
    handle: source.handle,
    externalId: claim.externalId ?? null,
  };
  hooks?.onClaimLoaded?.(context);

  const [existing] = await db
    .select()
    .from(schema.resolutions)
    .where(eq(schema.resolutions.claimId, claimId))
    .orderBy(desc(schema.resolutions.resolvedAt))
    .limit(1);

  if (existing && !opts.supersede) {
    // A blob id means a memory was already accepted. The periodic pass leaves
    // it alone. `reconcile` (the seed) reads it and projects Walrus when the
    // stored verdict differs. A row with no blob is the DB-only state: repair
    // it from the stored verdict, or from Walrus if the memory is already there.
    if (existing.walrusBlobId && !opts.reconcile) {
      return skippedReport(context, existing.outcome, existing.reason, source.score, "already resolved");
    }
    return repairRecordedResolution(claim, source, context, existing, now);
  }
  if (existing && existing.outcome !== "void" && !opts.force) {
    return skippedReport(context, existing.outcome, existing.reason, source.score, "already adjudicated");
  }

  // A resolution Walrus already accepted must be projected, not rewritten.
  // Re-adjudicating would spend Tatum credits and can build different bytes
  // under the same key (the 409 that left b3cfb240 pending).
  if (!existing) {
    const loggedBlob = await blobForKey(resolutionIdempotencyKey(claim.id, 1));
    const stored = await recallResolution(
      { id: claim.id, handle: source.handle, quote: claim.quote },
      loggedBlob,
    );
    if (loggedBlob && !stored) {
      throw new Error(
        `${context.handle} ${claim.id}${externalSuffix(context)}: resolution ${resolutionIdempotencyKey(claim.id, 1)} is already logged as blob ${loggedBlob}, but recall could not read it. Claim left pending.`,
      );
    }
    if (stored) return adoptStored(claim, source, context, stored, now);
  }

  const snapshot = (claim.snapshot as BalanceSnapshot | null) ?? null;
  const excluded = exclusionVerdict({ synthetic: claim.synthetic, params: claim.params });

  const verdict =
    excluded ??
    (await adjudicate(
      {
        claimType: claim.claimType as ClaimType,
        params: claim.params as unknown as ClaimParams,
        snapshot,
        deadline: claim.deadline.toISOString(),
        deadlineBasis: claim.deadlineBasis,
      },
      now,
    ));

  // A void never moves the score, so it does not produce a score version.
  // Replacing one removes its old contribution first, so a void that becomes
  // true adds a single hit and a second pass over a true claim adds none.
  const before = computeScore(source.hits, source.misses);
  const after = replaceOutcome(
    source.hits,
    source.misses,
    existing?.outcome ?? null,
    verdict.outcome,
  );
  const revision = existing ? evidenceRevision(existing.evidence) + 1 : 1;
  const resolvedAt = now.toISOString();
  const evidence = resolutionEvidence(verdict.evidence, revision, resolvedAt);

  const writes: MemoryWrite[] = [];

  // Memory bytes are the verdict only. `evidence` above carries resolvedAt
  // for the projection row; putting that clock in the memory is what made
  // two resolvers 409 each other.
  const resolutionText = resolutionMemory(
    {
      claimId: claim.id,
      sourceHandle: source.handle,
      claimType: claim.claimType as ClaimType,
      quote: claim.quote,
      outcome: verdict.outcome,
      reason: verdict.reason,
      evidence: verdict.evidence,
    },
    { before, after },
    { revision },
  );
  writes.push({
    text: resolutionText.text,
    namespace: NS.resolution,
    idempotencyKey: resolutionText.key,
  });

  const scorePlan = await scoreForVerdict(source, claim.id, verdict.outcome, before, after, claim.claimType);
  if (scorePlan?.write) writes.push(scorePlan.write);

  const known = await findPersistedKeys(writes);
  if (!existing && known.has(resolutionText.key)) {
    const loggedBlob = await blobForKey(resolutionText.key);
    const stored = await recallResolution(
      { id: claim.id, handle: source.handle, quote: claim.quote },
      loggedBlob,
    );
    if (!stored) {
      throw new Error(
        `${context.handle} ${claim.id}${externalSuffix(context)}: ${resolutionText.key} was logged during adjudication, but recall could not read it. Claim left pending.`,
      );
    }
    const disagreed = verdictDiffers(stored, verdict);
    if (disagreed) warnResolutionDisagreement(context, stored, verdict, "adjudicated");
    return adoptStored(claim, source, context, stored, now, disagreed);
  }

  const pending = pendingWrites(writes, known);
  const blobs = new Map<string, string>();
  const { error, cause } = await writeMemoriesDurable(pending, async (write, result) => {
    await logMemories([write], [{ id: result.id, blobId: result.blobId, namespace: write.namespace }]);
    blobs.set(write.idempotencyKey, result.blobId);
  });
  if (error) {
    const conflict = isIdempotencyConflict(cause) || isIdempotencyConflict(error);
    if (conflict && !blobs.has(resolutionText.key)) {
      const stored = await recallResolution(
        { id: claim.id, handle: source.handle, quote: claim.quote },
        null,
        true,
      );
      if (!stored) {
        throw new Error(
          `${context.handle} ${claim.id}${externalSuffix(context)}: ${resolutionText.key} was already used with different content, and recall could not read the stored memory. Claim left pending. ${error}`,
          cause ? { cause } : undefined,
        );
      }
      const disagreed = verdictDiffers(stored, verdict);
      if (disagreed) warnResolutionDisagreement(context, stored, verdict, "adjudicated");
      return adoptStored(claim, source, context, stored, now, disagreed);
    }
    if (conflict && scorePlan?.write && blobs.has(resolutionText.key)) {
      const adopted = await recallScore(source.id, source.handle, claim.id);
      if (!adopted) {
        throw new Error(
          `${context.handle} ${claim.id}${externalSuffix(context)}: ${scorePlan.write.idempotencyKey} was already used with different content, and recall could not read it. Claim left pending. ${error}`,
          cause ? { cause } : undefined,
        );
      }
      assertScoreMatches(context, scorePlan.write.idempotencyKey, adopted, {
        sourceId: source.id,
        version: scorePlan.version,
        hits: scorePlan.snapshot.hits,
        misses: scorePlan.snapshot.misses,
        triggeredByClaimId: claim.id,
      });
      await logStoredScore(adopted);
      const committed = await commitVerdict({
        claimId: claim.id,
        sourceId: source.id,
        existing: Boolean(existing),
        supersede: Boolean(opts.supersede),
        outcome: verdict.outcome,
        reason: verdict.reason,
        evidence,
        resolvedAt: now,
        resolutionBlob: blobs.get(resolutionText.key) ?? null,
        score: scoreCommitFromStored(adopted),
        fallbackScore: before.score,
      });
      if (committed.skipped) {
        return skippedReport(context, committed.outcome, committed.reason, source.score, "already resolved");
      }
      return {
        ...context,
        outcome: verdict.outcome,
        reason: verdict.reason,
        scoreBefore: before.score,
        scoreAfter: committed.scoreAfter,
        blobs: {
          ...(committed.resolutionBlob ? { resolution: committed.resolutionBlob } : {}),
          score: adopted.blobId,
        },
        skipped: "adopted stored score",
      };
    }
    throw new Error(
      `${context.handle} ${claim.id}${externalSuffix(context)}: failed to persist a memory for claim ${claim.id} after ${blobs.size} new blob(s): ${error}`,
      cause ? { cause } : undefined,
    );
  }

  const resolutionBlob = blobs.get(resolutionText.key) ?? (await blobForKey(resolutionText.key));
  const scoreBlob = scorePlan?.write
    ? (blobs.get(scorePlan.write.idempotencyKey) ?? (await blobForKey(scorePlan.write.idempotencyKey)))
    : scorePlan?.adopted?.blobId;

  const committed = await commitVerdict({
    claimId: claim.id,
    sourceId: source.id,
    existing: Boolean(existing),
    supersede: Boolean(opts.supersede),
    outcome: verdict.outcome,
    reason: verdict.reason,
    evidence,
    resolvedAt: now,
    resolutionBlob: resolutionBlob ?? null,
    score: scorePlan ? scoreCommit(claim.id, scorePlan, scoreBlob ?? null) : null,
    fallbackScore: after.score,
  });
  if (committed.skipped) {
    return skippedReport(context, committed.outcome, committed.reason, source.score, "already resolved");
  }

  return {
    ...context,
    outcome: verdict.outcome,
    reason: verdict.reason,
    scoreBefore: before.score,
    scoreAfter: committed.scoreAfter,
    blobs: {
      ...(resolutionBlob ? { resolution: resolutionBlob } : {}),
      ...(scoreBlob ? { score: scoreBlob } : {}),
    },
  };
}

/**
 * Pending claims whose deadline has passed, oldest deadline first.
 */
export async function listDueClaimIds(now = new Date(), limit = 25): Promise<string[]> {
  const db = getDb();
  const due = await db
    .select({ id: schema.claims.id })
    .from(schema.claims)
    .where(and(eq(schema.claims.status, "pending"), lte(schema.claims.deadline, now)))
    .orderBy(schema.claims.deadline)
    .limit(limit);
  return due.map((row) => row.id);
}

/** Resolutions the projection recorded without a Walrus blob id. */
export async function listUnlinkedResolutionIds(limit = 200): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.resolutions.claimId })
    .from(schema.resolutions)
    .where(isNull(schema.resolutions.walrusBlobId))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Resolutions that already name a blob. Seed reconciles these once per run.
 * A superseded claim can have more than one row; each claim is listed once.
 */
export async function listLinkedResolutionIds(limit = 500): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ id: schema.resolutions.claimId })
    .from(schema.resolutions)
    .where(isNotNull(schema.resolutions.walrusBlobId))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Write or adopt the Walrus memory for a verdict Postgres already stored.
 * Does not call Tatum. A claim the periodic pass parked on a 409 is still
 * repaired here, because this does not consult the backoff.
 */
export async function repairUnlinkedResolutions(
  now = new Date(),
  hooks?: ResolveHooks,
): Promise<ResolveBatch> {
  const ids = await listUnlinkedResolutionIds();
  hooks?.onList?.(ids);
  return resolveClaimsById(ids, now, hooks);
}

/**
 * Read each linked resolution and project the stored memory when it differs.
 * One seed run, not the 60s pass.
 */
export async function reconcileResolvedClaims(
  now = new Date(),
  hooks?: ResolveHooks,
): Promise<ResolveBatch> {
  const ids = await listLinkedResolutionIds();
  hooks?.onList?.(ids);
  return resolveClaimsById(ids, now, hooks, { reconcile: true });
}

/**
 * Resolve the given claims. A throw is recorded and the loop continues, so
 * one dead claim does not drop the rest of the batch. The claim stays
 * `pending` when this throws — the caller decides when to try again.
 */
export async function resolveClaimsById(
  ids: readonly string[],
  now = new Date(),
  hooks?: ResolveHooks,
  opts: ResolveOptions = {},
): Promise<ResolveBatch> {
  const reports: ResolveReport[] = [];
  const errors: Array<{ claimId: string; error: string }> = [];

  for (const id of ids) {
    const started = Date.now();
    hooks?.onClaimStart?.(id);
    try {
      const report = await resolveClaim(id, now, opts, hooks);
      hooks?.onClaimDone?.(report, Date.now() - started);
      reports.push(report);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      hooks?.onClaimError?.(id, error, Date.now() - started);
      errors.push({ claimId: id, error });
      if (hooks?.stopOnError?.(err)) return { reports, errors, stopped: error };
    }
  }

  return { reports, errors };
}

/**
 * Resolve every claim whose deadline has passed.
 *
 * Intended for a cron or a "Resolve all" button. Returns per-claim reports so
 * the UI can show partial progress rather than one opaque failure. This path
 * does not apply the periodic backoff; the button means "check them now".
 */
export async function resolveDueClaims(
  now = new Date(),
  limit = 25,
  hooks?: ResolveHooks,
): Promise<ResolveBatch> {
  const ids = await listDueClaimIds(now, limit);
  hooks?.onList?.(ids);
  return resolveClaimsById(ids, now, hooks);
}

/**
 * Persist a claim's three memories: the claim, plus its ingest snapshot is
 * already inside the claim memory text. Called from ingest, not from resolve.
 */
export async function persistClaimMemories(claimId: string): Promise<string | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ claim: schema.claims, source: schema.sources })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .where(eq(schema.claims.id, claimId))
    .limit(1);

  if (!row) throw new Error(`claim not found: ${claimId}`);

  const mem = claimMemory(
    {
      id: row.claim.id,
      sourceHandle: row.source.handle,
      claimType: row.claim.claimType as ClaimType,
      params: row.claim.params as unknown as ClaimParams,
      deadline: row.claim.deadline.toISOString(),
      confidence: row.claim.confidence,
    },
    {
      quote: row.claim.quote,
      claimType: row.claim.claimType as ClaimType,
      params: row.claim.params as unknown as ClaimParams,
      deadline: row.claim.deadline.toISOString(),
      confidence: row.claim.confidence,
    },
    (row.claim.snapshot as BalanceSnapshot | null) ?? null,
    {
      synthetic: row.claim.synthetic,
      ...(row.claim.externalId ? { externalId: row.claim.externalId } : {}),
      ...(row.claim.sourceUrl ? { sourceUrl: row.claim.sourceUrl } : {}),
      ...(row.claim.deadlineBasis ? { deadlineBasis: row.claim.deadlineBasis } : {}),
    },
  );

  const write = { text: mem.text, namespace: NS.claim, idempotencyKey: mem.key };
  let blobId: string | undefined;
  const { error, cause } = await writeMemoriesDurable([write], async (item, result) => {
    await logMemories([item], [{ id: result.id, blobId: result.blobId, namespace: item.namespace }]);
    blobId = result.blobId;
  });
  if (error) throw new Error(`memory write stopped: ${error}`, cause ? { cause } : undefined);
  blobId = blobId ?? (await blobForKey(write.idempotencyKey)) ?? undefined;
  if (blobId) {
    await db.update(schema.claims).set({ walrusBlobId: blobId }).where(eq(schema.claims.id, claimId));
  }
  return blobId;
}

function evidenceRevision(evidence: unknown): number {
  if (!evidence || typeof evidence !== "object") return 1;
  const revision = (evidence as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function resolutionEvidence(
  evidence: unknown,
  revision: number,
  resolvedAt: string,
): Record<string, unknown> {
  const base =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? { ...(evidence as Record<string, unknown>) }
      : { value: evidence ?? null };
  return { ...base, revision, resolvedAt };
}

async function blobForKey(key: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ blobId: schema.memoryLog.blobId })
    .from(schema.memoryLog)
    .where(eq(schema.memoryLog.idempotencyKey, key))
    .limit(1);
  return row?.blobId ?? null;
}

function skippedReport(
  context: ClaimLogContext,
  outcome: Outcome,
  reason: string,
  score: number,
  skipped: string,
): ResolveReport {
  return {
    ...context,
    outcome,
    reason,
    scoreBefore: score,
    scoreAfter: score,
    blobs: {},
    skipped,
  };
}

function externalSuffix(context: ClaimLogContext): string {
  return context.externalId ? ` ${context.externalId}` : "";
}

interface RecordedResolution {
  outcome: Outcome;
  reason: string;
  evidence: unknown;
  walrusBlobId: string | null;
  resolvedAt: Date;
}

interface RepairClaim {
  id: string;
  quote: string;
  claimType: string;
}

interface RepairSource {
  id: string;
  handle: string;
  hits: number;
  misses: number;
  score: number;
}

/** Evidence stored on the row, without the clock fields that made two bodies differ. */
function memoryEvidence(evidence: unknown): Record<string, unknown> {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return {};
  const copy = { ...(evidence as Record<string, unknown>) };
  delete copy.resolvedAt;
  delete copy.revision;
  return copy;
}

/** Outcome and reason. Candle evidence can differ without this being a different verdict. */
function verdictDiffers(a: { outcome: string; reason: string }, b: { outcome: string; reason: string }): boolean {
  return a.outcome !== b.outcome || a.reason !== b.reason;
}

function warnResolutionDisagreement(
  context: ClaimLogContext,
  stored: StoredResolution,
  recorded: { outcome: string; reason: string },
  which: "adjudicated" | "recorded",
): void {
  console.warn(
    `[resolve] ${context.handle} ${context.claimId}${externalSuffix(context)}: Walrus ${resolutionIdempotencyKey(context.claimId, stored.revision)} is ${stored.outcome} (${stored.reason}). The ${which} verdict was ${recorded.outcome} (${recorded.reason}). Postgres will follow the stored memory.`,
  );
}

function assertScoreMatches(
  context: ClaimLogContext,
  key: string,
  stored: StoredScore,
  expected: { sourceId: string; version: number; hits: number; misses: number; triggeredByClaimId: string | null },
): void {
  if (scoreContentMatches(stored, expected)) return;
  throw new Error(
    `${context.handle} ${context.claimId}${externalSuffix(context)}: ${key} was already used with different content, and the stored score does not match this verdict (stored ${stored.hits}/${stored.misses} v${stored.version}). Claim left pending.`,
  );
}

function conflictLeftPending(context: ClaimLogContext, key: string, detail: string): Error {
  return new Error(
    `${context.handle} ${context.claimId}${externalSuffix(context)}: ${key} was already used with different content, and recall could not read the stored memory. Claim left pending. ${detail}`,
  );
}

interface TriggeredScore {
  version: number;
  hits: number;
  misses: number;
  score: number;
  reason: string;
  blob: string | null;
}

async function triggeredScore(claimId: string, sourceId: string): Promise<TriggeredScore | null> {
  const [row] = await getDb()
    .select({
      version: schema.scoreVersions.version,
      score: schema.scoreVersions.score,
      hits: schema.scoreVersions.hits,
      misses: schema.scoreVersions.misses,
      reason: schema.scoreVersions.reason,
      blob: schema.scoreVersions.walrusBlobId,
    })
    .from(schema.scoreVersions)
    .where(and(eq(schema.scoreVersions.triggeredByClaimId, claimId), eq(schema.scoreVersions.sourceId, sourceId)))
    .orderBy(desc(schema.scoreVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * The resolution row means this outcome was folded into the source when a
 * score version names the claim. A row with no score version was not folded
 * (a void, or a commit that never reached the score). Passing the recorded
 * outcome in that case would subtract a hit that is not there.
 */
async function scoreRepairPlan(
  source: RepairSource,
  claimId: string,
  recordedOutcome: Outcome,
  targetOutcome: Outcome,
  claimType: string,
): Promise<{ plan: ScorePlan | null; stampVersion: number | null }> {
  const triggered = await triggeredScore(claimId, source.id);
  const previous = triggered ? recordedOutcome : null;
  const before = computeScore(source.hits, source.misses);
  let after: ScoreSnapshot;
  try {
    after = replaceOutcome(source.hits, source.misses, previous, targetOutcome);
  } catch {
    after = before;
  }
  if (after.hits !== before.hits || after.misses !== before.misses) {
    return { plan: await scoreForVerdict(source, claimId, targetOutcome, before, after, claimType), stampVersion: null };
  }
  if (triggered && !triggered.blob) {
    const snap = computeScore(triggered.hits, triggered.misses);
    const built = scoreMemory(
      {
        sourceId: source.id,
        sourceHandle: source.handle,
        version: triggered.version,
        triggeredByClaimId: claimId,
        reason: triggered.reason,
      },
      snap,
      null,
    );
    return {
      plan: {
        write: { text: built.text, namespace: NS.score, idempotencyKey: built.key },
        snapshot: snap,
        version: triggered.version,
        reason: triggered.reason,
      },
      stampVersion: triggered.version,
    };
  }
  return { plan: null, stampVersion: null };
}

async function repairRecordedResolution(
  claim: RepairClaim,
  source: RepairSource,
  context: ClaimLogContext,
  existing: RecordedResolution,
  now: Date,
): Promise<ResolveReport> {
  const revision = evidenceRevision(existing.evidence);
  const key = resolutionIdempotencyKey(claim.id, revision);
  const loggedBlob = await blobForKey(key);
  const hint = loggedBlob ?? existing.walrusBlobId;
  const recallClaim = { id: claim.id, handle: source.handle, quote: claim.quote };
  let stored = await recallResolution(recallClaim, null, false);
  stored = await keepCurrentRevision(stored, revision, existing.walrusBlobId, recallClaim, context);
  if (!stored && hint) {
    const hinted = await recallResolution(recallClaim, hint, true);
    stored = await keepCurrentRevision(hinted, revision, existing.walrusBlobId, recallClaim, context);
  }

  if (stored) return projectStoredResolution(claim, source, context, existing, stored, now);

  // A blob id or a log row means the key was accepted. Recall can miss a
  // memory that is there. Writing another body is the 409. Do not report the
  // recorded sentence as if it were that memory.
  if (hint) {
    throw new Error(
      `${context.handle} ${claim.id}${externalSuffix(context)}: resolution ${key} is already stored as blob ${hint}, but recall could not read it. The recorded verdict was left in place and was not treated as the Walrus memory.`,
    );
  }

  const evidence = memoryEvidence(existing.evidence);
  const resolutionText = resolutionMemory(
    {
      claimId: claim.id,
      sourceHandle: source.handle,
      claimType: claim.claimType as ClaimType,
      quote: claim.quote,
      outcome: existing.outcome,
      reason: existing.reason,
      evidence,
    },
    { before: computeScore(source.hits, source.misses), after: computeScore(source.hits, source.misses) },
    { revision },
  );
  let resolutionBlob: string;
  try {
    resolutionBlob = (await writeOne({ text: resolutionText.text, namespace: NS.resolution, idempotencyKey: key })).blobId;
  } catch (err) {
    if (!isIdempotencyConflict(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${context.handle} ${claim.id}${externalSuffix(context)}: failed to persist the recorded resolution: ${message}`,
        { cause: err },
      );
    }
    const adopted = await recallResolution(recallClaim, null, true);
    if (!adopted) throw conflictLeftPending(context, key, err instanceof Error ? err.message : String(err));
    const current = await keepCurrentRevision(adopted, revision, existing.walrusBlobId, recallClaim, context);
    if (!current) throw conflictLeftPending(context, key, err instanceof Error ? err.message : String(err));
    return projectStoredResolution(claim, source, context, existing, current, now);
  }

  const score = await attachRepairScore(claim, source, context, existing.outcome, existing.outcome);
  const before = computeScore(source.hits, source.misses);
  const committed = await commitVerdict({
    claimId: claim.id,
    sourceId: source.id,
    existing: true,
    supersede: false,
    relink: true,
    outcome: existing.outcome,
    reason: existing.reason,
    evidence: resolutionEvidence(evidence, revision, existing.resolvedAt.toISOString()),
    resolvedAt: existing.resolvedAt,
    resolutionBlob,
    score: score.plan && score.stampVersion === null ? scoreCommit(claim.id, score.plan, score.writtenBlob) : null,
    stampScore: score.stampVersion !== null && score.writtenBlob ? { version: score.stampVersion, blobId: score.writtenBlob } : null,
    fallbackScore: before.score,
  });
  return {
    ...context,
    outcome: existing.outcome,
    reason: existing.reason,
    scoreBefore: before.score,
    scoreAfter: committed.scoreAfter,
    blobs: {
      resolution: resolutionBlob,
      ...(score.writtenBlob ? { score: score.writtenBlob } : {}),
    },
    skipped: "repaired resolution memory",
  };
}

async function attachRepairScore(
  claim: RepairClaim,
  source: RepairSource,
  context: ClaimLogContext,
  recordedOutcome: Outcome,
  targetOutcome: Outcome,
): Promise<{ plan: ScorePlan | null; stampVersion: number | null; writtenBlob: string | null }> {
  const score = await scoreRepairPlan(source, claim.id, recordedOutcome, targetOutcome, claim.claimType);
  if (!score.plan?.write) {
    return { plan: score.plan, stampVersion: score.stampVersion, writtenBlob: score.plan?.adopted?.blobId ?? null };
  }
  try {
    const written = await writeOne(score.plan.write);
    return { plan: score.plan, stampVersion: score.stampVersion, writtenBlob: written.blobId };
  } catch (err) {
    if (!isIdempotencyConflict(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${context.handle} ${claim.id}${externalSuffix(context)}: failed to persist the score for the recorded resolution: ${message}`,
        { cause: err },
      );
    }
    const adopted = await recallScore(source.id, source.handle, claim.id);
    if (!adopted) throw conflictLeftPending(context, score.plan.write.idempotencyKey, err instanceof Error ? err.message : String(err));
    assertScoreMatches(context, score.plan.write.idempotencyKey, adopted, {
      sourceId: source.id,
      version: score.plan.version,
      hits: score.plan.snapshot.hits,
      misses: score.plan.snapshot.misses,
      triggeredByClaimId: claim.id,
    });
    await logStoredScore(adopted);
    return {
      plan: {
        adopted,
        snapshot: computeScore(adopted.hits, adopted.misses),
        version: adopted.version,
        reason: adopted.reason,
      },
      stampVersion: score.stampVersion,
      writtenBlob: adopted.blobId,
    };
  }
}

async function projectStoredResolution(
  claim: RepairClaim,
  source: RepairSource,
  context: ClaimLogContext,
  existing: RecordedResolution,
  stored: StoredResolution,
  now: Date,
): Promise<ResolveReport> {
  const recordedRevision = evidenceRevision(existing.evidence);
  if (stored.revision < recordedRevision) {
    throw olderRevisionError(context, recordedRevision, stored.revision);
  }
  const matches = resolutionContentMatches(stored, {
    claimId: claim.id,
    outcome: existing.outcome,
    reason: existing.reason,
    evidence: memoryEvidence(existing.evidence),
  });
  const verdictChanged = verdictDiffers(stored, existing);
  if (verdictChanged) warnResolutionDisagreement(context, stored, existing, "recorded");
  await logMemories(
    [
      {
        text: stored.text,
        namespace: NS.resolution,
        idempotencyKey: resolutionIdempotencyKey(claim.id, stored.revision),
      },
    ],
    [{ blobId: stored.blobId, namespace: NS.resolution }],
  );
  const score = await attachRepairScore(claim, source, context, existing.outcome, stored.outcome);
  const linked = existing.walrusBlobId === stored.blobId;
  if (matches && linked && !score.plan && !score.writtenBlob) {
    return skippedReport(context, stored.outcome, stored.reason, source.score, "already resolved");
  }
  const before = computeScore(source.hits, source.misses);
  const committed = await commitVerdict({
    claimId: claim.id,
    sourceId: source.id,
    existing: true,
    supersede: false,
    relink: true,
    outcome: stored.outcome,
    reason: stored.reason,
    evidence: evidenceFromStored(stored),
    resolvedAt: storedResolvedAt(stored, existing.resolvedAt ?? now),
    resolutionBlob: stored.blobId,
    score: score.plan && score.stampVersion === null ? scoreCommit(claim.id, score.plan, score.writtenBlob) : null,
    stampScore:
      score.stampVersion !== null && score.writtenBlob ? { version: score.stampVersion, blobId: score.writtenBlob } : null,
    fallbackScore: before.score,
  });
  return {
    ...context,
    outcome: stored.outcome,
    reason: stored.reason,
    scoreBefore: before.score,
    scoreAfter: committed.scoreAfter,
    blobs: {
      resolution: stored.blobId,
      ...(score.writtenBlob ? { score: score.writtenBlob } : {}),
    },
    skipped: verdictChanged
      ? "projected stored resolution; recorded verdict differed"
      : matches
        ? "repaired resolution link"
        : "stored resolution matches",
  };
}

interface ScorePlan {
  write?: MemoryWrite;
  adopted?: StoredScore;
  snapshot: ScoreSnapshot;
  version: number;
  reason: string;
}

interface ScoreCommit {
  version: number;
  hits: number;
  misses: number;
  score: number;
  hitRate: number;
  band: ScoreSnapshot["band"];
  reason: string;
  blobId: string | null;
}

function scoreCommit(_claimId: string, plan: ScorePlan, blobId: string | null): ScoreCommit {
  if (plan.adopted) return scoreCommitFromStored(plan.adopted);
  return {
    version: plan.version,
    hits: plan.snapshot.hits,
    misses: plan.snapshot.misses,
    score: plan.snapshot.score,
    hitRate: plan.snapshot.hitRate,
    band: plan.snapshot.band,
    reason: plan.reason,
    blobId,
  };
}

function scoreCommitFromStored(stored: StoredScore): ScoreCommit {
  const snap = computeScore(stored.hits, stored.misses);
  return {
    version: stored.version,
    hits: snap.hits,
    misses: snap.misses,
    score: snap.score,
    hitRate: snap.hitRate,
    band: snap.band,
    reason: stored.reason,
    blobId: stored.blobId,
  };
}

async function recallHits(query: string, namespace: (typeof NS)[keyof typeof NS]): Promise<RecallHit[]> {
  return recallMemory({ query, namespace, limit: 20, sort: "relevance" });
}

/**
 * A relevance recall can surface revision 1 while revision 2 is the row.
 * An older hit is not the recorded verdict. Retry the blob the row names.
 * If that blob is missing or still older, this throws: no write, no projection change.
 */
async function keepCurrentRevision(
  stored: StoredResolution | null,
  revision: number,
  blobId: string | null,
  claim: { id: string; handle: string; quote: string },
  context: ClaimLogContext,
): Promise<StoredResolution | null> {
  if (!stored) return null;
  if (stored.revision >= revision) return stored;
  const pinned = blobId ? await recallResolution(claim, blobId, true) : null;
  if (pinned && pinned.revision >= revision) return pinned;
  throw olderRevisionError(context, revision, pinned?.revision ?? stored.revision);
}

function olderRevisionError(context: ClaimLogContext, recorded: number, recalled: number): Error {
  return new Error(
    `${context.handle} ${context.claimId}${externalSuffix(context)}: recall returned revision ${recalled}, which is older than recorded revision ${recorded}. The recorded verdict was left in place.`,
  );
}

function recallTexts(hits: readonly RecallHit[]) {
  return hits.map((hit) => ({
    blobId: hit.blobId,
    text: hit.text,
    ...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
  }));
}

async function recallResolution(
  claim: { id: string; handle: string; quote: string },
  loggedBlob: string | null,
  thorough = false,
): Promise<StoredResolution | null> {
  // One recall is enough when nothing is logged yet. A logged blob, or a 409,
  // means the memory exists and a single embedding miss must not hide it.
  const queries = loggedBlob || thorough
    ? [resolutionRecallQuery(claim), claim.id, claim.quote.replace(/\s+/g, " ").trim().slice(0, 200)]
    : [resolutionRecallQuery(claim)];
  const seen = new Map<string, { blobId: string; text: string; createdAt?: string }>();
  for (const query of queries) {
    for (const hit of recallTexts(await recallHits(query, NS.resolution))) {
      seen.set(hit.blobId, hit);
    }
    const found = loggedBlob
      ? selectStoredResolutionForBlob(claim.id, loggedBlob, [...seen.values()])
      : selectStoredResolution(claim.id, [...seen.values()]);
    if (found) return found;
  }
  return null;
}

async function recallScore(sourceId: string, handle: string, claimId: string): Promise<StoredScore | null> {
  const hits = recallTexts(await recallHits(scoreRecallQuery({ id: claimId, handle }), NS.score));
  return selectStoredScore(claimId, sourceId, hits);
}

async function logStoredScore(stored: StoredScore): Promise<void> {
  await logMemories(
    [
      {
        text: stored.text,
        namespace: NS.score,
        idempotencyKey: scoreIdempotencyKey(stored.sourceId, stored.version),
      },
    ],
    [{ blobId: stored.blobId, namespace: NS.score }],
  );
}

async function latestScore(sourceId: string): Promise<{ version: number; score: number } | null> {
  const [last] = await getDb()
    .select({ version: schema.scoreVersions.version, score: schema.scoreVersions.score })
    .from(schema.scoreVersions)
    .where(eq(schema.scoreVersions.sourceId, sourceId))
    .orderBy(desc(schema.scoreVersions.version))
    .limit(1);
  return last ?? null;
}

async function categoryMemory(
  sourceId: string,
  pending: { claimId: string; claimType: string; outcome: Outcome },
): Promise<ScoreMemoryCategories | null> {
  const rows = await getDb()
    .select({
      claimId: schema.resolutions.claimId,
      claimType: schema.claims.claimType,
      outcome: schema.resolutions.outcome,
      resolvedAt: schema.resolutions.resolvedAt,
    })
    .from(schema.resolutions)
    .innerJoin(schema.claims, eq(schema.claims.id, schema.resolutions.claimId))
    .where(eq(schema.claims.sourceId, sourceId));
  const counts = tallyCategories(rows, pending);
  if (!counts) return null;
  const folded = foldCategories(counts, 0, 0);
  return { reporting: folded.reporting, forecast: folded.forecast, muteBasis: folded.muteBasis };
}

async function scoreForVerdict(
  source: { id: string; handle: string },
  claimId: string,
  outcome: Outcome,
  before: ScoreSnapshot,
  after: ScoreSnapshot,
  claimType?: string,
): Promise<ScorePlan | null> {
  if (after.hits === before.hits && after.misses === before.misses) return null;
  const stored = await recallScore(source.id, source.handle, claimId);
  const last = await latestScore(source.id);
  if (stored && stored.version > (last?.version ?? 0)) {
    await logStoredScore(stored);
    const snap = computeScore(stored.hits, stored.misses);
    return { adopted: stored, snapshot: snap, version: stored.version, reason: stored.reason };
  }
  const version = (last?.version ?? 0) + 1;
  const reason = `claim resolved ${outcome}`;
  const categories = claimType ? await categoryMemory(source.id, { claimId, claimType, outcome }) : null;
  const built = scoreMemory(
    {
      sourceId: source.id,
      sourceHandle: source.handle,
      version,
      triggeredByClaimId: claimId,
      reason,
    },
    after,
    last?.score ?? null,
    categories,
  );
  const known = await findPersistedKeys([{ idempotencyKey: built.key }]);
  if (known.has(built.key)) {
    const again = await recallScore(source.id, source.handle, claimId);
    if (!again || again.version !== version) {
      throw new Error(
        `${source.handle} ${claimId}: score ${built.key} is logged but recall could not read that version. Claim left pending.`,
      );
    }
    await logStoredScore(again);
    const snap = computeScore(again.hits, again.misses);
    return { adopted: again, snapshot: snap, version: again.version, reason: again.reason };
  }
  return {
    write: { text: built.text, namespace: NS.score, idempotencyKey: built.key },
    snapshot: after,
    version,
    reason,
  };
}

async function writeOne(write: MemoryWrite): Promise<{ blobId: string }> {
  let blobId = "";
  const { error, cause } = await writeMemoriesDurable([write], async (item, result) => {
    await logMemories([item], [{ id: result.id, blobId: result.blobId, namespace: item.namespace }]);
    blobId = result.blobId;
  });
  if (error) throw new Error(error, cause ? { cause } : undefined);
  if (!blobId) throw new Error(`write ${write.idempotencyKey} returned no blob id`);
  return { blobId };
}

function evidenceFromStored(stored: StoredResolution): Record<string, unknown> {
  return { ...stored.evidence, revision: stored.revision };
}

function storedResolvedAt(stored: StoredResolution, now: Date): Date {
  const raw = stored.resolvedAt ?? stored.createdAt;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return now;
}

async function adoptStored(
  claim: { id: string; claimType: string },
  source: { id: string; handle: string; hits: number; misses: number; score: number },
  context: ClaimLogContext,
  stored: StoredResolution,
  now: Date,
  disagreed = false,
): Promise<ResolveReport> {
  const key = resolutionIdempotencyKey(claim.id, stored.revision);
  await logMemories(
    [{ text: stored.text, namespace: NS.resolution, idempotencyKey: key }],
    [{ blobId: stored.blobId, namespace: NS.resolution }],
  );

  const before = computeScore(source.hits, source.misses);
  const after = replaceOutcome(source.hits, source.misses, null, stored.outcome);
  let score = await scoreForVerdict(source, claim.id, stored.outcome, before, after, claim.claimType);
  let writtenBlob: string | null = null;
  if (score?.write) {
    try {
      writtenBlob = (await writeOne(score.write)).blobId;
    } catch (err) {
      if (!isIdempotencyConflict(err)) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${context.handle} ${claim.id}${externalSuffix(context)}: failed to persist the score while adopting the stored resolution: ${message}`,
          { cause: err },
        );
      }
      const adopted = await recallScore(source.id, source.handle, claim.id);
      if (!adopted) {
        throw new Error(
          `${context.handle} ${claim.id}${externalSuffix(context)}: score was already used with different content, and recall could not read it. Claim left pending.`,
          { cause: err },
        );
      }
      if (score?.write) {
        assertScoreMatches(context, score.write.idempotencyKey, adopted, {
          sourceId: source.id,
          version: score.version,
          hits: score.snapshot.hits,
          misses: score.snapshot.misses,
          triggeredByClaimId: claim.id,
        });
      }
      await logStoredScore(adopted);
      score = {
        adopted,
        snapshot: computeScore(adopted.hits, adopted.misses),
        version: adopted.version,
        reason: adopted.reason,
      };
    }
  }

  return finishAdopt(claim, source, context, stored, now, before, score, writtenBlob, disagreed);
}

async function finishAdopt(
  claim: { id: string },
  source: { id: string; score: number },
  context: ClaimLogContext,
  stored: StoredResolution,
  now: Date,
  before: ScoreSnapshot,
  score: ScorePlan | null,
  writtenBlob: string | null,
  disagreed = false,
): Promise<ResolveReport> {
  const committed = await commitVerdict({
    claimId: claim.id,
    sourceId: source.id,
    existing: false,
    supersede: false,
    outcome: stored.outcome,
    reason: stored.reason,
    evidence: evidenceFromStored(stored),
    resolvedAt: storedResolvedAt(stored, now),
    resolutionBlob: stored.blobId,
    score: score ? scoreCommit(claim.id, score, writtenBlob ?? score.adopted?.blobId ?? null) : null,
    fallbackScore: before.score,
  });
  if (committed.skipped) {
    return skippedReport(context, committed.outcome, committed.reason, source.score, "already resolved");
  }
  return {
    ...context,
    outcome: stored.outcome,
    reason: stored.reason,
    scoreBefore: before.score,
    scoreAfter: committed.scoreAfter,
    blobs: {
      resolution: stored.blobId,
      ...(committed.scoreBlob ? { score: committed.scoreBlob } : {}),
    },
    skipped: disagreed ? "projected stored resolution; adjudicated verdict differed" : "adopted stored resolution",
  };
}

interface CommitInput {
  claimId: string;
  sourceId: string;
  existing: boolean;
  supersede: boolean;
  outcome: Outcome;
  reason: string;
  evidence: Record<string, unknown>;
  resolvedAt: Date;
  resolutionBlob: string | null;
  score: ScoreCommit | null;
  /** Score to report when this verdict does not write a score version. */
  fallbackScore: number;
  /**
   * The resolution row is already there. Update it to this verdict and blob
   * instead of treating the row as "done" and returning.
   */
  relink?: boolean;
  /** Stamp a score version that already exists. Does not insert another. */
  stampScore?: { version: number; blobId: string } | null;
}

interface CommitResult {
  skipped: boolean;
  outcome: Outcome;
  reason: string;
  scoreAfter: number;
  resolutionBlob: string | null;
  scoreBlob?: string;
}

async function commitVerdict(input: CommitInput): Promise<CommitResult> {
  const db = getDb();
  const skipped: Array<{ outcome: Outcome; reason: string } | null> = [null];
  await db.transaction(async (tx) => {
    await tx
      .select({ id: schema.claims.id })
      .from(schema.claims)
      .where(eq(schema.claims.id, input.claimId))
      .for("update");
    const [already] = await tx
      .select()
      .from(schema.resolutions)
      .where(eq(schema.resolutions.claimId, input.claimId))
      .limit(1);
    if (already && !input.supersede && !input.relink) {
      skipped[0] = { outcome: already.outcome, reason: already.reason };
      return;
    }
    const values = {
      outcome: input.outcome,
      evidence: input.evidence,
      reason: input.reason,
      resolvedAt: input.relink ? already?.resolvedAt ?? input.resolvedAt : input.resolvedAt,
      walrusBlobId: input.resolutionBlob,
    };
    if (already) {
      await tx.update(schema.resolutions).set(values).where(eq(schema.resolutions.claimId, input.claimId));
    } else {
      await tx.insert(schema.resolutions).values({ claimId: input.claimId, ...values });
    }
    await tx
      .update(schema.claims)
      .set({ status: input.outcome === "void" ? "void" : "resolved" })
      .where(eq(schema.claims.id, input.claimId));
    if (input.stampScore) {
      await tx
        .update(schema.scoreVersions)
        .set({ walrusBlobId: input.stampScore.blobId })
        .where(
          and(
            eq(schema.scoreVersions.sourceId, input.sourceId),
            eq(schema.scoreVersions.version, input.stampScore.version),
          ),
        );
    }
    if (input.score && !input.stampScore) {
      await tx.insert(schema.scoreVersions).values({
        sourceId: input.sourceId,
        version: input.score.version,
        hits: input.score.hits,
        misses: input.score.misses,
        score: input.score.score,
        hitRate: input.score.hitRate,
        triggeredByClaimId: input.claimId,
        reason: input.score.reason,
        walrusBlobId: input.score.blobId,
      });
      const categoryRows = await tx
        .select({
          claimId: schema.resolutions.claimId,
          claimType: schema.claims.claimType,
          outcome: schema.resolutions.outcome,
          resolvedAt: schema.resolutions.resolvedAt,
        })
        .from(schema.resolutions)
        .innerJoin(schema.claims, eq(schema.claims.id, schema.resolutions.claimId))
        .where(eq(schema.claims.sourceId, input.sourceId));
      const counts = tallyCategories(categoryRows);
      const folded = counts ? foldCategories(counts, input.score.hits, input.score.misses) : null;
      await tx
        .update(schema.sources)
        .set({
          hits: input.score.hits,
          misses: input.score.misses,
          score: input.score.score,
          muted: folded ? folded.muted : input.score.band === "muted",
          ...(folded
            ? {
                reportingHits: counts!.reportingHits,
                reportingMisses: counts!.reportingMisses,
                forecastHits: counts!.forecastHits,
                forecastMisses: counts!.forecastMisses,
              }
            : {}),
        })
        .where(eq(schema.sources.id, input.sourceId));
    }
  });
  const existing = skipped[0];
  if (existing) {
    return {
      skipped: true,
      outcome: existing.outcome,
      reason: existing.reason,
      scoreAfter: input.fallbackScore,
      resolutionBlob: input.resolutionBlob,
    };
  }
  return {
    skipped: false,
    outcome: input.outcome,
    reason: input.reason,
    scoreAfter: input.score?.score ?? input.fallbackScore,
    resolutionBlob: input.resolutionBlob,
    ...(input.score?.blobId ? { scoreBlob: input.score.blobId } : {}),
  };
}
