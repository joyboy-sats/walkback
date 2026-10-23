/**
 * Tatum Sui RPC client.
 *
 * Design notes that matter more than the code:
 *
 * - The free tier is 3 requests/second and 2 credits per ordinary RPC call.
 *   Every call goes through a limiter; batching by address is the caller's job
 *   but the limiter makes a burst degrade instead of failing.
 * - Sui RPC responses are deeply nested and use coin-type keys like
 *   `0x2::sui::SUI` inside larger shapes. `normalizeBalance` flattens what we
 *   need so nothing downstream has to know the wire shape.
 * - There is NO historical balance query on Sui. `suix_getBalance` is
 *   current-state only. Anything about the past must go through
 *   `queryTransactionBlocks`, then `sui_multiGetTransactionBlocks` with
 *   `showBalanceChanges` on the digests that have effects. Asking for
 *   balance changes on the page itself fails the whole page when the
 *   address index contains a digest the node cannot load.
 * - In replay mode every call is served from a fixture file and no network
 *   request is made. The demo has to survive a dead wifi.
 */
import "server-only";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withRetry } from "./bounded";
import { env, isReplay } from "./env";
import {
  noteOhlcvRequest,
  parseTatumCandle,
  parseTatumCandles,
  type PriceCandle,
  type PriceInterval,
} from "./price-candle";
import { RateLimiter } from "./ratelimit";

/** ~3 req/s on the free tier; kept at 2.5 to leave headroom. */
const rpcLimiter = new RateLimiter({ capacity: 15, windowMs: 6_000 });

const REPLAY_DIR = "fixtures/tatum";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class TatumError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly method?: string,
  ) {
    super(message);
    this.name = "TatumError";
  }
}

let rpcId = 0;

/**
 * Raw JSON-RPC call with limiter, retries, a per-attempt timeout and replay
 * support. Throws `TatumError` after retries are exhausted; callers turn that
 * into a `void` verdict, never into a `false`.
 */
export async function rpc<T>(
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 8_000, retries = 2 } = opts;
  const cacheKey = `${method}-${stableKey(params)}`;

  if (isReplay()) {
    return readFixture<T>(cacheKey);
  }

  await rpcLimiter.acquire();

  const e = env();
  if (!e.TATUM_API_KEY) {
    throw new TatumError("TATUM_API_KEY is not set", undefined, method);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(e.TATUM_SUI_RPC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": e.TATUM_API_KEY,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        await sleep(800 * (attempt + 1) + Math.random() * 400);
        lastErr = new TatumError("rate limited", 429, method);
        continue;
      }
      if (!res.ok) {
        throw new TatumError(`http ${res.status}`, res.status, method);
      }

      const body = (await res.json()) as RpcResponse<T>;
      if (body.error) {
        // A JSON-RPC error is a *definite* answer about bad input — retrying
        // will not help. Surface it.
        throw new TatumError(body.error.message, body.error.code, method);
      }
      if (body.result === undefined) {
        throw new TatumError("empty result", undefined, method);
      }

      if (e.DEMO_MODE === "live" && process.env.CAPTURE_FIXTURES === "1") {
        await writeFixture(cacheKey, body.result);
      }
      return body.result;
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof TatumError ? err.code === 429 || err.code === undefined : true;
      if (!retryable || attempt === retries) break;
      await sleep(400 * (attempt + 1) + Math.random() * 250);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new TatumError("unknown failure", undefined, method);
}

// ── Domain helpers ───────────────────────────────────────────────────────────

export interface BalanceInfo {
  /** Base units, decimal string. */
  balance: string;
  /** Human units, derived from coinMetadata when available. */
  formatted?: string;
  coinType: string;
  coinObjectCount?: number;
}

/**
 * Wire shape of `suix_getBalance`. The fields are FLAT on the result object:
 *
 *   { coinType, coinObjectCount, totalBalance, lockedBalance, fundsInAddressBalance }
 *
 * Not `{ balance: { balance } }`. Reading the nested shape silently yields 0
 * for every address, which makes every balance claim adjudicate `false`.
 * Verified against the live Tatum gateway.
 */
export interface RawBalance {
  coinType?: string;
  coinObjectCount?: number;
  totalBalance?: string;
}

