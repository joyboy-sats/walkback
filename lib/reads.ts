/**
 * Read models for the Coolify API. Selects only. Walrus writes happen in the worker.
 */
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { buildLedger, type LedgerView } from "./ledger";
import { LIST_ENUMERATION_NOTE } from "./projection-rebuild";
import { sourceIsMuted } from "./score";
import { explainVoidReason } from "./verdict-reason";

export interface FeedResolution {
  outcome: "true" | "false" | "void";
  /** Sentence safe to show. Provider errors are rewritten once. */
  reason: string;
}

/** Latest row wins. A re-resolve updates the row; this still prefers the newest if more than one exists. */
export function latestResolution<T extends { claimId: string; resolvedAt: Date }>(
  rows: readonly T[],
): Map<string, T> {
  const byClaim = new Map<string, T>();
  for (const row of rows) {
    const prev = byClaim.get(row.claimId);
    if (!prev || row.resolvedAt.getTime() >= prev.resolvedAt.getTime()) byClaim.set(row.claimId, row);
  }
  return byClaim;
}

export function feedResolution(row: {
  outcome: "true" | "false" | "void";
  reason: string;
}): FeedResolution {
  return { outcome: row.outcome, reason: explainVoidReason(row.reason) };
}

export async function readFeed() {
  const db = getDb();
  const rows = await db
    .select({
      claim: schema.claims,
      source: schema.sources,
    })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .orderBy(desc(schema.sources.score), desc(schema.claims.deadline))
    .limit(100);

  const claimIds = rows.map(({ claim }) => claim.id);
  const resolutionRows =
    claimIds.length === 0
      ? []
      : await db
          .select({
            claimId: schema.resolutions.claimId,
            outcome: schema.resolutions.outcome,
            reason: schema.resolutions.reason,
            resolvedAt: schema.resolutions.resolvedAt,
          })
          .from(schema.resolutions)
          .where(inArray(schema.resolutions.claimId, claimIds));
  const resolutions = latestResolution(resolutionRows);

  return rows.map(({ claim, source }) => {
    const resolution = resolutions.get(claim.id);
    return {
    claim: {
      id: claim.id,
      quote: claim.quote,
      claimType: claim.claimType,
      status: claim.status,
      deadline: claim.deadline.toISOString(),
      synthetic: claim.synthetic,
      sourceUrl: claim.sourceUrl,
      walrusBlobId: claim.walrusBlobId,
      resolution: resolution ? feedResolution(resolution) : null,
    },
    source: {
      id: source.id,
      handle: source.handle,
      score: source.score,
      hits: source.hits,
      misses: source.misses,
      muted: sourceIsMuted(source.muted, source.hits + source.misses),
    },
    };
  });
}

/** Every source, plus ledger totals. Not capped the way {@link readFeed} is. */
export async function readLedger(): Promise<LedgerView> {
  const db = getDb();
  const [sourceRows, claimRows, memoryRows, verifyRows] = await Promise.all([
    db
      .select({
        id: schema.sources.id,
        handle: schema.sources.handle,
        score: schema.sources.score,
        hits: schema.sources.hits,
        misses: schema.sources.misses,
        storedMuted: schema.sources.muted,
      })
      .from(schema.sources),
    db
      .select({
        sourceId: schema.claims.sourceId,
        claimType: schema.claims.claimType,
        status: schema.claims.status,
      })
      .from(schema.claims),
    db.select({ value: count() }).from(schema.memoryLog),
    db
      .select({ result: schema.ingestJobs.result })
      .from(schema.ingestJobs)
      .where(and(eq(schema.ingestJobs.kind, "rebuild"), eq(schema.ingestJobs.status, "done")))
      .orderBy(desc(schema.ingestJobs.finishedAt), desc(schema.ingestJobs.createdAt))
      .limit(1),
  ]);

  return buildLedger({
    sources: sourceRows,
    claims: claimRows,
    memoryInventory: memoryRows[0]?.value ?? 0,
    latestVerifyResult: verifyRows[0]?.result ?? null,
  });
}

export async function readSource(id: string) {
  const db = getDb();
  const [source] = await db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1);
  if (!source) return null;

  const versions = await db
    .select()
    .from(schema.scoreVersions)
    .where(eq(schema.scoreVersions.sourceId, id))
    .orderBy(asc(schema.scoreVersions.version));

  const claims = await db
    .select({
      claim: schema.claims,
      resolution: schema.resolutions,
    })
    .from(schema.claims)
    .leftJoin(schema.resolutions, eq(schema.resolutions.claimId, schema.claims.id))
    .where(eq(schema.claims.sourceId, id))
    .orderBy(desc(schema.claims.deadline))
    .limit(50);

  return {
    source: {
      id: source.id,
      handle: source.handle,
      score: source.score,
      hits: source.hits,
      misses: source.misses,
    },
    versions: versions.map((v) => ({ version: v.version, score: v.score })),
    claims: claims.map(({ claim, resolution }) => ({
      claim: {
        id: claim.id,
        quote: claim.quote,
        claimType: claim.claimType,
        status: claim.status,
        deadline: claim.deadline.toISOString(),
        synthetic: claim.synthetic,
        sourceUrl: claim.sourceUrl,
        walrusBlobId: claim.walrusBlobId,
      },
      resolution: resolution
        ? {
            outcome: resolution.outcome,
            reason: explainVoidReason(resolution.reason),
            evidence: resolution.evidence,
            walrusBlobId: resolution.walrusBlobId,
          }
        : null,
    })),
  };
}

export async function claimsForSourceUrls(urls: readonly string[]) {
  if (urls.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: schema.claims.id,
      sourceUrl: schema.claims.sourceUrl,
      status: schema.claims.status,
    })
    .from(schema.claims)
    .where(inArray(schema.claims.sourceUrl, [...urls]));
}

export async function readMemory() {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.memoryLog)
    .orderBy(desc(schema.memoryLog.writtenAt))
    .limit(200);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      namespace: r.namespace,
      blobId: r.blobId,
      textPreview: r.textPreview,
    })),
    limitation: LIST_ENUMERATION_NOTE,
  };
}
