/**
 * Tatum OHLCV candles and the price-claim fields stored on a claim.
 *
 * The wire body is the `HistoricalPrice` object from
 * GET /v4/data/rate/symbol/OHLCV (and each element of the batch endpoint).
 * Prices arrive as decimal strings. `closeTime` in Tatum's published example
 * is the last millisecond of the bucket (open + interval − 1). Some payloads
 * use an exclusive end (open + interval). Both are accepted. A timestamp is
 * inside a candle when open ≤ t < exclusive end.
 */
import type { Direction, PriceEvaluation, PriceThresholdParams } from "./types";

/**
 * A touch starts with daily candles. Hourly candles are read only for a
 * boundary day whose extreme reaches the target or whose coverage is missing.
 * One-minute candles settle a boundary hour the same way. They are not a
 * second pass over the whole window.
 */
export const PRICE_INTERVALS = ["1m", "1h", "1d"] as const;
export type PriceInterval = (typeof PRICE_INTERVALS)[number];

export const INTERVAL_MS: Record<PriceInterval, number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/** 50 candles per batch call. 20 calls cover about 41 days of hours. */
export const OHLCV_PAGE_SIZE = 50;
export const HOURLY_PAGE_BUDGET = 20;
export const DAILY_PAGE_BUDGET = 12;

/** Tatum credits. A single OHLCV candle is 50; a batch of up to 50 is 500. */
export const OHLCV_SINGLE_CREDITS = 50;
export const OHLCV_BATCH_CREDITS = 500;
/**
 * Batch calls allowed while refining one partial bucket.
 * A boundary day is at most 24 hourly candles, one page, with one spare.
 * A boundary hour is at most 60 minute candles, two pages.
 */
export const REFINEMENT_BATCH_CAP = { "1h": 2, "1m": 2 } as const;

export const TATUM_OHLCV_SOURCE = "tatum:/v4/data/rate/symbol/OHLCV";

export interface PriceCandle {
  symbol: string;
  openTimeMs: number;
  closeTimeMs: number;
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Decimal text the comparison uses. Wire payloads keep the original string,
   * so a later display rounding cannot move a verdict.
   */
  highText?: string;
  lowText?: string;
}

export function hourlyPagesFor(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 1;
  const candles = Math.ceil(spanMs / INTERVAL_MS["1h"]) + 1;
  return Math.ceil(candles / OHLCV_PAGE_SIZE);
}

/**
 * Batch calls for a dense series over [fromMs, toMs], including the candle
 * that opens up to one interval before `fromMs`. That lead candle is how a
 * partial first hour gets a bound without a one-minute fetch.
 *
 * The advance matches `readInterval`: each call asks for up to 50 candles and
 * the next call starts where a full page of contiguous buckets would end.
 */
export function denseBatchCalls(fromMs: number, toMs: number, interval: PriceInterval): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return 0;
  const step = INTERVAL_MS[interval];
  let cursor = fromMs - step;
  let calls = 0;
  while (cursor < toMs && calls <= HOURLY_PAGE_BUDGET + DAILY_PAGE_BUDGET) {
    calls += 1;
    const remaining = Math.ceil((toMs - cursor) / step) + 1;
    const limit = Math.min(OHLCV_PAGE_SIZE, Math.max(1, remaining));
    cursor += limit * step;
  }
  return calls;
}

/**
 * The partial bucket at each end of [fromMs, toMs), when that end is not on
 * an interval boundary. A window that sits inside one bucket is one slice.
 */
export function boundarySlices(
  fromMs: number,
  toMs: number,
  interval: PriceInterval,
): Array<{ fromMs: number; toMs: number }> {
  const step = INTERVAL_MS[interval];
  if (!(toMs > fromMs) || step <= 0) return [];
  const slices: Array<{ fromMs: number; toMs: number }> = [];
  if (fromMs % step !== 0) {
    const bucketEnd = fromMs - (fromMs % step) + step;
    const sliceTo = Math.min(toMs, bucketEnd);
    if (sliceTo > fromMs) slices.push({ fromMs, toMs: sliceTo });
  }
  if (toMs % step !== 0) {
    const bucketStart = toMs - (toMs % step);
    const sliceFrom = Math.max(fromMs, bucketStart);
    const duplicate = slices.some((slice) => slice.fromMs === sliceFrom && slice.toMs === toMs);
    if (!duplicate && toMs > sliceFrom) slices.push({ fromMs: sliceFrom, toMs });
  }
  return slices;
}

/**
 * Credits for one touch window. Expected is the daily read: one 50-candle
 * batch covers a window of about seven weeks. Worst case also refines each
 * boundary day to hours and each boundary hour to minutes, which happens
 * only when that partial extreme reaches the target or the edge is missing.
 */
