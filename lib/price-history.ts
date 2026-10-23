/**
 * Cover a price window with Tatum OHLCV candles.
 *
 * Hourly candles are preferred. Daily candles are used only when hourly
 * cannot be requested: the window would exceed the hourly call budget, the
 * hourly interval is rejected, or hourly returns nothing. A hole inside an
 * hourly series is a void, not a reason to switch to a coarser bucket — a
 * daily high would paper over the missing hour.
 *
 * A touch is strict about the window. A candle whose whole bucket sits inside
 * [from, to) can establish one: its high or low printed in the window, and
 * that decimal is compared to the target without rounding. A candle that
 * overlaps the window but sticks out past `from` or `to` can only refute a
 * touch. Its high and low bound the overlap, and the extreme may have printed
 * outside. When the verdict depends on that partial bucket, or the edge is
 * missing, the overlap is re-read at a finer interval (one minute for an
 * hour, one hour for a day). If the finer series still cannot place the
 * extreme inside the window, or does not cover the slice, the claim is void.
 *
 * The read starts one interval before `from` so the opening hour is present
 * to act as a bound. A candle that merely opens at `to` is not kept: its
 * range is after the deadline.
 */
import {
  DAILY_PAGE_BUDGET,
  HOURLY_PAGE_BUDGET,
  INTERVAL_MS,
  OHLCV_PAGE_SIZE,
  TATUM_OHLCV_SOURCE,
  candleEndExclusiveMs,
  candleHighText,
  candleLowText,
  priceMeets,
  spanMatchesInterval,
  touchIntervalFor,
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
  /** True when an in-window print meets the target. Compared unrounded. */
  touched: boolean;
  maxHigh: PriceExtreme;
  minLow: PriceExtreme;
  /** The print the verdict uses. `bound` means it only limits a partial candle. */
  extreme: PriceExtreme;
  /** Highest high whose bucket is entirely inside the window, when one exists. */
  windowHigh: PriceExtreme | null;
  /** Lowest low whose bucket is entirely inside the window, when one exists. */
  windowLow: PriceExtreme | null;
  /** Max high of every overlapping candle. A partial candle cannot be higher inside the window. */
  highAtMost: PriceExtreme | null;
  /** Min low of every overlapping candle. A partial candle cannot be lower inside the window. */
  lowAtLeast: PriceExtreme | null;
  decidingCandles: DecidingCandle[];
}

export type CandleWindowRole = "interior" | "leading" | "trailing" | "spanning";

export interface DecidingCandle {
  openTime: string;
  closeTime: string;
  high: string;
  low: string;
  role: CandleWindowRole | "refined";
  /** `establishes` meets the target inside the window. `bound` shows the overlap cannot. */
  usedAs: "establishes" | "bound";
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
  input: { symbol: string; from: string; to: string; direction: "gte" | "lte"; threshold: string },
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