/**
 * Parse a `suix_getBalance` result. Pure, so the wire shape can be asserted
 * without a network call.
 *
 * A zero balance still returns an object with `totalBalance: "0"`; only a
 * missing field means the node answered in a shape we do not understand.
 * That case throws rather than returning zero: guessing zero would turn an
 * upstream problem into a false accusation against the source.
 */
export function parseBalanceResponse(
  raw: RawBalance | null | undefined,
  fallbackCoinType: string,
): BalanceInfo {
  if (!raw || raw.totalBalance === undefined) {
    throw new TatumError(
      `suix_getBalance returned no totalBalance (keys: ${
        raw ? Object.keys(raw).join(",") : "null"
      })`,
      undefined,
      "suix_getBalance",
    );
  }
  return {
    balance: String(raw.totalBalance),
    coinType: raw.coinType ?? fallbackCoinType,
    ...(raw.coinObjectCount !== undefined ? { coinObjectCount: raw.coinObjectCount } : {}),
  };
}

/** Current balance of one coin type for one address. */
export async function getBalance(address: string, coinType: string): Promise<BalanceInfo> {
  assertAddress(address);
  const raw = await rpc<RawBalance>("suix_getBalance", [address, coinType]);
  return parseBalanceResponse(raw, coinType);
}

export interface BalanceChange {
  address: string;
  coinType: string;
  /** Signed: negative means funds left. Base units. */
  amount: string;
}

export interface TransactionBlock {
  digest: string;
  /** ISO timestamp, or undefined when the node did not report one. */
  timestamp?: string;
  balanceChanges: BalanceChange[];
}

/**
 * Page options for `suix_queryTransactionBlocks`.
 *
 * `showEffects` is enough to learn the timestamp and to see that a digest
 * has effects. `showBalanceChanges` is intentionally absent: on Sui, one
 * digest in the page with empty effects makes the node reject the entire
 * page (`unable to derive balance/object changes because effect is empty`).
 * Balance changes are loaded afterwards, per digest.
 */
export const REPLAY_PAGE_OPTIONS = { showEffects: true } as const;

export interface RawBalanceChange {
  owner?: { AddressOwner?: string } | string;
  coinType?: string;
  amount?: string | number;
}

/** One row of a `suix_queryTransactionBlocks` or `sui_multiGetTransactionBlocks` result. */
export interface RawQueriedTransaction {
  digest?: string;
  timestampMs?: string | null;
  effects?: unknown;
  balanceChanges?: RawBalanceChange[] | null;
}

/** The node stringifies this as a Rust `ErrorObject` when a page mixes in a digest it cannot load. */
export function isEmptyEffectError(message: string): boolean {
  return /effect is empty/i.test(message);
}

export function parseBalanceChanges(
  raw: RawBalanceChange[] | null | undefined,
): BalanceChange[] {
  return (raw ?? []).map((change) => ({
    address: addressOfOwner(change.owner),
    coinType: change.coinType ?? "",
    amount: String(change.amount ?? "0"),
  }));
}

function addressOfOwner(owner: RawBalanceChange["owner"]): string {
  if (!owner) return "";
  if (typeof owner === "string") return owner;
  return owner.AddressOwner ?? "";
}

/**
 * The address index sometimes returns a digest the node does not have.
 * `sui_getTransactionBlock` answers "Could not find the referenced
 * transaction", and the row has no timestamp and no effects. It is not a
 * transfer we can place in a window.
 */
export function isPhantomTransaction(tx: RawQueriedTransaction): boolean {
  const hasTimestamp = tx.timestampMs != null && tx.timestampMs !== "";
  return !hasTimestamp && (tx.effects == null);
}

export function parseQueriedTransaction(tx: RawQueriedTransaction): TransactionBlock | null {
  if (!tx.digest || isPhantomTransaction(tx)) return null;
  const parsed = tx.timestampMs ? new Date(Number(tx.timestampMs)) : null;
  const timestamp =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
  return {
    digest: tx.digest,
    ...(timestamp ? { timestamp } : {}),
    balanceChanges: parseBalanceChanges(tx.balanceChanges),
  };
}

