/**
 * Per-category trust.
 *
 * One Wilson score was mixing two jobs. `tx_replay` and the balance claims
 * restate something that already happened. `price_threshold` is a forecast.
 * A source can be a perfect reporter and a bad forecaster. Those are separate
 * samples. Each uses the same Wilson lower bound, the same mute (0.4) and
 * trusted (0.55) cuts, and the same rule that n < 3 is `unknown` and not muted.
 * `manual` is neither category. Adjudication always voids it, so it never
 * counts in the overall record or in either category.
 *
 * Mute rule: `forecast-primary`.
 * When a source has at least one true or false price verdict, the feed hides
 * them only if that forecast record is muted. Otherwise the feed follows the
 * reporting record. A reporter with no forecasts stays on the reporting
 * record, so a perfect replay log is not presented as forecasting skill.
 * A source that has started forecasting is judged on forecasts alone: a strong
 * reporting record does not keep a bad forecaster in the feed, and one
 * reporting miss does not hide a good forecaster. n < 3 in the chosen
 * category has band `unknown`, not muted. The UI may say "Not yet rated".
 */
import { computeScore, type ScoreSnapshot, type TrustBand } from "./score";
import type { Outcome } from "./types";

export const MUTE_RULE = "forecast-primary" as const;

export type ScoreCategory = "reporting" | "forecast";

export type MuteBasis = ScoreCategory;

/** Reporting restates chain events. Forecast is a price call. Manual is neither. */
export function scoreCategory(claimType: string): ScoreCategory | null {
  if (
    claimType === "tx_replay" ||
    claimType === "balance_threshold" ||
    claimType === "balance_change_since_ingest"
  ) {
    return "reporting";
  }
  if (claimType === "price_threshold") return "forecast";
  return null;
}

export interface CategoryScore {
  hits: number;
  misses: number;
  /** hits + misses. Voids are not included. */
  n: number;
  /** Wilson score interval lower bound. */
  score: number;
  band: TrustBand;
}

export interface CategoryCounts {
  reportingHits: number;
  reportingMisses: number;
  forecastHits: number;
  forecastMisses: number;
}

export interface FoldedCategories {
  overall: CategoryScore;
  reporting: CategoryScore;
  forecast: CategoryScore;
  muteBasis: MuteBasis;
  /** Band, mute, and the score the existing feed meter reads. */
  basis: CategoryScore;
  muted: boolean;
}

export function categoryScore(hits: number, misses: number): CategoryScore {
  const snap = computeScore(hits, misses);
  return { hits: snap.hits, misses: snap.misses, n: snap.adjudicated, score: snap.score, band: snap.band };
}

export function categoryScoreFromSnapshot(snap: ScoreSnapshot): CategoryScore {
  return categoryScore(snap.hits, snap.misses);
}

export function emptyCategoryCounts(): CategoryCounts {
  return { reportingHits: 0, reportingMisses: 0, forecastHits: 0, forecastMisses: 0 };
}

function isOutcome(value: unknown): value is Outcome {
  return value === "true" || value === "false" || value === "void";
}

export interface CategoryVerdictRow {
  claimId?: unknown;
  claimType?: unknown;
  outcome?: unknown;
  resolvedAt?: unknown;
}

function rowTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Latest true/false/void per claim.
 * Returns null when a row is not a verdict (the resolve tests' placeholder
 * select). An empty list is a real zero, not a failure.
 */
export function tallyCategories(
  rows: readonly object[],
  pending?: { claimId: string; claimType: string; outcome: Outcome } | null,
): CategoryCounts | null {
  for (const row of rows) {
    const verdict = row as CategoryVerdictRow;
    if (typeof verdict.claimType !== "string" || !isOutcome(verdict.outcome)) return null;
  }

  const byClaim = new Map<string, { claimType: string; outcome: Outcome; at: number }>();
  const anonymous: Array<{ claimType: string; outcome: Outcome }> = [];
  for (const item of rows) {
    const row = item as CategoryVerdictRow;
    const claimType = row.claimType as string;
    const outcome = row.outcome as Outcome;
    if (typeof row.claimId === "string" && row.claimId.length > 0) {
      const at = rowTime(row.resolvedAt);
      const prev = byClaim.get(row.claimId);
      if (!prev || at >= prev.at) byClaim.set(row.claimId, { claimType, outcome, at });
    } else {
      anonymous.push({ claimType, outcome });
    }
  }

  let folded = [...byClaim.entries()].map(([claimId, row]) => ({ claimId, ...row }));
  if (pending) {
    folded = folded.filter((row) => row.claimId !== pending.claimId);
    folded.push({ claimId: pending.claimId, claimType: pending.claimType, outcome: pending.outcome, at: Number.MAX_SAFE_INTEGER });
  }

  const counts = emptyCategoryCounts();
  const add = (claimType: string, outcome: Outcome) => {
    if (outcome === "void") return;
    const category = scoreCategory(claimType);
    if (category === "reporting") {
      if (outcome === "true") counts.reportingHits += 1;
      else counts.reportingMisses += 1;
    } else if (category === "forecast") {
      if (outcome === "true") counts.forecastHits += 1;
      else counts.forecastMisses += 1;
    }
  };
  for (const row of folded) add(row.claimType, row.outcome);
  for (const row of anonymous) add(row.claimType, row.outcome);
  return counts;
}

/**
 * Forecast-primary mute basis.
 *
 * Any true or false price verdict selects the forecast record, including when
 * that record is still under 3 and its band is `unknown`. A band of `unknown`
 * is not a reason to fall back to reporting. Reporting is the basis only when
 * the forecast sample is empty.
 */
export function muteBasisFor(forecastAdjudicated: number): MuteBasis {
  return forecastAdjudicated > 0 ? "forecast" : "reporting";
}

export function foldCategories(counts: CategoryCounts, overallHits: number, overallMisses: number): FoldedCategories {
  const reporting = categoryScore(counts.reportingHits, counts.reportingMisses);
  const forecast = categoryScore(counts.forecastHits, counts.forecastMisses);
  const muteBasis = muteBasisFor(forecast.n);
  const basis = muteBasis === "forecast" ? forecast : reporting;
  return {
    overall: categoryScore(overallHits, overallMisses),
    reporting,
    forecast,
    muteBasis,
    basis,
    muted: basis.band === "muted",
  };
}

export function foldVerdicts(
  rows: readonly { claimType: string; outcome: Outcome }[],
): FoldedCategories {
  let hits = 0;
  let misses = 0;
  const counts = emptyCategoryCounts();
  for (const row of rows) {
    if (row.outcome === "void") continue;
    if (row.outcome === "true") hits += 1;
    else misses += 1;
    const category = scoreCategory(row.claimType);
    if (category === "reporting") {
      if (row.outcome === "true") counts.reportingHits += 1;
      else counts.reportingMisses += 1;
    } else if (category === "forecast") {
      if (row.outcome === "true") counts.forecastHits += 1;
      else counts.forecastMisses += 1;
    }
  }
  return foldCategories(counts, hits, misses);
}