  const preferDaily = touchIntervalFor(fromMs, toMs) === "1d";
  if (!preferDaily) {
    const hourly = await readInterval(source, input.symbol, fromMs, toMs, "1h", HOURLY_PAGE_BUDGET);
    if (hourly.kind === "unsupported") return unsupported(input.symbol, base);
    if (hourly.kind === "mismatch") return mismatch(input.symbol, hourly.symbol, base);
    if (hourly.kind === "candles" && hourly.candles.length > 0) {
      return finishTouch(source, input, "1h", hourly.candles, hourly.requests, fromMs, toMs);
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
  input: { symbol: string; direction: "gte" | "lte"; threshold: string },
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
  return finishTouch(source, input, "1d", daily.candles, daily.requests, fromMs, toMs, intervalFallback);
}

async function finishTouch(
  source: PriceHistorySource,
  input: { symbol: string; direction: "gte" | "lte"; threshold: string },
  interval: PriceInterval,
  candles: PriceCandle[],
  requests: number,
  fromMs: number,
  toMs: number,
  intervalFallback?: string,
): Promise<TouchLoad> {
  const covered = coverWindow(candles, fromMs, toMs, interval);
  const base = {
    source: TATUM_OHLCV_SOURCE,
    symbol: input.symbol,
    quote: "USD",
    interval,
    ...(intervalFallback ? { intervalFallback } : {}),
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    threshold: input.threshold,
    priceCompare: "unrounded",
    strictWindow: true,
  };
  if (!covered.ok) {
    return fail(covered.reason, { ...base, ...covered.evidence });
  }
  if (priceMeets(input.threshold, input.threshold, input.direction) === null) {
    return fail(
      `The price threshold "${input.threshold}" is not a decimal, so the claim was not checked.`,
      base,
    );
  }

  let judgment = judgeWindowTouch(covered.candles, fromMs, toMs, interval, input.direction, input.threshold, {
    uncoveredStartMs: covered.boundary.uncoveredStartMs,
    uncoveredEndMs: covered.boundary.uncoveredEndMs,
  });
  let spent = requests;

  if (judgment.unreadable) {
    return fail(
      `A ${input.symbol}/USD candle price was not a decimal, so the claim was not checked.`,
      { ...base, decidingCandles: judgment.decidingCandles },
    );
  }

  if (judgment.ambiguous) {
    const refined = await refineSlices(
      source,
      input,
      interval,
      judgment.slices,
      0,
    );
    spent += refined.requests;
    if (!refined.ok) {
      return fail(refined.reason, {
        ...base,
        ...refined.evidence,
        decidingCandles: judgment.decidingCandles,
        windowHigh: judgment.windowHigh,
        windowLow: judgment.windowLow,
        requests: spent,
      });
    }
    judgment = combineRefinement(judgment, refined.judgment, input.direction);
  }

  if (!judgment.extreme) {
    return fail(
      `Tatum returned no ${input.symbol}/USD candles inside the window, so the claim was not checked.`,
      { ...base, requests: spent },
    );
  }

  const maxHigh = judgment.windowHigh ?? judgment.highAtMost ?? judgment.extreme;
  const minLow = judgment.windowLow ?? judgment.lowAtLeast ?? judgment.extreme;
  return {
    ok: true,
    source: TATUM_OHLCV_SOURCE,
    interval,
    ...(intervalFallback ? { intervalFallback } : {}),
    candles: covered.candles,
    boundary: covered.boundary,
    requests: spent,
    touched: judgment.touched,
    maxHigh,
    minLow,
    extreme: judgment.extreme,
    windowHigh: judgment.windowHigh,
    windowLow: judgment.windowLow,
    highAtMost: judgment.highAtMost,
    lowAtLeast: judgment.lowAtLeast,
    decidingCandles: judgment.decidingCandles,
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
  // One interval early, so the hour (or day) that contains `fromMs` is loaded
  // and can bound the opening slice. The window filter drops anything that
  // ends at or before `fromMs`.
  let cursor = Math.max(0, fromMs - INTERVAL_MS[interval]);
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

export interface TouchSlice {
  fromMs: number;
  toMs: number;
}

export interface WindowTouchJudgment {
  touched: boolean;
  ambiguous: boolean;
  unreadable: boolean;
  slices: TouchSlice[];
  windowHigh: PriceExtreme | null;
  windowLow: PriceExtreme | null;
  highAtMost: PriceExtreme | null;
  lowAtLeast: PriceExtreme | null;
  decidingCandles: DecidingCandle[];
  extreme: PriceExtreme | null;
}

export function candleWindowRole(
  candle: PriceCandle,
  fromMs: number,
  toMs: number,
  interval: PriceInterval,
): CandleWindowRole | "outside" {
  const end = candleEndExclusiveMs(candle, interval);
  if (end === null) return "outside";
  if (!(candle.openTimeMs < toMs && end > fromMs)) return "outside";
  const startsInside = candle.openTimeMs >= fromMs;
  const endsInside = end <= toMs;
  if (startsInside && endsInside) return "interior";
  if (!startsInside && !endsInside) return "spanning";
  if (!startsInside) return "leading";
  return "trailing";
}

/**
 * Decide a touch from candles that already overlap [fromMs, toMs).
 *
 * Interior candles (the whole bucket is inside the window) can establish a
 * touch. A partial candle establishes nothing: if its extreme misses the
 * target, the overlap misses too; if its extreme hits, the hit may be
 * outside and the slice is returned for a finer read.
 */
export function judgeWindowTouch(
  candles: readonly PriceCandle[],
  fromMs: number,
  toMs: number,
  interval: PriceInterval,
  direction: "gte" | "lte",
  threshold: string,
  gaps: { uncoveredStartMs: number; uncoveredEndMs: number },
): WindowTouchJudgment {
  const interior: PriceCandle[] = [];
  const partial: Array<{ candle: PriceCandle; role: Exclude<CandleWindowRole, "interior"> }> = [];
  let unreadable = false;

  for (const candle of candles) {
    const role = candleWindowRole(candle, fromMs, toMs, interval);
    if (role === "outside") continue;
    const hit = candleMeets(candle, direction, threshold);
    if (hit === null) unreadable = true;
    if (role === "interior") interior.push(candle);
    else partial.push({ candle, role });
  }

  const interiorExtremes = windowExtremes(interior);
  const overlapping = [...interior, ...partial.map((item) => item.candle)];
  const overlapExtremes = windowExtremes(overlapping);
  const proven = interior.find((candle) => candleMeets(candle, direction, threshold) === true);

  if (proven && interiorExtremes) {
    const field = direction === "gte" ? "high" : "low";
    const chosen =
      interior.find((candle) => candle.openTime === (field === "high" ? interiorExtremes.maxHigh.at : interiorExtremes.minLow.at)) ??
      proven;
    const establishes = candleMeets(chosen, direction, threshold) === true ? chosen : proven;
    return {
      touched: true,
      ambiguous: false,
      unreadable: false,
      slices: [],
      windowHigh: interiorExtremes.maxHigh,
      windowLow: interiorExtremes.minLow,
      highAtMost: interiorExtremes.maxHigh,
      lowAtLeast: interiorExtremes.minLow,
      decidingCandles: [decidingFrom(establishes, "interior", "establishes")],
      extreme: extremeFrom(establishes, field, false),
    };
  }

  const slices: TouchSlice[] = [];
  const bounding: Array<{ candle: PriceCandle; role: Exclude<CandleWindowRole, "interior"> }> = [];
  for (const item of partial) {
    const hit = candleMeets(item.candle, direction, threshold);
    if (hit === null) continue;
    if (hit) {
      const end = candleEndExclusiveMs(item.candle, interval)!;
      slices.push({ fromMs: Math.max(item.candle.openTimeMs, fromMs), toMs: Math.min(end, toMs) });
    } else {
      bounding.push(item);
    }
  }
  if (gaps.uncoveredStartMs > 0) slices.push({ fromMs, toMs: fromMs + gaps.uncoveredStartMs });
  if (gaps.uncoveredEndMs > 0) slices.push({ fromMs: toMs - gaps.uncoveredEndMs, toMs });
  const merged = mergeSlices(slices);

  if (unreadable || merged.length > 0) {
    return {
      touched: false,
      ambiguous: true,
      unreadable,
      slices: merged,
      windowHigh: interiorExtremes?.maxHigh ?? null,
      windowLow: interiorExtremes?.minLow ?? null,
      highAtMost: overlapExtremes?.maxHigh ? { ...overlapExtremes.maxHigh, bound: true } : null,
      lowAtLeast: overlapExtremes?.minLow ? { ...overlapExtremes.minLow, bound: true } : null,
      decidingCandles: partial
        .filter((item) => candleMeets(item.candle, direction, threshold) === true)
        .map((item) => decidingFrom(item.candle, item.role, "bound")),
      extreme: null,
    };
  }

  const field = direction === "gte" ? "high" : "low";
  const boundExtreme = field === "high" ? overlapExtremes?.maxHigh ?? null : overlapExtremes?.minLow ?? null;
  const boundCandle = boundExtreme ? overlapping.find((candle) => candle.openTime === boundExtreme.at) : undefined;
  const role = boundCandle ? candleWindowRole(boundCandle, fromMs, toMs, interval) : "outside";
  const isBound = role !== "interior";
  return {
    touched: false,
    ambiguous: false,
    unreadable: false,
    slices: [],
    windowHigh: interiorExtremes?.maxHigh ?? null,
    windowLow: interiorExtremes?.minLow ?? null,
    highAtMost: overlapExtremes?.maxHigh ? { ...overlapExtremes.maxHigh, ...(isBound ? { bound: true } : {}) } : null,
    lowAtLeast: overlapExtremes?.minLow ? { ...overlapExtremes.minLow, ...(isBound ? { bound: true } : {}) } : null,
    decidingCandles:
      boundCandle && role !== "outside"
        ? [decidingFrom(boundCandle, role, "bound")]
        : bounding.map((item) => decidingFrom(item.candle, item.role, "bound")),
    extreme: boundExtreme ? { ...boundExtreme, ...(isBound ? { bound: true } : {}) } : null,
  };
}

function finerThan(interval: PriceInterval): PriceInterval | null {
  if (interval === "1d") return "1h";
  if (interval === "1h") return "1m";
  return null;
}

/** Calls allowed while settling one partial bucket. One hour is two minute pages; one day is one hourly page. */
const REFINEMENT_CALLS: Record<PriceInterval, number> = { "1m": 1, "1h": 3, "1d": 2 };

async function refineSlices(
  source: PriceHistorySource,
  input: { symbol: string; direction: "gte" | "lte"; threshold: string },
  coarse: PriceInterval,
  slices: readonly TouchSlice[],
  depth: number,
): Promise<{ ok: true; judgment: WindowTouchJudgment; requests: number } | { ok: false; reason: string; evidence: Record<string, unknown>; requests: number }> {
  const finer = finerThan(coarse);
  if (!finer || depth > 2) {
    return {
      ok: false,
      requests: 0,
      reason:
        "A price at the edge of the window could not be placed inside it, so the claim was not checked.",
      evidence: { timingAmbiguity: true, interval: coarse },
    };
  }

  let requests = 0;
  let touched: WindowTouchJudgment | null = null;
  const misses: WindowTouchJudgment[] = [];

  for (const slice of slices) {
    if (!(slice.toMs > slice.fromMs)) continue;
    const read = await readInterval(
      source,
      input.symbol,
      slice.fromMs,
      slice.toMs,
      finer,
      REFINEMENT_CALLS[finer],
    );
    requests += read.kind === "candles" ? read.requests : read.kind === "budget" ? REFINEMENT_CALLS[finer] : 1;
    if (read.kind !== "candles") {
      return {
        ok: false,
        requests,
        reason: refinementFailure(input.symbol, finer, read.kind),
        evidence: { timingAmbiguity: true, interval: finer, refinement: read.kind },
      };
    }
    const covered = coverWindow(read.candles, slice.fromMs, slice.toMs, finer);
    if (!covered.ok) {
      return {
        ok: false,
        requests,
        reason: covered.reason,
        evidence: { timingAmbiguity: true, interval: finer, ...covered.evidence },
      };
    }
    let judgment = judgeWindowTouch(
      covered.candles,
      slice.fromMs,
      slice.toMs,
      finer,
      input.direction,
      input.threshold,
      covered.boundary,
    );
    if (judgment.unreadable) {
      return {
        ok: false,
        requests,
        reason: `A ${input.symbol}/USD candle price was not a decimal, so the claim was not checked.`,
        evidence: { interval: finer },
      };
    }
    if (judgment.ambiguous) {
      const nested = await refineSlices(source, input, finer, judgment.slices, depth + 1);
      requests += nested.requests;
      if (!nested.ok) return { ...nested, requests };
      judgment = combineRefinement(judgment, nested.judgment, input.direction);
    }
    judgment = {
      ...judgment,
      decidingCandles: judgment.decidingCandles.map((candle) => ({ ...candle, role: "refined" as const })),
    };
    if (judgment.touched) {
      touched = judgment;
      break;
    }
    misses.push(judgment);
  }

  if (touched) return { ok: true, judgment: touched, requests };
  return { ok: true, judgment: foldMisses(misses, input.direction), requests };
}

function combineRefinement(
  parent: WindowTouchJudgment,
  refined: WindowTouchJudgment,
  direction: "gte" | "lte",
): WindowTouchJudgment {
  if (refined.touched) {
    return {
      ...refined,
      windowHigh: laterExtreme(parent.windowHigh, refined.windowHigh, "high"),
      windowLow: laterExtreme(parent.windowLow, refined.windowLow, "low"),
      decidingCandles: [...refined.decidingCandles],
    };
  }
  // The coarse partial candle is replaced by the finer series. Keep only
  // interior prints from the parent; its overlapping high may sit outside.
  return foldMisses([settledParent(parent), refined], direction);
}

/** Interior prints survive refinement. The partial candle that forced the finer read does not. */
function settledParent(parent: WindowTouchJudgment): WindowTouchJudgment {
  return {
    ...parent,
    ambiguous: false,
    touched: false,
    slices: [],
    decidingCandles: [],
    highAtMost: parent.windowHigh,
    lowAtLeast: parent.windowLow,
    extreme: parent.windowHigh ?? parent.windowLow,
  };
}

function foldMisses(parts: readonly WindowTouchJudgment[], direction: "gte" | "lte"): WindowTouchJudgment {
  const usable = parts.filter((part) => part.extreme || part.windowHigh || part.windowLow || part.highAtMost || part.lowAtLeast);
  const windowHigh = usable.reduce<PriceExtreme | null>((acc, part) => laterExtreme(acc, part.windowHigh, "high"), null);
  const windowLow = usable.reduce<PriceExtreme | null>((acc, part) => laterExtreme(acc, part.windowLow, "low"), null);
  const highAtMost = usable.reduce<PriceExtreme | null>(
    (acc, part) => laterExtreme(acc, part.highAtMost ?? part.windowHigh, "high"),
    null,
  );
  const lowAtLeast = usable.reduce<PriceExtreme | null>(
    (acc, part) => laterExtreme(acc, part.lowAtLeast ?? part.windowLow, "low"),
    null,
  );
  const extreme = direction === "gte" ? highAtMost ?? windowHigh : lowAtLeast ?? windowLow;
  return {
    touched: false,
    ambiguous: false,
    unreadable: false,
    slices: [],
    windowHigh,
    windowLow,
    highAtMost,
    lowAtLeast,
    decidingCandles: usable.flatMap((part) => part.decidingCandles),
    extreme,
  };
}

function laterExtreme(
  current: PriceExtreme | null,
  next: PriceExtreme | null,
  field: "high" | "low",
): PriceExtreme | null {
  if (!next) return current;
  if (!current) return next;
  const cmp = priceMeets(next.text, current.text, field === "high" ? "gte" : "lte");
  if (cmp === null) return field === "high" ? (next.value >= current.value ? next : current) : next.value <= current.value ? next : current;
  return cmp ? next : current;
}

function refinementFailure(symbol: string, interval: PriceInterval, kind: string): string {
  if (kind === "budget") {
    return `Tatum ${symbol}/USD ${interval} history for the window edge was not fully read, so the claim was not checked.`;
  }
  return `Tatum could not place the ${symbol}/USD price inside the window edge (${interval}), so the claim was not checked.`;
}

function candleMeets(candle: PriceCandle, direction: "gte" | "lte", threshold: string): boolean | null {
  const text = direction === "gte" ? candleHighText(candle) : candleLowText(candle);
  return priceMeets(text, threshold, direction);
}

function extremeFrom(candle: PriceCandle, field: "high" | "low", bound: boolean): PriceExtreme {
  const text = field === "high" ? candleHighText(candle) : candleLowText(candle);
  return {
    value: field === "high" ? candle.high : candle.low,
    text,
    at: candle.openTime,
    field,
    candleClose: candle.closeTime,
    ...(bound ? { bound: true } : {}),
  };
}

function decidingFrom(candle: PriceCandle, role: CandleWindowRole, usedAs: DecidingCandle["usedAs"]): DecidingCandle {
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    high: candleHighText(candle),
    low: candleLowText(candle),
    role,
    usedAs,
  };
}

function mergeSlices(slices: readonly TouchSlice[]): TouchSlice[] {
  const sorted = slices.filter((slice) => slice.toMs > slice.fromMs).sort((a, b) => a.fromMs - b.fromMs);
  const out: TouchSlice[] = [];
  for (const slice of sorted) {
    const last = out[out.length - 1];
    if (last && slice.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, slice.toMs);
    else out.push({ ...slice });
  }
  return out;
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