export function parseTransactionPage(raw: {
  data?: RawQueriedTransaction[] | null;
  nextCursor?: string | null;
  hasNextPage?: boolean;
}): {
  blocks: TransactionBlock[];
  nextCursor: string | null;
  hasNextPage: boolean;
  droppedPhantoms: number;
} {
  const blocks: TransactionBlock[] = [];
  let droppedPhantoms = 0;
  for (const tx of raw.data ?? []) {
    const parsed = parseQueriedTransaction(tx);
    if (parsed) {
      blocks.push(parsed);
      continue;
    }
    if (tx?.digest && isPhantomTransaction(tx)) droppedPhantoms += 1;
  }
  return {
    blocks,
    nextCursor: raw.nextCursor ?? null,
    hasNextPage: Boolean(raw.hasNextPage),
    droppedPhantoms,
  };
}

/**
 * Load balance changes for specific digests.
 *
 * A batch that contains one unloadable digest fails as a whole. Split until
 * the bad digest is alone, then record it as unreadable and keep the rest.
 * Any other error still throws: a dead gateway is not a zero transfer.
 */
export async function loadBalanceChanges(
  digests: readonly string[],
  fetchBatch: (digests: readonly string[]) => Promise<RawQueriedTransaction[]>,
): Promise<{ changes: Map<string, BalanceChange[]>; unreadable: string[] }> {
  const changes = new Map<string, BalanceChange[]>();
  const unreadable: string[] = [];

  async function rec(batch: readonly string[]): Promise<void> {
    if (batch.length === 0) return;
    try {
      const txs = await fetchBatch(batch);
      const byDigest = new Map(
        txs.filter((tx) => tx.digest).map((tx) => [tx.digest as string, tx]),
      );
      for (const digest of batch) {
        const tx = byDigest.get(digest);
        if (!tx || isPhantomTransaction(tx)) {
          unreadable.push(digest);
          continue;
        }
        changes.set(digest, parseBalanceChanges(tx.balanceChanges));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isEmptyEffectError(message)) throw err;
      if (batch.length === 1) {
        unreadable.push(batch[0]!);
        return;
      }
      const mid = Math.floor(batch.length / 2);
      await rec(batch.slice(0, mid));
      await rec(batch.slice(mid));
    }
  }

  const chunk = 20;
  for (let i = 0; i < digests.length; i += chunk) {
    await rec(digests.slice(i, i + chunk));
  }
  return { changes, unreadable };
}

/** Net of one coin for the blocks whose timestamps sit in `[since, until)`. */
export function sumBalanceChanges(
  blocks: readonly TransactionBlock[],
  address: string,
  coinType: string,
  sinceIso: string,
  untilIso: string,
): { net: bigint; sampledBlocks: number } {
  let net = 0n;
  let sampledBlocks = 0;
  for (const tx of blocks) {
    if (!tx.timestamp) continue;
    if (tx.timestamp < sinceIso || tx.timestamp >= untilIso) continue;
    sampledBlocks += 1;
    for (const change of tx.balanceChanges) {
      if (change.coinType !== coinType) continue;
      if (change.address !== address) continue;
      net += BigInt(change.amount);
    }
  }
  return { net, sampledBlocks };
}

/**
 * Newest-first page of transaction blocks for an address.
 *
 * This is the only way to learn about the past. `suix_queryTransactionBlocks`
 * returns newest-first and paginates backwards with `cursor`.
 */
export async function queryTransactionBlocks(
  address: string,
  opts: {
    limit?: number;
    cursor?: string | null;
    /** Stop paging once a block older than this appears. */
    untilIso?: string;
    maxPages?: number;
    /**
     * Which side of the transfer to ask for. `FromAddress` misses inflows.
     * `netChangeInWindow` queries both.
     */
    filter?: "FromAddress" | "ToAddress";
  } = {},
): Promise<{
  blocks: TransactionBlock[];
  nextCursor: string | null;
  hasNextPage: boolean;
  droppedPhantoms: number;
}> {
  assertAddress(address);
  const { limit = 50, cursor = null, untilIso, maxPages = 4, filter = "FromAddress" } = opts;

  const blocks: TransactionBlock[] = [];
  let pageCursor = cursor;
  let hasNextPage = false;
  let droppedPhantoms = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await rpc<{
      data?: RawQueriedTransaction[];
      nextCursor?: string | null;
      hasNextPage?: boolean;
    }>("suix_queryTransactionBlocks", [
      { filter: { [filter]: address }, options: REPLAY_PAGE_OPTIONS },
      pageCursor,
      limit,
      true,
    ]);

    const parsed = parseTransactionPage(res);
    blocks.push(...parsed.blocks);
    droppedPhantoms += parsed.droppedPhantoms;
    pageCursor = parsed.nextCursor;
    hasNextPage = parsed.hasNextPage;

    if (!hasNextPage) break;
    if (untilIso) {
      const oldest = oldestTimestamp(parsed.blocks);
      if (oldest && oldest < untilIso) break;
    }
  }

  return { blocks, nextCursor: pageCursor, hasNextPage, droppedPhantoms };
}

