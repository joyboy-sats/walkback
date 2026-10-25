/**
 * Homepage presentation over the feed and ledger payloads.
 *
 * Pure. No network. A chart is drawn only from stored deciding candles.
 * Fewer than two finite points is not a path, so the caller shows the
 * stored expected and actual numbers instead.
 */
import type { ClaimDetail, DecidingCandleView } from "./claim-view";
import { visibleClaims, type LedgerSource } from "./ledger";

export interface HeroClaimRow {
  claim: {
    id: string;
    claimType: string;
    resolution?: { outcome: string } | null;
    detail?: ClaimDetail | null;
  };
  source: { id: string; handle: string };
}

export function heroSource(sources: readonly LedgerSource[]): LedgerSource | null {
  const withMisses = sources.filter((source) => (source.forecast?.misses ?? 0) > 0);
  const muted = withMisses.filter((source) => source.muted);
  const pool = muted.length > 0 ? muted : withMisses;
  const ranked = [...pool].sort((a, b) => {
    const misses = (b.forecast?.misses ?? 0) - (a.forecast?.misses ?? 0);
    if (misses !== 0) return misses;
    const n = (b.forecast?.n ?? 0) - (a.forecast?.n ?? 0);
    if (n !== 0) return n;
    return a.handle.localeCompare(b.handle);
  });
  return ranked[0] ?? null;
}

export function heroClaim<T extends HeroClaimRow>(rows: readonly T[], handle: string): T | null {
  const mine = rows.filter(
    (row) =>
      row.source.handle === handle &&
      row.claim.claimType === "price_threshold" &&
      row.claim.resolution?.outcome === "false" &&
      row.claim.detail != null,
  );
  mine.sort((a, b) => {
    const candles = (b.claim.detail?.actual?.decidingCandles.length ?? 0) - (a.claim.detail?.actual?.decidingCandles.length ?? 0);
    if (candles !== 0) return candles;
    return a.claim.id.localeCompare(b.claim.id);
  });
  return mine[0] ?? null;
}

export interface PricePoint {
  at: string;
  value: number;
}

export interface PricePath {
  points: PricePoint[];
  target: number | null;
}

