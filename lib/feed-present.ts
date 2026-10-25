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

/** A line needs two stored prints. One candle, or a window high on another day, is not a series. */
export function pricePath(detail: ClaimDetail | null | undefined): PricePath | null {
  const candles = detail?.actual?.decidingCandles ?? [];
  const points: PricePoint[] = [];
  for (const candle of candles) {
    const value = candleValue(candle, detail?.parsed.priceBasis ?? null);
    if (value === null) continue;
    points.push({ at: candle.openTime, value });
  }
  if (points.length < 2) return null;
  const targetRaw = detail?.parsed.target;
  const target = targetRaw != null && Number.isFinite(Number(targetRaw)) ? Number(targetRaw) : null;
  return { points, target };
}

/** Drop padding zeros on a stored decimal such as 0.85750000. Short targets such as 1.0 stay as stored. */
export function displayDecimal(value: string): string {
  if (!/^\d+\.\d{5,}$/.test(value)) return value;
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export interface ShownPrint {
  value: string;
  at: string | null;
  field: "high" | "low" | "close" | null;
  /** True when the stored extreme only bounds a candle that sticks out of the window. */
  bound: boolean;
}

/**
 * The print to show next to the target.
 * A bound extreme may have printed outside the window, so an in-window
 * window high or low replaces it when one was stored.
 */
export function shownActual(detail: ClaimDetail | null | undefined): ShownPrint | null {
  const actual = detail?.actual;
  if (!actual) return null;
  const basis = detail?.parsed.priceBasis;
  const inWindow = basis === "low" ? actual.windowLow : actual.windowHigh;
  const extreme = actual.extreme;
  if (extreme?.bound === true && inWindow?.value) {
    return {
      value: inWindow.value,
      at: inWindow.at,
      field: inWindow.field ?? (basis === "low" ? "low" : "high"),
      bound: false,
    };
  }
  if (extreme?.value) {
    return {
      value: extreme.value,
      at: extreme.at,
      field: extreme.field,
      bound: extreme.bound === true,
    };
  }
  if (inWindow?.value) {
    return { value: inWindow.value, at: inWindow.at, field: inWindow.field, bound: false };
  }
  return null;
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