/**
 * Whether a newest-first page walk still has unseen blocks inside the window.
 *
 * The RPC reports `hasNextPage` for history older than `sinceIso` as well.
 * Stopping because the oldest block is already before the window means the
 * window itself was fully read.
 */
export function replayTruncated(input: {
  hasNextPage: boolean;
  oldestTimestamp?: string;
  sinceIso: string;
}): boolean {
  if (!input.hasNextPage) return false;
  if (input.oldestTimestamp && input.oldestTimestamp < input.sinceIso) return false;
  return true;
}

/** Merge FromAddress and ToAddress pages. One digest is counted once. */
export function combineReplaySides(
  sides: ReadonlyArray<{ blocks: TransactionBlock[]; hasNextPage: boolean }>,
  sinceIso: string,
): { blocks: TransactionBlock[]; truncated: boolean } {
  const byDigest = new Map<string, TransactionBlock>();
  for (const side of sides) {
    for (const tx of side.blocks) {
      if (!byDigest.has(tx.digest)) byDigest.set(tx.digest, tx);
    }
  }
  const truncated = sides.some((side) =>
    replayTruncated({
      hasNextPage: side.hasNextPage,
      oldestTimestamp: oldestTimestamp(side.blocks),
      sinceIso,
    }),
  );
  return { blocks: [...byDigest.values()], truncated };
}

function oldestTimestamp(blocks: readonly TransactionBlock[]): string | undefined {
  let oldest: string | undefined;
  for (const tx of blocks) {
    if (!tx.timestamp) continue;
    if (!oldest || tx.timestamp < oldest) oldest = tx.timestamp;
  }
  return oldest;
}

/**
 * Net balance change for one coin type inside a window, derived by replaying
 * transfers. Used only for claims that predate the snapshot mechanism.
 *
 * Queries both the sender and recipient filters. A transfer into the address
 * does not appear in `FromAddress`.
 */
export async function netChangeInWindow(
  address: string,
  coinType: string,
  sinceIso: string,
  untilIso: string,
  maxPages = 6,
): Promise<{
  net: string;
  sampledBlocks: number;
  truncated: boolean;
  /** Digests inside the window whose balance changes could not be derived. */
  unreadableDigests: string[];
  /** Index rows with no timestamp and no effects. They are not transfers. */
  droppedPhantoms: number;
  /** Digests whose timestamps sit in the window. */
  digests: string[];
}> {
  const [sent, received] = await Promise.all([
    queryTransactionBlocks(address, { untilIso: sinceIso, maxPages, filter: "FromAddress" }),
    queryTransactionBlocks(address, { untilIso: sinceIso, maxPages, filter: "ToAddress" }),
  ]);
  const { blocks, truncated } = combineReplaySides(
    [
      { blocks: sent.blocks, hasNextPage: sent.hasNextPage },
      { blocks: received.blocks, hasNextPage: received.hasNextPage },
    ],
    sinceIso,
  );

  const inWindow = blocks.filter(
    (tx) => tx.timestamp && tx.timestamp >= sinceIso && tx.timestamp < untilIso,
  );
  const loaded = await loadBalanceChanges(
    inWindow.map((tx) => tx.digest),
    fetchBalanceChanges,
  );
  const readable = inWindow.map((tx) => ({
    ...tx,
    balanceChanges: loaded.changes.get(tx.digest) ?? [],
  }));
  const { net, sampledBlocks } = sumBalanceChanges(
    readable.filter((tx) => !loaded.unreadable.includes(tx.digest)),
    address,
    coinType,
    sinceIso,
    untilIso,
  );

  return {
    net: net.toString(),
    sampledBlocks,
    // Page cap reached while more history inside the window may exist.
    // Callers must void rather than guess.
    truncated,
    unreadableDigests: loaded.unreadable,
    droppedPhantoms: sent.droppedPhantoms + received.droppedPhantoms,
    digests: inWindow.map((tx) => tx.digest),
  };
}

