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

/** Hourly is the preferred bucket. Daily is the fallback when hourly cannot cover the window. */
export const PRICE_INTERVALS = ["1h", "1d"] as const;
export type PriceInterval = (typeof PRICE_INTERVALS)[number];

export const INTERVAL_MS: Record<PriceInterval, number> = {
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/** 50 candles per batch call. 20 calls cover about 41 days of hours. */
export const OHLCV_PAGE_SIZE = 50;
export const HOURLY_PAGE_BUDGET = 20;
export const DAILY_PAGE_BUDGET = 12;

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
}

export function hourlyPagesFor(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 1;
  const candles = Math.ceil(spanMs / INTERVAL_MS["1h"]) + 1;
  return Math.ceil(candles / OHLCV_PAGE_SIZE);
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
  const high = asPrice(body.high);
  const low = asPrice(body.low);
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
  if (high < low) return null;
  if (open < low || open > high || close < low || close > high) return null;
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  return {
    symbol,
    openTimeMs,
    closeTimeMs,
    openTime: new Date(openTimeMs).toISOString(),
    closeTime: new Date(closeTimeMs).toISOString(),
    open,
    high,
    low,
    close,
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
  /** Candle open, the start of the bucket that printed this extreme. */
  at: string;
  field: "high" | "low";
  candleClose: string;
}

export function windowExtremes(candles: readonly PriceCandle[]): {
  maxHigh: PriceExtreme;
  minLow: PriceExtreme;
} | null {
  if (candles.length === 0) return null;
  let max = candles[0]!;
  let min = candles[0]!;
  for (const candle of candles) {
    if (candle.high > max.high || (candle.high === max.high && candle.openTimeMs < max.openTimeMs)) max = candle;
    if (candle.low < min.low || (candle.low === min.low && candle.openTimeMs < min.openTimeMs)) min = candle;
  }
  return {
    maxHigh: { value: max.high, at: max.openTime, field: "high", candleClose: max.closeTime },
    minLow: { value: min.low, at: min.openTime, field: "low", candleClose: min.closeTime },
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
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
