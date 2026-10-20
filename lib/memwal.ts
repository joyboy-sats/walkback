/**
 * The only module in this repo allowed to touch the Walrus Memory SDK.
 *
 * Every other file goes through the helpers here. That is not tidiness — the
 * SDK has three behaviours that are easy to get wrong and expensive when you
 * do, and centralising them means they are fixed in one place:
 *
 *   1. `remember()` returns `{ job_id, status }` only. The `blob_id` lives on
 *      the result of `rememberAndWait()`. Anything that persists a claim needs
 *      a blob_id, so it must use the waiting call.
 *
 *   2. A write costs ~22–27s of server time (measured, see scripts/timing.ts).
 *      Never call this from a request path that a user is waiting on. Bulk
 *      writes amortise to ~6s/item; single writes do not.
 *
 *   3. The delegate key is limited to 30 points/minute. `memwalWriteLimiter`
 *      gates every write.
 *
 * Also note: `remember` is append-only. There is no upsert, no update and no
 * delete in the public `MemWal` class (`forget`/`clear` exist only on
 * `MemWalMock`). Re-writing an identical string produces a second memory.
 * Deduplication is therefore the caller's job, and the tool for it is
 * `idempotencyKey` — the SDK keeps the key while a request has no
 * acknowledged response, so retrying with the same key collapses onto the
 * original (already paid for) job instead of writing twice.
 */
import "server-only";

import { MemWal } from "@mysten-incubation/memwal";
import { isReplay, requireDelegateKey } from "./env";
import { memwalWriteLimiter } from "./ratelimit";
import type { Namespace } from "./types";

/** Server-side hard limit for one bulk call. */
export const BULK_MAX = 20;

let client: MemWal | null = null;

function getClient(): MemWal {
  if (client) return client;
  const e = requireDelegateKey();
  client = MemWal.create({
    key: e.privateKey,
    accountId: e.accountId,
    serverUrl: e.serverUrl,
    requestTimeoutMs: 30_000,
  });
  return client;
}

export interface MemoryWrite {
  text: string;
  namespace: Namespace;
  idempotencyKey: string;
}

export interface MemoryWriteResult {
  id: string;
  blobId: string;
  owner: string;
  namespace: string;
}

function toResult(r: {
  id: string;
  blob_id: string;
  owner: string;
  namespace: string;
}): MemoryWriteResult {
  return { id: r.id, blobId: r.blob_id, owner: r.owner, namespace: r.namespace };
}

/**
 * Write one memory and wait for its blob_id.
 *
 * `idempotencyKey` should be derived from the domain identity of the thing
 * being written — `claim:{claimId}`, `resolution:{claimId}`,
 * `score:{sourceId}:v{n}` — so a retry after a network failure does not
 * duplicate or re-bill the write.
 */
export async function writeMemory(w: MemoryWrite): Promise<MemoryWriteResult> {
  if (isReplay()) {
    throw new Error(
      "writeMemory called in replay mode. The demo must not write to mainnet; " +
        "gate the caller on isReplay() instead.",
    );
  }
  await memwalWriteLimiter.acquire();
  const res = await getClient().rememberAndWait(w.text, w.namespace, {
    idempotencyKey: w.idempotencyKey,
    pollIntervalMs: 1000,
    timeoutMs: 180_000,
  });
  return toResult(res);
}

/**
 * Write many memories, splitting into calls the server accepts.
 *
 * Returns `results` **aligned with the input array**: `results[i]` is the
 * outcome for `items[i]`, with `error` set instead of `blobId` on failure.
 * Callers index into it directly, so never compact failures out.
 *
 * Throws only when a whole batch fails, since that means the relayer is down
 * rather than one bad item.
 *
 * Note `rememberBulkAndWait` does not take idempotency keys — idempotency at
 * this level comes from the text being stable plus callers checking what is
 * already in Postgres.
 */
export interface BulkItemOutcome {
  id?: string;
  blobId?: string;
  namespace: string;
  error?: string;
}

