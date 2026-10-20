/**
 * Run the seed file through ingest.
 *
 * Real posts are read, extracted (or taken from an explicit `claims` array)
 * and written with `writeMemoriesBulk`. A post whose external id is already
 * in the projection is skipped, so a second run does not append a second
 * copy. Bulk writes cannot carry an idempotency key — `RememberBulkItem` has
 * `text` and `namespace` only — so the skip is what keeps the ledger stable.
 * The keys are still derived from the post id and passed on every write the
 * single-memory path knows how to dedupe.
 *
 * `memwalWriteLimiter` sits inside `writeMemoriesBulk`. This module does not
 * talk to the SDK.
 */
import "server-only";

import { getDb, schema, closeDb } from "./db";
import { ingest, persistIngestWrites } from "./ingest";
import { BULK_MAX, type MemoryWrite } from "./memwal";
import { resolveDueClaims } from "./resolve";
import {
  chunk,
  formatSeedSummary,
  isSynthetic,
  materializeClaims,
  parseClaimsFile,
  postsToApply,
  type SeedSummaryInput,
} from "./seed-plan";

export async function runSeed(raw: unknown): Promise<string> {
  const file = parseClaimsFile(raw);
  const db = getDb();

  const existing = await db
    .select({ externalId: schema.claims.externalId })
    .from(schema.claims);
  const existingIds = existing
    .map((r) => r.externalId)
    .filter((id): id is string => Boolean(id));

  const { apply, skip } = postsToApply(file.posts, existingIds);

  const pending: MemoryWrite[] = [];
  const sourced = new Set<string>();

  for (const post of apply) {
    const claims = materializeClaims(post);
    const includeSourceMemory = !sourced.has(post.handle);
    sourced.add(post.handle);

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
      includeSourceMemory,
    });

    if (result.pendingWrites) pending.push(...result.pendingWrites);
  }

  // Grouping is writeMemoriesBulk's rule (one namespace per call). Chunking
  // at BULK_MAX is the relayer's rule (20 items). The helper chunks again;
  // doing it here keeps a seed run from ever handing it more than that.
  const byNamespace = new Map<string, MemoryWrite[]>();
  for (const write of pending) {
    const list = byNamespace.get(write.namespace) ?? [];
    list.push(write);
    byNamespace.set(write.namespace, list);
  }
  for (const group of byNamespace.values()) {
    for (const batch of chunk(group, BULK_MAX)) {
      await persistIngestWrites(batch);
    }
  }

  const resolved = await resolveDueClaims(new Date(), 200);

  const summary = await readSummary({
    postsRead: file.posts.length,
    postsSeeded: apply.length,
    postsSkipped: skip.length,
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
    db.select({ handle: schema.sources.handle, score: schema.sources.score, hits: schema.sources.hits, misses: schema.sources.misses }).from(schema.sources),
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
