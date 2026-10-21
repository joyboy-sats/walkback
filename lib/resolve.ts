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
import { getDb, schema } from "./db";
import { exclusionVerdict } from "./scoring-exclusion";
import { pendingWrites } from "./durable-writes";
import { findPersistedKeys } from "./persisted-keys";
import { writeMemoriesDurable, type MemoryWrite } from "./memwal";
import { logMemories } from "./memory-log";
import { claimMemory, resolutionMemory, scoreMemory } from "./memory-text";
import { applyOutcome, computeScore, type ScoreSnapshot } from "./score";
import { NS } from "./types";
import type { ClaimParams, ClaimType, BalanceSnapshot } from "./types";

export interface ResolveReport {
  claimId: string;
  outcome: "true" | "false" | "void";
  reason: string;
  scoreBefore: number;
  scoreAfter: number;
  blobs: { resolution?: string; score?: string };
  skipped?: string;
}

export interface ResolveHooks {
  onList?: (ids: readonly string[]) => void;
  onClaimStart?: (claimId: string) => void;
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

/**
 * Resolve one claim and fold the result into the source's trust.
 *
 * Idempotent by construction: a claim that is already resolved returns its
 * existing verdict without writing anything. Idempotency keys are derived from
 * the claim id, so even a concurrent double-call collapses at the relayer.
 */
export async function resolveClaim(claimId: string, now = new Date()): Promise<ResolveReport> {
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

  const [existing] = await db
    .select()
    .from(schema.resolutions)
    .where(eq(schema.resolutions.claimId, claimId))
    .limit(1);

  if (existing) {
    return {
      claimId,
      outcome: existing.outcome,
      reason: existing.reason,
      scoreBefore: source.score,
      scoreAfter: source.score,
      blobs: {},
      skipped: "already resolved",
    };
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
      },
      now,
    ));

  // A void never moves the score, so it does not produce a score version.
  const before = computeScore(source.hits, source.misses);
  const after = applyOutcome(source.hits, source.misses, verdict.outcome);

  const writes: MemoryWrite[] = [];

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
  );
  writes.push({
    text: resolutionText.text,
    namespace: NS.resolution,
    idempotencyKey: resolutionText.key,
  });

  let scoreText: { text: string; key: string } | null = null;
  let nextVersion = 0;
  if (after.adjudicated !== before.adjudicated) {
    const [last] = await db
      .select({ version: schema.scoreVersions.version, score: schema.scoreVersions.score })
      .from(schema.scoreVersions)
      .where(eq(schema.scoreVersions.sourceId, source.id))
      .orderBy(desc(schema.scoreVersions.version))
      .limit(1);

    nextVersion = (last?.version ?? 0) + 1;
    scoreText = scoreMemory(
      {
        sourceId: source.id,
        sourceHandle: source.handle,
        version: nextVersion,
        triggeredByClaimId: claim.id,
        reason: `claim resolved ${verdict.outcome}`,
      },
      after,
      last?.score ?? null,
    );
    writes.push({
      text: scoreText.text,
      namespace: NS.score,
      idempotencyKey: scoreText.key,
    });
  }

  const known = await findPersistedKeys(writes);
  const pending = pendingWrites(writes, known);
  const blobs = new Map<string, string>();
  const { error, cause } = await writeMemoriesDurable(pending, async (write, result) => {
    await logMemories([write], [{ id: result.id, blobId: result.blobId, namespace: write.namespace }]);
    blobs.set(write.idempotencyKey, result.blobId);
  });
  if (error) {
    throw new Error(
      `failed to persist a memory for claim ${claim.id} after ${blobs.size} new blob(s): ${error}`,
      cause ? { cause } : undefined,
    );
  }

  const resolutionBlob = blobs.get(resolutionText.key) ?? (await blobForKey(resolutionText.key));
  const scoreBlob = scoreText ? (blobs.get(scoreText.key) ?? (await blobForKey(scoreText.key))) : undefined;

  await db.insert(schema.resolutions).values({
    claimId: claim.id,
    outcome: verdict.outcome,
    evidence: verdict.evidence as Record<string, unknown>,
    reason: verdict.reason,
    walrusBlobId: resolutionBlob ?? null,
  });

  await db
    .update(schema.claims)
    .set({
      status: verdict.outcome === "void" ? "void" : "resolved",
    })
    .where(eq(schema.claims.id, claim.id));

  if (scoreText) {
    await db.insert(schema.scoreVersions).values({
      sourceId: source.id,
      version: nextVersion,
      hits: after.hits,
      misses: after.misses,
      score: after.score,
      hitRate: after.hitRate,
      triggeredByClaimId: claim.id,
      reason: `claim resolved ${verdict.outcome}`,
      walrusBlobId: scoreBlob ?? null,
    });

    await db
      .update(schema.sources)
      .set({
        hits: after.hits,
        misses: after.misses,
        score: after.score,
        muted: after.band === "muted",
      })
      .where(eq(schema.sources.id, source.id));
  }

  return {
    claimId,
    outcome: verdict.outcome,
    reason: verdict.reason,
    scoreBefore: before.score,
    scoreAfter: after.score,
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
): Promise<ResolveBatch> {
  const reports: ResolveReport[] = [];
  const errors: Array<{ claimId: string; error: string }> = [];

  for (const id of ids) {
    const started = Date.now();
    hooks?.onClaimStart?.(id);
    try {
      const report = await resolveClaim(id, now);
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

async function blobForKey(key: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ blobId: schema.memoryLog.blobId })
    .from(schema.memoryLog)
    .where(eq(schema.memoryLog.idempotencyKey, key))
    .limit(1);
  return row?.blobId ?? null;
}
