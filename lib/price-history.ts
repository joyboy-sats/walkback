/**
 * Cover a price window with Tatum OHLCV candles.
 *
 * Hourly candles are preferred. Daily candles are used only when hourly
 * cannot be requested: the window would exceed the hourly call budget, the
 * hourly interval is rejected, or hourly returns nothing. A hole inside an
 * hourly series is a void, not a reason to switch to a coarser bucket — a
 * daily high would paper over the missing hour.
 *
 * The feed's bucket is the resolution of the check. A candle that overlaps
 * the window is kept, so the first bucket can start up to one interval before
 * `from` and the last bucket can end up to one interval after `to`. Those
 * slivers are recorded on the result. A candle that merely opens at `to`
 * is not kept: its range is after the deadline.
 */
import {
  DAILY_PAGE_BUDGET,
  HOURLY_PAGE_BUDGET,
  INTERVAL_MS,
  OHLCV_PAGE_SIZE,
  TATUM_OHLCV_SOURCE,
  candleEndExclusiveMs,
  decidingExtreme,
  hourlyPagesFor,
  spanMatchesInterval,
  windowExtremes,
  type PriceCandle,
  type PriceExtreme,
  type PriceInterval,
} from "./price-candle";

export interface OhlcvPageQuery {
  symbol: string;
  from: string;
  interval: PriceInterval;
  limit: number;
}

export interface OhlcvAtQuery {
  symbol: string;
  at: string;
  interval: PriceInterval;
}

export interface PriceHistorySource {
  /** `undefined` means the symbol is not on the feed. */
  page(query: OhlcvPageQuery): Promise<PriceCandle[] | undefined>;
  /** `undefined` means the symbol is not on the feed. `null` means no bucket covers `at`. */
  at(query: OhlcvAtQuery): Promise<PriceCandle | null | undefined>;
}

export interface WindowBoundary {
  /** Milliseconds of the window before the first candle. At most one interval. */
  uncoveredStartMs: number;
  /** Milliseconds of the window after the last candle. At most one interval. */
  uncoveredEndMs: number;
  /** How far the first candle starts before the window. */
  leadMs: number;
  /** How far the last candle ends after the window. */
  overhangMs: number;
}

export interface TouchSeries {
  ok: true;
  source: typeof TATUM_OHLCV_SOURCE;
  interval: PriceInterval;
  intervalFallback?: string;
  candles: PriceCandle[];
  boundary: WindowBoundary;
  requests: number;
  maxHigh: PriceExtreme;
  minLow: PriceExtreme;
  extreme: PriceExtreme;
}

export interface DeadlinePrint {
  ok: true;
  source: typeof TATUM_OHLCV_SOURCE;
  interval: PriceInterval;
  intervalFallback?: string;
  candle: PriceCandle;
  /** Open when the deadline is the candle open; otherwise the candle close. */
  field: "open" | "close";
  value: number;
  /** Timestamp the compared price belongs to. */
  at: string;
}

export interface PriceCheckFailure {
  ok: false;
  reason: string;
  evidence: Record<string, unknown>;
}

export type TouchLoad = TouchSeries | PriceCheckFailure;
export type DeadlineLoad = DeadlinePrint | PriceCheckFailure;