function candleValue(candle: DecidingCandleView, basis: ClaimDetail["parsed"]["priceBasis"]): number | null {
  const raw = basis === "low" ? candle.low : candle.high;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const NOMINAL_SPANS_MS = [60_000, 3_600_000, 86_400_000];

/**
 * Open-to-close length, snapped to a minute, hour, or day when the stored
 * close is within a second of that length. A candle that ends 1ms early is
 * still a daily candle. Other lengths stay distinct.
 */
function candleSpanMs(candle: DecidingCandleView): number | null {
  const open = Date.parse(candle.openTime);
  const close = Date.parse(candle.closeTime);
  if (Number.isNaN(open) || Number.isNaN(close) || close <= open) return null;
  const span = close - open;
  for (const nominal of NOMINAL_SPANS_MS) {
    if (Math.abs(span - nominal) <= 1000) return nominal;
  }
  return span;
}

/**
 * A line needs two stored prints of one granularity.
 * One candle is not a series. Daily and hourly candles are not connected.
 * When more than one granularity has two prints, the larger set is used;
 * a tie keeps the shorter candles.
 */
export function pricePath(detail: ClaimDetail | null | undefined): PricePath | null {
  const candles = detail?.actual?.decidingCandles ?? [];
  const bySpan = new Map<number, DecidingCandleView[]>();
  for (const candle of candles) {
    const span = candleSpanMs(candle);
    if (span === null) continue;
    const list = bySpan.get(span) ?? [];
    list.push(candle);
    bySpan.set(span, list);
  }
  let chosen: DecidingCandleView[] | null = null;
  let chosenSpan = Number.POSITIVE_INFINITY;
  let chosenCount = 0;
  for (const [span, list] of bySpan) {
    const count = list.filter((candle) => candleValue(candle, detail?.parsed.priceBasis ?? null) !== null).length;
    if (count < 2) continue;
    if (count > chosenCount || (count === chosenCount && span < chosenSpan)) {
      chosen = list;
      chosenSpan = span;
      chosenCount = count;
    }
  }
  if (!chosen) return null;
  const points: PricePoint[] = [];
  for (const candle of chosen) {
    const value = candleValue(candle, detail?.parsed.priceBasis ?? null);
    if (value === null) continue;
    points.push({ at: candle.openTime, value });
  }
  if (points.length < 2) return null;
  const targetRaw = detail?.parsed.target;
  const target = targetRaw != null && Number.isFinite(Number(targetRaw)) ? Number(targetRaw) : null;
  return { points, target };
}

/** 0 at the earliest stored time, 1 at the latest. Equal times sit in the middle. */
export function timeFraction(at: string, points: readonly { at: string }[]): number {
  const times = points.map((point) => Date.parse(point.at)).filter((time) => !Number.isNaN(time));
  const time = Date.parse(at);
  if (times.length === 0 || Number.isNaN(time)) return 0;
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  if (latest === earliest) return 0.5;
  return (time - earliest) / (latest - earliest);
}

/** Drop padding zeros on a stored decimal such as 0.85750000. Short targets such as 1.0 stay as stored. */
export function displayDecimal(value: string): string {
  if (!/^\d+\.\d{5,}$/.test(value)) return value;
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export interface StoredPrint {
  value: string;
  at: string | null;
}

export interface ShownActual {
  field: "high" | "low" | "close" | null;
  /**
   * A print inside the window that can be stated as reached.
   * Null when the stored extreme is only a bound on a boundary day.
   */
  reached: StoredPrint | null;
  /** Cap from a candle that sticks out of the window. Not a price that printed inside it. */
  bound: StoredPrint | null;
  /** Highest or lowest full day inside the window, stored beside a bound. */
  inWindow: StoredPrint | null;
}

function printOf(value: string | null | undefined, at: string | null | undefined): StoredPrint | null {
  if (!value) return null;
  return { value, at: at ?? null };
}

/**
 * What to say about the stored price.
 * A bound extreme is a cap on a boundary day, not "the high reached" the
 * lower in-window day. Both numbers are returned when both were stored.
 */
export function shownActual(detail: ClaimDetail | null | undefined): ShownActual | null {
  const actual = detail?.actual;
  if (!actual) return null;
  const basis = detail?.parsed.priceBasis;
  const inWindowExtreme = basis === "low" ? actual.windowLow : actual.windowHigh;
  const extreme = actual.extreme;
  const field = extreme?.field ?? inWindowExtreme?.field ?? (basis === "low" || basis === "high" || basis === "close" ? basis : null);
  if (extreme?.bound === true && extreme.value) {
    return {
      field,
      reached: null,
      bound: printOf(extreme.value, extreme.at),
      inWindow: printOf(inWindowExtreme?.value, inWindowExtreme?.at),
    };
  }
  if (extreme?.value) {
    return { field, reached: printOf(extreme.value, extreme.at), bound: null, inWindow: null };
  }
  const inside = printOf(inWindowExtreme?.value, inWindowExtreme?.at);
  if (!inside) return null;
  return { field, reached: inside, bound: null, inWindow: null };
}

export interface FeedGroup<T extends { source: { id: string; muted: boolean } }> {
  source: T["source"];
  rows: T[];
}

export function groupFeed<T extends { source: { id: string; muted: boolean } }>(
  rows: readonly T[],
  includeMuted: boolean,
): FeedGroup<T>[] {
  const { visible } = visibleClaims(rows, includeMuted);
  const groups: FeedGroup<T>[] = [];
  const index = new Map<string, FeedGroup<T>>();
  for (const row of visible) {
    const existing = index.get(row.source.id);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group: FeedGroup<T> = { source: row.source, rows: [row] };
    index.set(row.source.id, group);
    groups.push(group);
  }
  return groups;
}