async function fetchBalanceChanges(digests: readonly string[]): Promise<RawQueriedTransaction[]> {
  if (digests.length === 0) return [];
  return rpc<RawQueriedTransaction[]>("sui_multiGetTransactionBlocks", [
    [...digests],
    { showBalanceChanges: true },
  ]);
}

/** One rate attempt. 404 and a null value are answers, not failures. */
const RATE_TIMEOUT_MS = 8_000;
const RATE_ATTEMPTS = 3;
const RATE_BACKOFF_MS = 400;

/** Spot price. Returns undefined when the pair is unsupported. */
export async function getRate(symbol: string, basePair: string): Promise<number | undefined> {
  const e = env();
  if (!e.TATUM_API_KEY) throw new TatumError("TATUM_API_KEY is not set");

  if (isReplay()) {
    const fx = await readFixture<{ value: number }>(`rate-${symbol}-${basePair}`);
    return fx.value;
  }

  // 404 and a null value return undefined and are not retried. A 5xx, 429, or
  // a fetch that hits its own 8s abort is retried with backoff, three times.
  return withRetry(() => requestRate(e.TATUM_API_KEY!, e.TATUM_RATE_URL, symbol, basePair), {
    attempts: RATE_ATTEMPTS,
    backoffMs: RATE_BACKOFF_MS,
  });
}

