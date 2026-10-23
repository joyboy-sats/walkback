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

import { and, desc, eq, lte } from "drizzle-orm";
import { adjudicate } from "./adjudicate";
import { isIdempotencyConflict } from "./bounded";
import { getDb, schema } from "./db";
import { exclusionVerdict } from "./scoring-exclusion";
import { pendingWrites } from "./durable-writes";
import { findPersistedKeys } from "./persisted-keys";
import { recallMemory, writeMemoriesDurable, type MemoryWrite, type RecallHit } from "./memwal";
import { logMemories } from "./memory-log";
import { claimMemory, resolutionMemory, scoreMemory } from "./memory-text";
import { computeScore, replaceOutcome, type ScoreSnapshot } from "./score";
import {
  resolutionIdempotencyKey,
  resolutionRecallQuery,
  scoreIdempotencyKey,
  scoreRecallQuery,
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
    return skippedReport(context, existing.outcome, existing.reason, source.score, "already resolved");
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

  const scorePlan = await scoreForVerdict(source, claim.id, verdict.outcome, before, after);
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
    return adoptStored(claim, source, context, stored, now);
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
      return adoptStored(claim, source, context, stored, now);
    }
    if (conflict && scorePlan?.write && blobs.has(resolutionText.key)) {
      const adopted = await recallScore(source.id, source.handle, claim.id);
      if (!adopted) {
        throw new Error(
          `${context.handle} ${claim.id}${externalSuffix(context)}: ${scorePlan.write.idempotencyKey} was already used with different content, and recall could not read it. Claim left pending. ${error}`,
          cause ? { cause } : undefined,
        );
      }
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
  try {
    return await recallMemory({ query, namespace, limit: 20, sort: "relevance" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[resolve] recall ${namespace} failed: ${message}`);
    return [];
  }
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

async function scoreForVerdict(
  source: { id: string; handle: string },
  claimId: string,
  outcome: Outcome,
  before: ScoreSnapshot,
  after: ScoreSnapshot,
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
  claim: { id: string },
  source: { id: string; handle: string; hits: number; misses: number; score: number },
  context: ClaimLogContext,
  stored: StoredResolution,
  now: Date,
): Promise<ResolveReport> {
  const key = resolutionIdempotencyKey(claim.id, stored.revision);
  await logMemories(
    [{ text: stored.text, namespace: NS.resolution, idempotencyKey: key }],
    [{ blobId: stored.blobId, namespace: NS.resolution }],
  );

  const before = computeScore(source.hits, source.misses);
  const after = replaceOutcome(source.hits, source.misses, null, stored.outcome);
  let score = await scoreForVerdict(source, claim.id, stored.outcome, before, after);
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
      await logStoredScore(adopted);
      score = {
        adopted,
        snapshot: computeScore(adopted.hits, adopted.misses),
        version: adopted.version,
        reason: adopted.reason,
      };
    }
  }

  return finishAdopt(claim, source, context, stored, now, before, score, writtenBlob);
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
    skipped: "adopted stored resolution",
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
    if (already && !input.supersede) {
      skipped[0] = { outcome: already.outcome, reason: already.reason };
      return;
    }
    const values = {
      outcome: input.outcome,
      evidence: input.evidence,
      reason: input.reason,
      resolvedAt: input.resolvedAt,
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
    if (input.score) {
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
      await tx
        .update(schema.sources)
        .set({
          hits: input.score.hits,
          misses: input.score.misses,
          score: input.score.score,
          muted: input.score.band === "muted",
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