export async function writeMemoriesBulk(items: MemoryWrite[]): Promise<{
  results: BulkItemOutcome[];
}> {
  if (isReplay()) {
    throw new Error("writeMemoriesBulk called in replay mode.");
  }
  if (items.length === 0) return { results: [] };
  if (new Set(items.map((i) => i.namespace)).size > 1) {
    throw new Error("bulk write requires a single namespace; split by namespace first");
  }

  const out: BulkItemOutcome[] = new Array(items.length);

  for (let offset = 0; offset < items.length; offset += BULK_MAX) {
    const batch = items.slice(offset, offset + BULK_MAX);
    // One token per item keeps the budget honest across mixed single/bulk traffic.
    await memwalWriteLimiter.acquire(batch.length);

    const res = await getClient().rememberBulkAndWait(
      batch.map((it) => ({ text: it.text, namespace: it.namespace })),
      { pollIntervalMs: 1000, timeoutMs: 300_000 },
    );

    if (res.succeeded === 0 && res.failed > 0) {
      throw new Error(
        `bulk write failed entirely at offset ${offset}: ` +
          res.results.map((r) => r.error ?? r.status).join("; "),
      );
    }

    // The server returns one result per input item, in order.
    res.results.forEach((r, i) => {
      const abs = offset + i;
      const namespace = batch[i]?.namespace ?? items[abs]!.namespace;
      out[abs] =
        r.status === "done" && r.blob_id
          ? { id: r.id, blobId: r.blob_id, namespace: r.namespace || namespace }
          : { namespace, error: r.error ?? r.status };
    });
  }

  return { results: out };
}

export interface RecallHit {
  blobId: string;
  text: string;
  distance: number;
  createdAt?: string;
}

export interface RecallArgs {
  query: string;
  namespace: Namespace;
  limit?: number;
  maxDistance?: number;
  /** `recent` is newest-among-matches; `relevance` is pure cosine order. */
  sort?: "relevance" | "recent";
}

/**
 * Semantic recall. Not a database query: there is no filtering by field, no
 * ordering by a column and no exact match. Treat hits as evidence to be
 * re-parsed, not as rows.
 *
 * Reads are not rate-limited — they are cheap, and stalling the UI for them
 * would be pointless.
 */
export async function recallMemory(a: RecallArgs): Promise<RecallHit[]> {
  const res = await getClient().recall({
    query: a.query,
    namespace: a.namespace,
    limit: a.limit ?? 10,
    ...(a.maxDistance !== undefined ? { maxDistance: a.maxDistance } : {}),
    ...(a.sort ? { sort: a.sort } : {}),
  });
  return res.results.map((r) => ({
    blobId: r.blob_id,
    text: r.text,
    distance: r.distance,
    ...(r.created_at ? { createdAt: r.created_at } : {}),
  }));
}

/** Namespaces this account holds memories in, with counts and storage used. */
export async function listNamespaces() {
  const res = await getClient().listNamespaces({ limit: 100 });
  return res.namespaces.map((n) => ({
    name: n.name,
    memoryCount: n.memory_count,
    storageUsed: n.storage_used,
    updatedAt: n.updated_at,
  }));
}

/**
 * Rebuild the relayer's local index from Walrus for one namespace.
 *
 * No pagination cursor exists; this is single-shot, costs seconds per blob and
 * may report `truncated: true` when more blobs were missing than `limit`
 * allowed. Call it off the request path, with a generous limit, and loop while
 * `truncated` is true but `restored > 0`.
 */
export async function restoreNamespace(namespace: Namespace, limit = 200) {
  const r = await getClient().restore(namespace, limit);
  return {
    restored: r.restored,
    skipped: r.skipped,
    failed: r.failed,
    total: r.total,
    truncated: r.truncated,
  };
}

/**
 * The delegate public key — the value the submission form wants as
 * MEMWAL_AGENT_ID. Async: it is `Promise<string>`, not a property.
 */
export async function delegatePublicKeyHex(): Promise<string> {
  return getClient().getPublicKeyHex();
}

/** Relayer health. Public endpoint; safe to call before credentials are known. */
export async function relayerHealth() {
  const h = await getClient().health();
  return {
    status: h.status,
    version: h.version,
    mode: h.mode,
    writeReady: h.write_ready,
  };
}

/** Wipe keys from the heap. For scripts and tests; the server should keep the client. */
export function destroyMemwal(): void {
  client?.destroy();
  client = null;
}
