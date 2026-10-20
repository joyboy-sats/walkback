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
import { writeDurable, type DurableStepResult } from "./durable-writes";
import { isReplay } from "./env";
import { requireMemwalConfig } from "./memwal-config";
import {
  LIST_PAGE_LIMIT,
  ListUnavailableError,
  parseMemoriesPage,
  walkMemories,
  type ListWalkResult,
  type MemoriesPage,
} from "./memory-list";
import { memwalReadLimiter, memwalWriteLimiter } from "./ratelimit";
import type { Namespace } from "./types";

/** Server-side hard limit for one bulk call. */
export const BULK_MAX = 20;

let client: MemWal | null = null;

function getClient(): MemWal {
  if (client) return client;
  // Narrow on purpose: listing must not require Tatum or Postgres.
  const e = requireMemwalConfig();
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
 * Write many memories, one at a time, stopping at the first failure.
 *
 * `RememberBulkItem` in 0.1.8 is `{ text, namespace }` — no idempotency key.
 * `rememberBulkAndWait` returns partial blob ids on timeout, but a thrown
 * poll error discards the ones already collected, and so does a crash. Those
 * jobs can still complete on the relayer. Retrying the whole batch would
 * append duplicates. This function uses `rememberAndWait` and `idempotencyKey`
 * instead. Pass `onPersisted` to store each blob id before the next item is
 * sent. Items after a failure are reported as `not attempted` and were not sent.
 *
 * `BULK_MAX` remains the cap for a single relayer bulk call. This path does
 * not use that call.
 */
export interface BulkItemOutcome {
  id?: string;
  blobId?: string;
  namespace: string;
  error?: string;
}

export async function writeMemoriesDurable(
  items: readonly MemoryWrite[],
  onPersisted: (item: MemoryWrite, result: DurableStepResult) => Promise<void>,
): Promise<{ error?: string }> {
  if (isReplay()) throw new Error("writeMemoriesDurable called in replay mode.");
  const { error } = await writeDurable(items, rememberOne, onPersisted);
  return error ? { error } : {};
}

async function rememberOne(item: MemoryWrite): Promise<DurableStepResult> {
  const res = await writeMemory(item);
  return { blobId: res.blobId, id: res.id };
}

export async function writeMemoriesBulk(
  items: MemoryWrite[],
  opts?: {
    onPersisted?: (item: MemoryWrite, result: DurableStepResult) => Promise<void>;
  },
): Promise<{
  results: BulkItemOutcome[];
}> {
  if (isReplay()) {
    throw new Error("writeMemoriesBulk called in replay mode.");
  }
  if (items.length === 0) return { results: [] };
  if (new Set(items.map((i) => i.namespace)).size > 1) {
    throw new Error("bulk write requires a single namespace; split by namespace first");
  }

  const saved = new Map<string, DurableStepResult>();
  const { error } = await writeMemoriesDurable(items, async (item, result) => {
    if (opts?.onPersisted) await opts.onPersisted(item, result);
    saved.set(item.idempotencyKey, result);
  });

  let failed = false;
  const results: BulkItemOutcome[] = items.map((item) => {
    const hit = saved.get(item.idempotencyKey);
    if (hit) return { id: hit.id, blobId: hit.blobId, namespace: item.namespace };
    if (!failed) {
      failed = true;
      return { namespace: item.namespace, error: error ?? "write failed" };
    }
    return { namespace: item.namespace, error: "not attempted after an earlier failure" };
  });
  return { results };
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

/**
 * Signer used by the installed SDK. `signedRequest` is private in the `.d.ts`
 * and `listMemories` is not in 0.1.8 (npm latest is 0.1.8). Calling the
 * method that already signs requests keeps the canonical string, the nonce,
 * and the clock-drift handling on the SDK's code path. Metadata reads pass
 * `includeDelegateKey: false`, so no SEAL session and no delegate key go out.
 */
type SdkSigner = {
  signedRequest: (
    method: string,
    path: string,
    body: unknown,
    acceptedStatuses?: number[],
    requestOptions?: { includeDelegateKey?: boolean; timeoutMs?: number },
  ) => Promise<unknown>;
};

function signer(): SdkSigner {
  return getClient() as unknown as SdkSigner;
}

let ownerAddress: string | null = null;
let ownerPromise: Promise<string> | null = null;

/**
 * Owner address for `/v1/owners/:owner/...`. Same call the SDK uses:
 * signed `POST /api/stats` with the client's namespace (`default` when
 * `MemWal.create` is not given one). The address is a public config value,
 * like `MEMWAL_AGENT_ID` (`getPublicKeyHex()`).
 */
async function resolveOwner(): Promise<string> {
  if (ownerAddress) return ownerAddress;
  if (ownerPromise) return ownerPromise;
  ownerPromise = (async () => {
    const stats = (await signer().signedRequest(
      "POST",
      "/api/stats",
      { namespace: "default" },
      [200],
      { includeDelegateKey: false },
    )) as { owner?: string };
    if (!stats.owner || !/^[0-9A-Za-z]+$/.test(stats.owner)) {
      throw new Error(
        "Walrus Memory could not resolve this account's owner address (POST /api/stats returned no owner).",
      );
    }
    ownerAddress = stats.owner;
    return stats.owner;
  })().finally(() => {
    ownerPromise = null;
  });
  return ownerPromise;
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("status" in err)) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * One page of `GET /v1/owners/:owner/memories`. Metadata only on the current
 * relayer. 404/405/501 become `ListUnavailableError` so rebuild can fall
 * back to recall; every other failure stays a failure.
 */
export async function listMemoriesPage(options?: {
  cursor?: string;
  limit?: number;
}): Promise<MemoriesPage> {
  await memwalReadLimiter.acquire();
  const owner = await resolveOwner();
  const params = new URLSearchParams();
  if (options?.cursor !== undefined) params.set("updated_after", options.cursor);
  params.set("limit", String(options?.limit ?? LIST_PAGE_LIMIT));
  const path = `/v1/owners/${owner}/memories?${params.toString()}`;
  try {
    const raw = await signer().signedRequest("GET", path, {}, [200], { includeDelegateKey: false });
    return parseMemoriesPage(raw);
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || status === 405 || status === 501) {
      throw new ListUnavailableError(
        "GET /v1/owners/:owner/memories is not on this relayer. Listing is unavailable.",
        status,
      );
    }
    throw err;
  }
}

/** Every page, in order. A mid-walk error rejects; it does not return a prefix. */
export async function listAllMemories(): Promise<ListWalkResult> {
  return walkMemories({
    fetchPage: (cursor) => listMemoriesPage(cursor === undefined ? {} : { cursor }),
  });
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
 * The delegate public key. This is `MEMWAL_AGENT_ID`: `getPublicKeyHex()`,
 * a public config value, not a secret. Async because the SDK returns
 * `Promise<string>`.
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
  ownerAddress = null;
  ownerPromise = null;
}
