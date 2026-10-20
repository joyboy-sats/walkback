/**
 * Trust scoring.
 *
 * Deliberately a formula, not a model call. When a judge asks "where does 0.48
 * come from", the answer has to be a number you can recompute from stored
 * verdicts — an LLM's opinion cannot be audited, and a raw hit ratio rewards
 * people who guessed once.
 *
 * We use the Wilson score interval lower bound. Intuition:
 *   1 hit  / 1 claim  → ~0.21   (one lucky guess earns nothing)
 *   4 hits / 5 claims → ~0.38
 *   8 hits / 10       → ~0.49
 *   16 hits/ 20       → ~0.57
 * So a source has to be right *repeatedly* before it clears the promote bar.
 * That is the product thesis, expressed as two lines of arithmetic.
 */

/** z for a 95% interval. */
const Z = 1.96;

/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 * Returns 0 for no observations.
 */
export function wilsonLowerBound(hits: number, total: number): number {
  if (!Number.isFinite(hits) || !Number.isFinite(total)) {
    throw new Error("wilsonLowerBound: non-finite input");
  }
  if (hits < 0 || total < 0 || hits > total) {
    throw new Error(`wilsonLowerBound: impossible counts hits=${hits} total=${total}`);
  }
  if (total === 0) return 0;

  const p = hits / total;
  const n = total;
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denom = 1 + z2 / n;

  const value = (centre - margin) / denom;
  // Floating point can wander a hair outside [0,1].
  return Math.min(1, Math.max(0, value));
}

/** Raw proportion, shown next to the bound so the UI never hides the sample size. */
export function hitRate(hits: number, total: number): number {
  if (total === 0) return 0;
  return hits / total;
}

// ── Thresholds ───────────────────────────────────────────────────────────────
// Kept here so the blog post and the UI quote the same numbers.

/** Below this, a source is muted: its claims stop appearing in the feed. */
export const TRUST_MUTED = 0.4;

/** Above this, a source is promoted and sorts to the top. */
export const TRUST_TRUSTED = 0.55;

/** Minimum adjudicated claims before any verdict is shown. */
export const MIN_SAMPLE = 3;

export type TrustBand = "unknown" | "muted" | "normal" | "trusted";

export function trustBand(score: number, adjudicated: number): TrustBand {
  if (adjudicated < MIN_SAMPLE) return "unknown";
  if (score < TRUST_MUTED) return "muted";
  if (score >= TRUST_TRUSTED) return "trusted";
  return "normal";
}

export interface ScoreSnapshot {
  hits: number;
  misses: number;
  /** hits + misses. Voids are never counted. */
  adjudicated: number;
  score: number;
  hitRate: number;
  band: TrustBand;
}

/** Compute the current score from verdict counts. Pure; no I/O. */
export function computeScore(hits: number, misses: number): ScoreSnapshot {
  const adjudicated = hits + misses;
  const score = wilsonLowerBound(hits, adjudicated);
  return {
    hits,
    misses,
    adjudicated,
    score,
    hitRate: hitRate(hits, adjudicated),
    band: trustBand(score, adjudicated),
  };
}
