/**
 * Run the seed file through ingest.
 *
 * Each post is planned from the applied marker, the claim blob ids, and
 * whether the source memory is already logged. A partial run inserts the
 * missing claims and writes only the memories that are not persisted. The
 * marker is set after those writes succeed.
 *
 * Writes go through `persistIngestWrites`, which uses `rememberAndWait` and
 * an idempotency key, one item at a time. Bulk items cannot carry that key.
 */
import "server-only";

import { getDb, schema, closeDb } from "./db";
import { ingest, markSeedPostApplied, persistIngestWrites } from "./ingest";
import { resolveDueClaims } from "./resolve";
import {
  formatSeedSummary,
  isSynthetic,
  materializeClaims,
  parseClaimsFile,
  type SeedSummaryInput,
} from "./seed-plan";

export async function runSeed(raw: unknown): Promise<string> {
  const file = parseClaimsFile(raw);
  let postsSeeded = 0;
  let postsSkipped = 0;

  for (const post of file.posts) {
    const claims = materializeClaims(post);
    const result = await ingest({
      handle: post.handle,
      platform: post.platform,
      text: post.text,
      publishedAt: post.published_at,
      ...(post.sui_address ? { suiAddress: post.sui_address } : {}),
      ...(claims ? { claims } : {}),
      ...("snapshot" in post ? { recordedSnapshot: post.snapshot ?? null } : {}),
      synthetic: isSynthetic(post),
      externalId: post.id,
      deferMemories: true,
      includeSourceMemory: true,
    });

    if (result.pendingWrites?.length) await persistIngestWrites(result.pendingWrites);
    if (result.needsMarker) await markSeedPostApplied(post.id, result.sourceId);
    if (result.skipped && !result.needsMarker) postsSkipped++;
    else postsSeeded++;
  }

  const resolved = await resolveDueClaims(new Date(), 200);

  const summary = await readSummary({
    postsRead: file.posts.length,
    postsSeeded,
    postsSkipped,
    realPosts: file.posts.filter((p) => !isSynthetic(p)).length,
    syntheticPosts: file.posts.filter((p) => isSynthetic(p)).length,
    resolveErrors: resolved.errors,
  });

  return formatSeedSummary(summary);
}

async function readSummary(
  head: Omit<SeedSummaryInput, "realClaims" | "syntheticClaims" | "memoriesByNamespace" | "blobIds" | "scores">,
): Promise<SeedSummaryInput> {
  const db = getDb();
  const [memories, sources, claims] = await Promise.all([
    db.select({ namespace: schema.memoryLog.namespace, blobId: schema.memoryLog.blobId }).from(schema.memoryLog),
    db
      .select({
        handle: schema.sources.handle,
        score: schema.sources.score,
        hits: schema.sources.hits,
        misses: schema.sources.misses,
      })
      .from(schema.sources),
    db.select({ synthetic: schema.claims.synthetic }).from(schema.claims),
  ]);

  const memoriesByNamespace: Record<string, number> = {};
  for (const row of memories) {
    memoriesByNamespace[row.namespace] = (memoriesByNamespace[row.namespace] ?? 0) + 1;
  }

  return {
    ...head,
    realClaims: claims.filter((c) => !c.synthetic).length,
    syntheticClaims: claims.filter((c) => c.synthetic).length,
    memoriesByNamespace,
    blobIds: memories.map((m) => m.blobId),
    scores: sources
      .map((s) => ({ handle: s.handle, score: s.score, hits: s.hits, misses: s.misses }))
      .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle)),
  };
}

export async function finishSeed(): Promise<void> {
  await closeDb();
}