export function touchCreditPlan(fromMs: number, toMs: number): { expectedBatches: number; worstBatches: number } {
  const expectedBatches = denseBatchCalls(fromMs, toMs, "1d");
  let worstBatches = expectedBatches;
  for (const day of boundarySlices(fromMs, toMs, "1d")) {
    worstBatches += Math.min(REFINEMENT_BATCH_CAP["1h"], denseBatchCalls(day.fromMs, day.toMs, "1h"));
    for (const hour of boundarySlices(day.fromMs, day.toMs, "1h")) {
      worstBatches += Math.min(REFINEMENT_BATCH_CAP["1m"], denseBatchCalls(hour.fromMs, hour.toMs, "1m"));
    }
  }
  return { expectedBatches, worstBatches };
}

const usage = { singles: 0, batches: 0 };

/** Count one live OHLCV HTTP call. Replay fixtures do not call this. */
export function noteOhlcvRequest(kind: "single" | "batch"): void {
  if (kind === "single") usage.singles += 1;
  else usage.batches += 1;
}

export function ohlcvCreditUsage(): { singles: number; batches: number; credits: number } {
  return {
    singles: usage.singles,
    batches: usage.batches,
    credits: usage.singles * OHLCV_SINGLE_CREDITS + usage.batches * OHLCV_BATCH_CREDITS,
  };
}

export function resetOhlcvCreditUsage(): void {
  usage.singles = 0;
  usage.batches = 0;
}

/**
 * Compare two non-negative decimal strings without rounding.
 * "1.10" and "1.1" are equal. "0.9980" is below "1". Returns null when
 * either side is not a plain decimal.
 */
export function cmpDecimal(a: string, b: string): -1 | 0 | 1 | null {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  if (!left || !right) return null;
  const scale = Math.max(left.frac.length, right.frac.length);
  const av = left.whole * 10n ** BigInt(scale) + BigInt(left.frac.padEnd(scale, "0") || "0");
  const bv = right.whole * 10n ** BigInt(scale) + BigInt(right.frac.padEnd(scale, "0") || "0");
  if (av === bv) return 0;
  return av > bv ? 1 : -1;
}

/** True when `actual` meets `threshold`. Null when either decimal is unusable. */
export function priceMeets(actual: string, threshold: string, direction: "gte" | "lte"): boolean | null {
  const cmp = cmpDecimal(actual, threshold);
  if (cmp === null) return null;
  return direction === "gte" ? cmp >= 0 : cmp <= 0;
}

/** Decimal text for a number that did not arrive as a string. No fixed-place rounding. */
export function priceText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  const text = Object.is(value, -0) ? "0" : value.toString();
  if (!/[eE]/.test(text)) return text;
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

export function candleHighText(candle: { high: number; highText?: string }): string {
  return candle.highText ?? priceText(candle.high);
}

export function candleLowText(candle: { low: number; lowText?: string }): string {
  return candle.lowText ?? priceText(candle.low);
}

function cmpCandleField(a: PriceCandle, b: PriceCandle, field: "high" | "low"): number {
  const left = field === "high" ? candleHighText(a) : candleLowText(a);
  const right = field === "high" ? candleHighText(b) : candleLowText(b);
  return cmpDecimal(left, right) ?? a[field] - b[field];
}

function splitDecimal(value: string): { whole: bigint; frac: string } | null {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return { whole: BigInt(whole!), frac };
}

/** Exclusive end of the bucket, or null when the span is not the requested interval. */
export function candleEndExclusiveMs(candle: PriceCandle, interval: PriceInterval): number | null {
  const expected = INTERVAL_MS[interval];
  const delta = candle.closeTimeMs - candle.openTimeMs;
  if (delta === expected - 1) return candle.closeTimeMs + 1;
  if (delta === expected) return candle.closeTimeMs;
  return null;
}

export function spanMatchesInterval(candle: PriceCandle, interval: PriceInterval): boolean {
  return candleEndExclusiveMs(candle, interval) !== null;
}

/** True when `atMs` falls inside the bucket. The exclusive end belongs to the next candle. */
export function candleCoversInstant(candle: PriceCandle, atMs: number, interval: PriceInterval): boolean {
  const end = candleEndExclusiveMs(candle, interval);
  if (end === null) return false;
  return candle.openTimeMs <= atMs && atMs < end;
}

/**
 * Parse one Tatum `HistoricalPrice` object. Returns null when a field needed
 * for a verdict is missing or not a price. Extra wire fields are ignored.
 */
