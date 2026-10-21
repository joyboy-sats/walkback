/**
 * Read models for the Coolify API. Selects only. Walrus writes happen in the worker.
 */
import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { LIST_ENUMERATION_NOTE } from "./projection-rebuild";
import { sourceIsMuted } from "./score";

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

  return rows.map(({ claim, source }) => ({
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
    source: {
      id: source.id,
      handle: source.handle,
      score: source.score,
      hits: source.hits,
      misses: source.misses,
      muted: sourceIsMuted(source.muted, source.hits + source.misses),
    },
  }));
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
            reason: resolution.reason,
            evidence: resolution.evidence,
            walrusBlobId: resolution.walrusBlobId,
          }
        : null,
    })),
  };
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
