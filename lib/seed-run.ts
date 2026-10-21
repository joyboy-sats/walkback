/**
 * Run the seed file through ingest.
 *
 * Each post is planned from the applied marker, the claim blob ids, and
 * whether the source memory is already logged. A partial run inserts the
 * missing claims and writes only the memories that are not persisted. The
 * marker is set after those writes succeed. A timed-out write leaves the
 * marker unset, so a rerun sends the same idempotency keys again.
 *
 * Writes go through `persistIngestWrites`, which uses `rememberAndWait` and
 * an idempotency key, one item at a time. Bulk items cannot carry that key.
 * Each write has a deadline and retries inside `writeMemory`.
 */
import "server-only";

import { errorMessage, isDeadlineError } from "./bounded";
import { configureDbPool, getDb, schema, closeDb } from "./db";
import { ingest, markSeedPostApplied, persistIngestWrites } from "./ingest";
import { destroyMemwal } from "./memwal";
import { resolveDueClaims } from "./resolve";
import {
  formatSeedSummary,
  isSynthetic,
  materializeClaims,
  parseClaimsFile,
  type SeedSummaryInput,
} from "./seed-plan";

/** A seed statement is a small insert. 30s is far above that and far below "forever". */
export const SEED_STATEMENT_TIMEOUT_MS = 30_000;
/** Fail a lock wait instead of sitting behind the worker. */
export const SEED_LOCK_TIMEOUT_MS = 10_000;
export const SEED_CONNECT_TIMEOUT_SECONDS = 30;

export interface SeedRunResult {
  summary: string;
  /** False when a post, a resolve, or the summary query failed. */
  ok: boolean;
}

export interface SeedRunOptions {
  log?: (line: string) => void;
  now?: Date;
  resolveLimit?: number;
}

export async function runSeed(raw: unknown, options: SeedRunOptions = {}): Promise<SeedRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  // Before any query. The worker does not call this, so its pool is unchanged.
  configureDbPool({
    statementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: SEED_LOCK_TIMEOUT_MS,
    connectTimeoutSeconds: SEED_CONNECT_TIMEOUT_SECONDS,
  });

  const file = parseClaimsFile(raw);
  let postsSeeded = 0;
  let postsSkipped = 0;
  const failures: Array<{ step: string; error: string }> = [];
  const notAttempted: string[] = [];
  let stopForTimeout = false;

  for (let index = 0; index < file.posts.length; index++) {
    const post = file.posts[index]!;
    const place = `${index + 1}/${file.posts.length}`;
    if (stopForTimeout) {
      notAttempted.push(post.id);
      log(`[seed] post ${place} ${post.id} not attempted`);
      continue;
    }

    log(`[seed] post ${place} ${post.id}`);
    const started = Date.now();
    try {
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
        ...(post.source_url ? { sourceUrl: post.source_url } : {}),
        externalId: post.id,
        deferMemories: true,
        includeSourceMemory: true,
      });

      if (result.pendingWrites?.length) {
        log(`[seed] post ${post.id} writing ${result.pendingWrites.length} memory(s)`);
        await persistIngestWrites(result.pendingWrites, {
          onStart(write) {
            log(`[seed] write start ${write.idempotencyKey} ${write.namespace}`);
          },
          onDone(write, written) {
            log(`[seed] write done ${write.idempotencyKey} blob=${written.blobId} ${written.elapsedMs}ms`);
          },
          onRetry(write, info) {
            log(
              `[seed] write retry ${write.idempotencyKey} attempt ${info.attempt}/${info.attempts} in ${info.delayMs}ms: ${info.error}`,
            );
          },
        });
      } else if (!result.skipped) {
        log(`[seed] post ${post.id} no memories to write`);
      }

      // Marker only after the writes above returned. A throw skips this.
      if (result.needsMarker) {
        await markSeedPostApplied(post.id, result.sourceId);
        log(`[seed] post ${post.id} marker set`);
      }
      if (result.skipped && !result.needsMarker) {
        postsSkipped++;
        log(`[seed] post ${post.id} skipped (${result.skipped}) ${Date.now() - started}ms`);
      } else {
        postsSeeded++;
        log(`[seed] post ${post.id} ingested ${Date.now() - started}ms`);
      }
    } catch (err) {
      const message = errorMessage(err);
      failures.push({ step: post.id, error: message });
      log(`[seed] post ${post.id} failed after ${Date.now() - started}ms: ${message}`);
      if (isDeadlineError(err) || /timed out/i.test(message)) {
        stopForTimeout = true;
        log(`[seed] stopping further posts after a timed-out write; rerun resumes at ${post.id}`);
      }
    }
  }

  const now = options.now ?? new Date();
  const resolveLimit = options.resolveLimit ?? 200;
  let resolveErrors: Array<{ claimId: string; error: string }> = [];

  if (stopForTimeout) {
    failures.push({ step: "resolve", error: "skipped after a timed-out write" });
    log("[seed] resolve phase skipped after a timed-out write");
  } else {
    log("[seed] resolve phase");
    try {
      const resolved = await resolveDueClaims(now, resolveLimit, {
        onList(ids) {
          log(`[seed] resolve phase: ${ids.length} due claim(s)`);
        },
        onClaimStart(claimId) {
          log(`[seed] resolve start ${claimId}`);
        },
        onClaimDone(report, elapsedMs) {
          log(`[seed] resolve done ${report.claimId} ${report.outcome} ${elapsedMs}ms`);
        },
        onClaimError(claimId, error, elapsedMs) {
          log(`[seed] resolve failed ${claimId} ${elapsedMs}ms: ${error}`);
        },
        stopOnError(err) {
          return isDeadlineError(err) || /timed out/i.test(errorMessage(err));
        },
      });
      resolveErrors = resolved.errors;
      if (resolved.stopped) {
        failures.push({ step: "resolve", error: `stopped: ${resolved.stopped}` });
        log(`[seed] resolve phase stopped: ${resolved.stopped}`);
      }
    } catch (err) {
      const message = errorMessage(err);
      failures.push({ step: "resolve", error: message });
      log(`[seed] resolve phase failed: ${message}`);
    }
  }

  const head = {
    postsRead: file.posts.length,
    postsSeeded,
    postsSkipped,
    realPosts: file.posts.filter((p) => !isSynthetic(p)).length,
    syntheticPosts: file.posts.filter((p) => isSynthetic(p)).length,
    resolveErrors,
    failures,
    notAttempted,
  };

  let summaryInput: SeedSummaryInput;
  try {
    summaryInput = await readSummary(head);
  } catch (err) {
    const message = errorMessage(err);
    log(`[seed] summary query failed: ${message}`);
    summaryInput = {
      ...head,
      realClaims: 0,
      syntheticClaims: 0,
      memoriesByNamespace: {},
      blobIds: [],
      scores: [],
      failures: [...failures, { step: "summary", error: message }],
    };
  }

  const summary = formatSeedSummary(summaryInput);
  const ok =
    summaryInput.failures?.length === 0 &&
    summaryInput.notAttempted?.length === 0 &&
    summaryInput.resolveErrors.length === 0;
  log(`[seed] ${ok ? "finished" : "finished incomplete"}`);
  return { summary, ok };
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
  try {
    await closeDb();
  } finally {
    destroyMemwal();
  }
}