export function parseTatumCandle(raw: unknown): PriceCandle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const openTimeMs = asMs(body.openTime);
  const closeTimeMs = asMs(body.closeTime);
  const open = asPrice(body.open);
  const high = asPriceField(body.high);
  const low = asPriceField(body.low);
  const close = asPrice(body.close);
  if (
    openTimeMs === null ||
    closeTimeMs === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null
  ) {
    return null;
  }
  if (closeTimeMs < openTimeMs) return null;
  if (high.value < low.value) return null;
  if (open < low.value || open > high.value || close < low.value || close > high.value) return null;
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  return {
    symbol,
    openTimeMs,
    closeTimeMs,
    openTime: new Date(openTimeMs).toISOString(),
    closeTime: new Date(closeTimeMs).toISOString(),
    open,
    high: high.value,
    low: low.value,
    close,
    highText: high.text,
    lowText: low.text,
  };
}

export function parseTatumCandles(raw: unknown): PriceCandle[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PriceCandle[] = [];
  for (const item of raw) {
    const candle = parseTatumCandle(item);
    if (!candle) return null;
    out.push(candle);
  }
  return out;
}

export interface PriceExtreme {
  value: number;
  /** Decimal compared to the target. Not rounded for display. */
  text: string;
  /** Candle open, the start of the bucket that printed this extreme. */
  at: string;
  field: "high" | "low";
  candleClose: string;
  /**
   * True when the bucket sticks out of the window. The value is then a bound
   * (the in-window print is no further than this), not a print we can place
   * inside the window.
   */
  bound?: boolean;
}

export function windowExtremes(candles: readonly PriceCandle[]): {
  maxHigh: PriceExtreme;
  minLow: PriceExtreme;
} | null {
  if (candles.length === 0) return null;
  let max = candles[0]!;
  let min = candles[0]!;
  for (const candle of candles) {
    const highCmp = cmpCandleField(candle, max, "high");
    if (highCmp > 0 || (highCmp === 0 && candle.openTimeMs < max.openTimeMs)) max = candle;
    const lowCmp = cmpCandleField(candle, min, "low");
    if (lowCmp < 0 || (lowCmp === 0 && candle.openTimeMs < min.openTimeMs)) min = candle;
  }
  return {
    maxHigh: {
      value: max.high,
      text: candleHighText(max),
      at: max.openTime,
      field: "high",
      candleClose: max.closeTime,
    },
    minLow: {
      value: min.low,
      text: candleLowText(min),
      at: min.openTime,
      field: "low",
      candleClose: min.closeTime,
    },
  };
}

export function decidingExtreme(
  candles: readonly PriceCandle[],
  direction: Direction,
): PriceExtreme | null {
  const extremes = windowExtremes(candles);
  if (!extremes) return null;
  return direction === "gte" ? extremes.maxHigh : extremes.minLow;
}

/**
 * Build price params from extractor or seed output.
 *
 * A touch window always starts at `publishedAt` when that is a real timestamp.
 * The model is not allowed to invent a different start. Unknown evaluation
 * strings are rejected. An omitted evaluation is left unset so older stored
 * rows still parse; callers that want an explicit value set it themselves.
 */
export function priceParamsFromRaw(input: {
  symbol?: string;
  quote?: string;
  direction?: Direction;
  amount?: string;
  evaluation?: string;
  since?: string;
  publishedAt?: string;
}): PriceThresholdParams | null {
  const symbol = input.symbol?.trim();
  const amount = input.amount?.trim();
  if (!symbol || !amount || !input.direction || !Number.isFinite(Number(amount))) return null;

  const rawEvaluation = input.evaluation?.trim() ?? "";
  let evaluation: PriceEvaluation | undefined;
  if (rawEvaluation === "") evaluation = undefined;
  else if (rawEvaluation === "touch" || rawEvaluation === "at_deadline") evaluation = rawEvaluation;
  else return null;

  const publishedAt = isoOrUndefined(input.publishedAt);
  const sinceFromRaw = isoOrUndefined(input.since);
  const since = evaluation === "touch" ? publishedAt ?? sinceFromRaw : undefined;
  if (evaluation === "touch" && !since) return null;

  return {
    symbol: symbol.toUpperCase(),
    quote: (input.quote?.trim() || "USD").toUpperCase(),
    direction: input.direction,
    amount,
    ...(evaluation ? { evaluation } : {}),
    ...(since ? { since } : {}),
  };
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 1e8) / 1e8;
  return rounded.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function asMs(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function asPrice(value: unknown): number | null {
  return asPriceField(value)?.value ?? null;
}

function asPriceField(value: unknown): { value: number; text: string } | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return { value: n, text };
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { value, text: priceText(value) };
  }
  return null;
}