export async function loadTouchWindow(
  source: PriceHistorySource,
  input: { symbol: string; from: string; to: string; direction: "gte" | "lte" },
): Promise<TouchLoad> {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return fail("The price window is empty, so the claim was not checked.", {
      source: TATUM_OHLCV_SOURCE,
      window: { from: input.from, to: input.to },
    });
  }

  const base = {
    source: TATUM_OHLCV_SOURCE,
    symbol: input.symbol,
    quote: "USD",
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  };

  const preferDaily = hourlyPagesFor(toMs - fromMs) > HOURLY_PAGE_BUDGET;
  if (!preferDaily) {
    const hourly = await readInterval(source, input.symbol, fromMs, toMs, "1h", HOURLY_PAGE_BUDGET);
    if (hourly.kind === "unsupported") return unsupported(input.symbol, base);
    if (hourly.kind === "mismatch") return mismatch(input.symbol, hourly.symbol, base);
    if (hourly.kind === "candles" && hourly.candles.length > 0) {
      return finishTouch(input, "1h", hourly.candles, hourly.requests, fromMs, toMs);
    }
    if (hourly.kind === "budget") {
      return fail(
        `Tatum ${input.symbol}/USD hourly history was not fully read, so the claim was not checked.`,
        { ...base, interval: "1h" },
      );
    }
    const why =
      hourly.kind === "rejected"
        ? "hourly request was rejected"
        : "hourly returned no candles";
    const daily = await readDaily(source, input, fromMs, toMs, base, why);
    return daily;
  }

  return readDaily(
    source,
    input,
    fromMs,
    toMs,
    base,
    "window is longer than the hourly request budget",
  );
}

export async function loadDeadlinePrice(
  source: PriceHistorySource,
  input: { symbol: string; at: string },
): Promise<DeadlineLoad> {
  const atMs = Date.parse(input.at);
  const atIso = Number.isNaN(atMs) ? input.at : new Date(atMs).toISOString();
  if (Number.isNaN(atMs)) {
    return fail("The deadline is not a timestamp, so the claim was not checked.", {
      source: TATUM_OHLCV_SOURCE,
      deadline: input.at,
    });
  }

  let fallback: string | undefined;
  for (const interval of ["1h", "1d"] as const) {
    let candle: PriceCandle | null | undefined;
    try {
      candle = await source.at({ symbol: input.symbol, at: atIso, interval });
    } catch (err) {
      if (statusCode(err) === 400) {
        fallback = fallback ?? `${interval} request was rejected`;
        continue;
      }
      throw err;
    }
    if (candle === undefined) return unsupported(input.symbol, { deadline: atIso });
    if (
      candle === null ||
      !spanMatchesInterval(candle, interval) ||
      !candleCovers(candle, atMs, interval)
    ) {
      fallback = fallback ?? `${interval} candle did not cover the deadline`;
      continue;
    }
    if (candle.symbol && candle.symbol !== input.symbol) {
      return fail(
        `Tatum returned ${candle.symbol} for a ${input.symbol} price claim, so the claim was not checked.`,
        { source: TATUM_OHLCV_SOURCE, symbolMismatch: candle.symbol, deadline: atIso },
      );
    }
    const onOpen = atMs === candle.openTimeMs;
    const field = onOpen ? "open" : "close";
    return {
      ok: true,
      source: TATUM_OHLCV_SOURCE,
      interval,
      ...(interval !== "1h" && fallback ? { intervalFallback: fallback } : {}),
      candle,
      field,
      value: field === "open" ? candle.open : candle.close,
      at: field === "open" ? candle.openTime : candle.closeTime,
    };
  }

  return fail(
    `Tatum did not return a ${input.symbol}/USD candle covering ${atIso}, so the claim was not checked.`,
    {
      source: TATUM_OHLCV_SOURCE,
      symbol: input.symbol,
      quote: "USD",
      deadline: atIso,
      covered: false,
      ...(fallback ? { intervalFallback: fallback } : {}),
    },
  );
}

async function readDaily(
  source: PriceHistorySource,
  input: { symbol: string; direction: "gte" | "lte" },
  fromMs: number,
  toMs: number,
  base: Record<string, unknown>,
  intervalFallback: string,
): Promise<TouchLoad> {
  const daily = await readInterval(source, input.symbol, fromMs, toMs, "1d", DAILY_PAGE_BUDGET);
  if (daily.kind === "unsupported") return unsupported(input.symbol, base);
  if (daily.kind === "mismatch") return mismatch(input.symbol, daily.symbol, base);
  if (daily.kind === "rejected") {
    return fail(
      `Tatum rejected the ${input.symbol}/USD price history request, so the claim was not checked.`,
      { ...base, intervalFallback },
    );
  }
  if (daily.kind === "budget") {
    return fail(
      `Tatum ${input.symbol}/USD daily history was not fully read, so the claim was not checked.`,
      { ...base, interval: "1d", intervalFallback },
    );
  }
  if (daily.candles.length === 0) {
    return fail(
      `Tatum returned no ${input.symbol}/USD candles for the window, so the claim was not checked.`,
      { ...base, intervalFallback },
    );
  }
  return finishTouch(input, "1d", daily.candles, daily.requests, fromMs, toMs, intervalFallback);
}

