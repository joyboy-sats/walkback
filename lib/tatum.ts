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
 *   `queryTransactionBlocks` with `showBalanceChanges`. This is the single
 *   most important constraint in the whole product.
 * - In replay mode every call is served from a fixture file and no network
 *   request is made. The demo has to survive a dead wifi.
 */
import "server-only";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env, isReplay } from "./env";
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
): Promise<{ blocks: TransactionBlock[]; nextCursor: string | null; hasNextPage: boolean }> {
  assertAddress(address);
  const { limit = 50, cursor = null, untilIso, maxPages = 4, filter = "FromAddress" } = opts;

  const blocks: TransactionBlock[] = [];
  let pageCursor = cursor;
  let hasNextPage = false;

  for (let page = 0; page < maxPages; page++) {
    const res = await rpc<{
      data?: Array<{
        digest: string;
        timestampMs?: string;
        balanceChanges?: Array<{
          owner?: { AddressOwner?: string };
          coinType?: string;
          amount?: string;
        }>;
      }>;
      nextCursor?: string | null;
      hasNextPage?: boolean;
    }>("suix_queryTransactionBlocks", [
      { filter: { [filter]: address }, options: { showBalanceChanges: true } },
      pageCursor,
      limit,
      true,
    ]);

    const data = res.data ?? [];
    for (const tx of data) {
      const ts = tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : undefined;
      blocks.push({
        digest: tx.digest,
        ...(ts ? { timestamp: ts } : {}),
        balanceChanges: (tx.balanceChanges ?? []).map((c) => ({
          address: c.owner?.AddressOwner ?? "",
          coinType: c.coinType ?? "",
          amount: String(c.amount ?? "0"),
        })),
      });
    }

    pageCursor = res.nextCursor ?? null;
    hasNextPage = Boolean(res.hasNextPage);

    if (!hasNextPage) break;
    if (untilIso) {
      const oldest = blocks[blocks.length - 1]?.timestamp;
      if (oldest && oldest < untilIso) break;
    }
  }

  return { blocks, nextCursor: pageCursor, hasNextPage };
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
): Promise<{ net: string; sampledBlocks: number; truncated: boolean }> {
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

  let net = 0n;
  let counted = 0;
  for (const tx of blocks) {
    if (!tx.timestamp) continue;
    if (tx.timestamp < sinceIso) continue;
    if (tx.timestamp >= untilIso) continue;
    counted++;
    for (const c of tx.balanceChanges) {
      if (c.coinType !== coinType) continue;
      if (c.address !== address) continue;
      net += BigInt(c.amount);
    }
  }

  return {
    net: net.toString(),
    sampledBlocks: counted,
    // Page cap reached while more history inside the window may exist.
    // Callers must void rather than guess.
    truncated,
  };
}

/** Spot price. Returns undefined when the pair is unsupported. */
export async function getRate(symbol: string, basePair: string): Promise<number | undefined> {
  const e = env();
  if (!e.TATUM_API_KEY) throw new TatumError("TATUM_API_KEY is not set");

  if (isReplay()) {
    const fx = await readFixture<{ value: number }>(`rate-${symbol}-${basePair}`);
    return fx.value;
  }

  const url = `${e.TATUM_RATE_URL}?symbol=${encodeURIComponent(symbol)}&basePair=${encodeURIComponent(basePair)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": e.TATUM_API_KEY },
    signal: AbortSignal.timeout(8_000),
  });

  // The endpoint 404s (or returns a null value) for unsupported pairs. That is
  // a capability answer, not an outage: report it as undefined so the caller
  // can disable the claim type instead of retrying forever.
  if (res.status === 404) return undefined;
  if (!res.ok) throw new TatumError(`rate http ${res.status}`, res.status, "rate");

  const body = (await res.json()) as { value?: number } | null;
  return typeof body?.value === "number" ? body.value : undefined;
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