async function requestRate(
  apiKey: string,
  rateUrl: string,
  symbol: string,
  basePair: string,
): Promise<number | undefined> {
  const url = `${rateUrl}?symbol=${encodeURIComponent(symbol)}&basePair=${encodeURIComponent(basePair)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
  });

  // The endpoint 404s (or returns a null value) for unsupported pairs. That is
  // a capability answer, not an outage: report it as undefined so the caller
  // can disable the claim type instead of retrying forever.
  if (res.status === 404) return undefined;
  if (!res.ok) throw new TatumError(`rate http ${res.status}`, res.status, "rate");

  const body = (await res.json()) as { value?: number } | null;
  return typeof body?.value === "number" ? body.value : undefined;
}

/**
 * Query value for `time` and `timeFrom`.
 *
 * Tatum rejects epoch milliseconds. A live call with
 * `time=1760000000000` returned HTTP 400
 * `time must be a Date instance`. The same route with
 * `time=2025-10-09T08:00:00Z` returned the SUI candle. `timeFrom` on the
 * batch route is sent the same way. Whole seconds drop the `.000` so the
 * wire value matches that call.
 */
export function ohlcvQueryTime(ms: number): string {
  if (!Number.isFinite(ms)) throw new TatumError("ohlcv time is not a timestamp", undefined, "ohlcv");
  const iso = new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(iso)) {
    throw new TatumError("ohlcv time is not a timestamp", undefined, "ohlcv");
  }
  return iso;
}

/**
 * One historical USD candle from GET /v4/data/rate/symbol/OHLCV.
 *
 * The endpoint returns the nearest candle when the requested time is outside
 * its history. A candle that does not contain `atIso` is `null`, not a price.
 * `undefined` is an unsupported symbol (HTTP 404). Quote is USD; there is no
 * basePair on this route. 50 credits per call. `time` is an ISO-8601 UTC
 * string from `ohlcvQueryTime`.
 */
export async function getOhlcvAt(
  symbol: string,
  atIso: string,
  interval: PriceInterval,
): Promise<PriceCandle | null | undefined> {
  const atMs = Date.parse(atIso);
  if (Number.isNaN(atMs)) throw new TatumError("ohlcv time is not a timestamp", undefined, "ohlcv");
  const key = `ohlcv-${symbol.toUpperCase()}-${interval}-${atMs}`;
  const time = ohlcvQueryTime(atMs);
  const raw = await ohlcvRequest(key, (url) => {
    const endpoint = new URL(url);
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("time", time);
    endpoint.searchParams.set("interval", interval);
    return endpoint.toString();
  }, "at");
  if (raw === undefined) return undefined;
  const candle = parseTatumCandle(raw);
  if (!candle) throw new TatumError("ohlcv response was not a candle", undefined, "ohlcv");
  // Nearest-candle replies are not a price for `at`. closeTime in the published
  // payload is the last millisecond inside the bucket, so it is inclusive here.
  // The history layer still requires the bucket width to match `interval`.
  if (atMs < candle.openTimeMs || atMs > candle.closeTimeMs) return null;
  return candle;
}

/**
 * Candles with openTime ≥ `fromIso`, oldest first, from
 * GET /v4/data/rate/symbol/OHLCV/batch. At most 50 per call. 500 credits.
 * `undefined` means the symbol is not on the feed.
 */
export async function getOhlcvPage(
  symbol: string,
  fromIso: string,
  interval: PriceInterval,
  limit: number,
): Promise<PriceCandle[] | undefined> {
  const fromMs = Date.parse(fromIso);
  if (Number.isNaN(fromMs)) throw new TatumError("ohlcv time is not a timestamp", undefined, "ohlcv");
  const size = Math.min(50, Math.max(1, Math.floor(limit)));
  const key = `ohlcv-batch-${symbol.toUpperCase()}-${interval}-${fromMs}-${size}`;
  const timeFrom = ohlcvQueryTime(fromMs);
  const raw = await ohlcvRequest(key, (url) => {
    const endpoint = new URL(url);
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("timeFrom", timeFrom);
    endpoint.searchParams.set("numberOfCandles", String(size));
    endpoint.searchParams.set("interval", interval);
    return endpoint.toString();
  }, "batch");
  if (raw === undefined) return undefined;
  const candles = parseTatumCandles(raw);
  if (!candles) throw new TatumError("ohlcv batch response was not a candle list", undefined, "ohlcv");
  return candles;
}

/**
 * `undefined` is a 404 (symbol not covered). Other failures throw.
 * The URL is the configured endpoint; only the query string is added.
 */
async function ohlcvRequest(
  fixtureKey: string,
  buildUrl: (endpoint: string) => string,
  kind: "at" | "batch",
): Promise<unknown> {
  if (isReplay()) return readFixture<unknown>(fixtureKey);

  const e = env();
  if (!e.TATUM_API_KEY) throw new TatumError("TATUM_API_KEY is not set", undefined, "ohlcv");
  const endpoint = kind === "at" ? e.TATUM_OHLCV_URL : e.TATUM_OHLCV_BATCH_URL;

  return withRetry(() => requestOhlcv(e.TATUM_API_KEY!, buildUrl(endpoint), fixtureKey, kind), {
    attempts: RATE_ATTEMPTS,
    backoffMs: RATE_BACKOFF_MS,
  });
}

async function requestOhlcv(
  apiKey: string,
  url: string,
  fixtureKey: string,
  kind: "at" | "batch",
): Promise<unknown> {
  noteOhlcvRequest(kind === "at" ? "single" : "batch");
  await rpcLimiter.acquire();
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new TatumError(`ohlcv http ${res.status}`, res.status, "ohlcv");
  const body: unknown = await res.json();
  if (env().DEMO_MODE === "live" && process.env.CAPTURE_FIXTURES === "1") {
    await writeFixture(fixtureKey, body);
  }
  return body;
}

// ── Internals ────────────────────────────────────────────────────────────────

function assertAddress(a: string): void {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(a)) {
    throw new TatumError(`malformed address: ${a.slice(0, 12)}…`);
  }
}

function stableKey(v: unknown): string {
  const s = JSON.stringify(v);
  return Buffer.from(s).toString("base64url").slice(0, 40);
}

async function readFixture<T>(key: string): Promise<T> {
  const path = join(REPLAY_DIR, `${key}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    throw new TatumError(
      `replay fixture missing: ${path}. Run once with CAPTURE_FIXTURES=1 and ` +
        `DEMO_MODE=live to record it.`,
    );
  }
}

async function writeFixture(key: string, result: unknown): Promise<void> {
  await mkdir(REPLAY_DIR, { recursive: true });
  await writeFile(join(REPLAY_DIR, `${key}.json`), JSON.stringify(result, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