function finishTouch(
  input: { symbol: string; direction: "gte" | "lte" },
  interval: PriceInterval,
  candles: PriceCandle[],
  requests: number,
  fromMs: number,
  toMs: number,
  intervalFallback?: string,
): TouchLoad {
  const covered = coverWindow(candles, fromMs, toMs, interval);
  if (!covered.ok) {
    return fail(covered.reason, {
      source: TATUM_OHLCV_SOURCE,
      symbol: input.symbol,
      quote: "USD",
      interval,
      ...(intervalFallback ? { intervalFallback } : {}),
      window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      ...covered.evidence,
    });
  }
  const extremes = windowExtremes(covered.candles);
  const extreme = decidingExtreme(covered.candles, input.direction);
  if (!extremes || !extreme) {
    return fail(
      `Tatum returned no ${input.symbol}/USD candles inside the window, so the claim was not checked.`,
      { source: TATUM_OHLCV_SOURCE, interval },
    );
  }
  return {
    ok: true,
    source: TATUM_OHLCV_SOURCE,
    interval,
    ...(intervalFallback ? { intervalFallback } : {}),
    candles: covered.candles,
    boundary: covered.boundary,
    requests,
    maxHigh: extremes.maxHigh,
    minLow: extremes.minLow,
    extreme,
  };
}

type ReadResult =
  | { kind: "candles"; candles: PriceCandle[]; requests: number }
  | { kind: "unsupported" }
  | { kind: "rejected" }
  | { kind: "mismatch"; symbol: string }
  | { kind: "budget" };

async function readInterval(
  source: PriceHistorySource,
  symbol: string,
  fromMs: number,
  toMs: number,
  interval: PriceInterval,
  maxCalls: number,
): Promise<ReadResult> {
  const candles: PriceCandle[] = [];
  const seen = new Set<number>();
  let cursor = fromMs;
  let requests = 0;

  while (cursor < toMs) {
    if (requests >= maxCalls) return { kind: "budget" };
    const remaining = Math.ceil((toMs - cursor) / INTERVAL_MS[interval]) + 1;
    const limit = Math.min(OHLCV_PAGE_SIZE, Math.max(1, remaining));
    let page: PriceCandle[] | undefined;
    try {
      page = await source.page({
        symbol,
        from: new Date(cursor).toISOString(),
        interval,
        limit,
      });
    } catch (err) {
      if (statusCode(err) === 400) return { kind: "rejected" };
      throw err;
    }
    requests += 1;
    if (page === undefined) return { kind: "unsupported" };
    if (page.length === 0) break;

    const fresh = page
      .filter((candle) => candle.openTimeMs >= cursor && !seen.has(candle.openTimeMs))
      .sort((a, b) => a.openTimeMs - b.openTimeMs);
    if (fresh.length === 0) break;
    const foreign = fresh.find((candle) => candle.symbol && candle.symbol !== symbol);
    if (foreign) return { kind: "mismatch", symbol: foreign.symbol };
    if (fresh.some((candle) => !spanMatchesInterval(candle, interval))) return { kind: "rejected" };

    for (const candle of fresh) {
      seen.add(candle.openTimeMs);
      candles.push(candle);
    }
    const last = fresh[fresh.length - 1]!;
    const next = candleEndExclusiveMs(last, interval);
    if (next === null || next <= cursor) break;
    cursor = next;
    if (page.length < limit) break;
  }

  return { kind: "candles", candles, requests };
}

