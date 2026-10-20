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
import { writeMemoriesBulk, type MemoryWrite } from "./memwal";
import { logMemories } from "./memory-log";
import { claimMemory, resolutionMemory, scoreMemory } from "./memory-text";
import { computeScore, type ScoreSnapshot } from "./score";
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

  const verdict = await adjudicate(
    {
      claimType: claim.claimType as ClaimType,
      params: claim.params as unknown as ClaimParams,
      snapshot,
      deadline: claim.deadline.toISOString(),
    },
    now,
  );

  // A void never moves the score, so it does not produce a score version.
  const before = computeScore(source.hits, source.misses);
  const after =
    verdict.outcome === "void"
      ? before
      : computeScore(
          source.hits + (verdict.outcome === "true" ? 1 : 0),
          source.misses + (verdict.outcome === "false" ? 1 : 0),
        );

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

  // Bulk even for two items: one round trip, one limiter charge per item.
  // `results` is aligned with `writes`, not compacted on failure.
  const { results } = await writeMemoriesBulk(writes);
  const resolutionBlob = results[0]?.blobId;
  const scoreBlob = scoreText ? results[1]?.blobId : undefined;

  const failures = results.filter((r) => r.error);
  if (failures.length) {
    // Do not update the projection: an unprovable verdict must not become
    // the system's belief. The claim stays pending and can be retried.
    throw new Error(
      `failed to persist ${failures.length} memory record(s) for claim ${claim.id}: ` +
        failures.map((f) => f.error).join("; "),
    );
  }

  await logMemories(writes, results);

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
 * Resolve every claim whose deadline has passed.
 *
 * Intended for a cron or a "Resolve all" button. Returns per-claim reports so
 * the UI can show partial progress rather than one opaque failure.
 */
export async function resolveDueClaims(
  now = new Date(),
  limit = 25,
): Promise<{ reports: ResolveReport[]; errors: Array<{ claimId: string; error: string }> }> {
  const db = getDb();
  const due = await db
    .select({ id: schema.claims.id })
    .from(schema.claims)
    .where(and(eq(schema.claims.status, "pending"), lte(schema.claims.deadline, now)))
    .limit(limit);

  const reports: ResolveReport[] = [];
  const errors: Array<{ claimId: string; error: string }> = [];

  for (const c of due) {
    try {
      reports.push(await resolveClaim(c.id, now));
    } catch (err) {
      errors.push({ claimId: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { reports, errors };
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

  const { results } = await writeMemoriesBulk([
    { text: mem.text, namespace: NS.claim, idempotencyKey: mem.key },
  ]);

  const blobId = results[0]?.blobId;
  if (blobId) {
    await db
      .update(schema.claims)
      .set({ walrusBlobId: blobId })
      .where(eq(schema.claims.id, claimId));
  }
  return blobId;
}