export function coverWindow(
  candles: readonly PriceCandle[],
  fromMs: number,
  toMs: number,
  interval: PriceInterval,
):
  | { ok: true; candles: PriceCandle[]; boundary: WindowBoundary }
  | { ok: false; reason: string; evidence: Record<string, unknown> } {
  const intervalMs = INTERVAL_MS[interval];
  const byOpen = new Map<number, PriceCandle>();
  for (const candle of candles) {
    if (!spanMatchesInterval(candle, interval)) continue;
    const end = candleEndExclusiveMs(candle, interval);
    if (end === null) continue;
    if (!(candle.openTimeMs < toMs && end > fromMs)) continue;
    const prev = byOpen.get(candle.openTimeMs);
    if (prev && (prev.high !== candle.high || prev.low !== candle.low || prev.close !== candle.close)) {
      return {
        ok: false,
        reason: "Tatum returned two different candles for the same time, so the claim was not checked.",
        evidence: { conflictAt: candle.openTime },
      };
    }
    byOpen.set(candle.openTimeMs, candle);
  }

  const used = [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (used.length === 0) {
    return {
      ok: false,
      reason: `Tatum ${interval} history does not cover the window, so the claim was not checked.`,
      evidence: {
        gap: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      },
    };
  }

  const first = used[0]!;
  const startSlack = first.openTimeMs - fromMs;
  if (startSlack > intervalMs) {
    return {
      ok: false,
      reason: `Tatum ${interval} history is missing candles from ${new Date(fromMs).toISOString()} to ${first.openTime}, so the claim was not checked.`,
      evidence: { gap: { from: new Date(fromMs).toISOString(), to: first.openTime } },
    };
  }

  for (let i = 1; i < used.length; i++) {
    const prev = used[i - 1]!;
    const next = used[i]!;
    const prevEnd = candleEndExclusiveMs(prev, interval)!;
    if (next.openTimeMs > prevEnd) {
      return {
        ok: false,
        reason: `Tatum ${interval} history is missing candles from ${new Date(prevEnd).toISOString()} to ${next.openTime}, so the claim was not checked.`,
        evidence: { gap: { from: new Date(prevEnd).toISOString(), to: next.openTime } },
      };
    }
  }

  const last = used[used.length - 1]!;
  const lastEnd = candleEndExclusiveMs(last, interval)!;
  const endSlack = toMs - lastEnd;
  if (endSlack > intervalMs) {
    return {
      ok: false,
      reason: `Tatum ${interval} history is missing candles from ${new Date(lastEnd).toISOString()} to ${new Date(toMs).toISOString()}, so the claim was not checked.`,
      evidence: { gap: { from: new Date(lastEnd).toISOString(), to: new Date(toMs).toISOString() } },
    };
  }

  return {
    ok: true,
    candles: used,
    boundary: {
      uncoveredStartMs: Math.max(0, startSlack),
      uncoveredEndMs: Math.max(0, endSlack),
      leadMs: Math.max(0, fromMs - first.openTimeMs),
      overhangMs: Math.max(0, lastEnd - toMs),
    },
  };
}

function candleCovers(candle: PriceCandle, atMs: number, interval: PriceInterval): boolean {
  const end = candleEndExclusiveMs(candle, interval);
  if (end === null) return false;
  return candle.openTimeMs <= atMs && atMs < end;
}

function mismatch(expected: string, got: string, evidence: Record<string, unknown>): PriceCheckFailure {
  return fail(
    `Tatum returned ${got} for a ${expected} price claim, so the claim was not checked.`,
    { ...evidence, source: TATUM_OHLCV_SOURCE, symbolMismatch: got },
  );
}

function unsupported(symbol: string, evidence: Record<string, unknown>): PriceCheckFailure {
  return fail(
    `The rate feed does not cover ${symbol}/USD; the claim was not checked.`,
    { ...evidence, source: TATUM_OHLCV_SOURCE, symbol, quote: "USD", supported: false },
  );
}

function fail(reason: string, evidence: Record<string, unknown>): PriceCheckFailure {
  return { ok: false, reason, evidence };
}

function statusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
