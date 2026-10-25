/**
 * Structured evidence for a resolved claim, read from what is already stored.
 *
 * Nothing here calls Tatum or Walrus. A field that is not in the claim params,
 * the deadline basis, or the resolution evidence is null.
 *
 * Walrus `url` is null. This repo has no public mainnet aggregator URL for a
 * Memory blob. The relayer is not a public gateway, and a guessed URL would
 * be a fabricated link. The blob id is the full id.
 */
import { ignoredCondition } from "./condition";
import type { Outcome } from "./types";

/** Public Sui mainnet transaction page. Digests that are not base58 are returned without a URL. */
export const SUISCAN_TX_PREFIX = "https://suiscan.xyz/mainnet/tx/";

const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export interface ClaimViewInput {
  id: string;
  quote: string;
  claimType: string;
  status: string;
  params: unknown;
  deadline: string | null;
  deadlineBasis: string | null;
  claimBlobId: string | null;
  /**
   * When the post was published. Null when neither the claim row nor the seed
   * file has that time. This is never `params.since`.
   */
  publishedAt?: string | null;
  resolution: {
    outcome: Outcome;
    reason: string;
    evidence: unknown;
    blobId: string | null;
  } | null;
}

export interface ParsedClaim {
  symbol: string | null;
  quote: string | null;
  direction: string | null;
  target: string | null;
  window: { since: string | null; deadline: string | null } | null;
  evaluation: "touch" | "at_deadline" | null;
  /** high / low for a touch. The stored candle field for a deadline print. Never guessed. */
  priceBasis: "high" | "low" | "close" | null;
  deadlineBasis: string | null;
  address: string | null;
  asset: string | null;
  /** Precondition text when the quote hedges the target. The target is still what was judged. */
  conditionIgnored: { text: string } | null;
}

export interface ActualExtreme {
  value: string | null;
  at: string | null;
  candleOpen: string | null;
  field: "high" | "low" | "close" | null;
  /** True when the stored extreme is a bound on a candle that sticks out of the window. */
  bound: boolean | null;
}

/** One candle the stored verdict named. Fields that were not stored are omitted by dropping the candle. */
export interface DecidingCandleView {
  openTime: string;
  closeTime: string;
  high: string;
  low: string;
  role: string;
  usedAs: string;
}

/**
 * A Tatum reference built only from stored evidence.
 *
 * `request` is a call whose endpoint and params are recoverable (the single
 * deadline candle). `data_source` is a label: touch claims were read with
 * `/OHLCV/batch` (`timeFrom` + `numberOfCandles`) and those page bounds are
 * not stored, so they are not invented here.
 */
export type TatumReference =
  | { kind: "request"; endpoint: string; params: Record<string, string> }
  | { kind: "data_source"; label: string; requests: number | null };

export interface ClaimDetail {
  id: string;
  quote: string;
  claimType: string;
  status: string;
  /** Post time. Null when it was not stored. Never the replay or touch window start. */
  publishedAt: string | null;
  /** `params.since` when it is a timestamp. For `tx_replay` this is the window start. */
  windowStart: string | null;
  deadline: string | null;
  parsed: ParsedClaim;
  expected: string | null;
  actual: {
    extreme: ActualExtreme | null;
    /** Max or min inside the window when the evidence stored one. */
    windowHigh: ActualExtreme | null;
    windowLow: ActualExtreme | null;
    maxHigh: ActualExtreme | null;
    minLow: ActualExtreme | null;
    highAtMost: ActualExtreme | null;
    lowAtLeast: ActualExtreme | null;
    decidingCandles: DecidingCandleView[];
    /** Digests a `tx_replay` could not read. Empty when the evidence stored none. */
    unreadableDigests: string[];
    granularity: string | null;
    net: string | null;
  } | null;
  transactions: Array<{ digest: string; url: string | null }>;
  walrus: {
    blobId: string | null;
    claimBlobId: string | null;
    resolutionBlobId: string | null;
    url: null;
  };
  tatum: TatumReference | null;
  outcome: Outcome | null;
  reason: string | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function fieldOf(value: unknown): "high" | "low" | "close" | null {
  return value === "high" || value === "low" || value === "close" ? value : null;
}

function extremeOf(value: unknown): ActualExtreme | null {
  const row = rec(value);
  if (!row) return null;
  const view: ActualExtreme = {
    value: scalar(row.text) ?? scalar(row.value),
    at: iso(row.at),
    candleOpen: iso(row.candleOpen) ?? iso(row.at),
    field: fieldOf(row.field),
    bound: typeof row.bound === "boolean" ? row.bound : null,
  };
  if (!view.value && !view.at && !view.field) return null;
  return view;
}

function priceBasis(
  evaluation: "touch" | "at_deadline" | null,
  direction: string | null,
  evidenceField: "high" | "low" | "close" | null,
): "high" | "low" | "close" | null {
  if (evidenceField) return evidenceField;
  if (evaluation === "touch" && direction === "gte") return "high";
  if (evaluation === "touch" && direction === "lte") return "low";
  return null;
}

function transactionsOf(evidence: Record<string, unknown> | null, claimType: string): Array<{ digest: string; url: string | null }> {
  if (claimType !== "tx_replay" || !evidence || !Array.isArray(evidence.digests)) return [];
  const out: Array<{ digest: string; url: string | null }> = [];
  for (const item of evidence.digests) {
    if (typeof item !== "string" || !item.trim()) continue;
    const digest = item.trim();
    out.push({ digest, url: DIGEST.test(digest) ? `${SUISCAN_TX_PREFIX}${digest}` : null });
  }
  return out;
}

const OHLCV_AT = "GET /v4/data/rate/symbol/OHLCV";
const PRICE_INTERVALS = new Set(["1m", "1h", "1d"]);

/** Same string `getOhlcvAt` puts in the `time` query. Milliseconds of zero are omitted. */
function queryTime(isoTime: string): string {
  return isoTime.replace(/\.000Z$/, "Z");
}

function requestsOf(evidence: Record<string, unknown>): number | null {
  return typeof evidence.requests === "number" && Number.isFinite(evidence.requests) ? evidence.requests : null;
}

function refinedPass(evidence: Record<string, unknown>): boolean {
  if (!Array.isArray(evidence.decidingCandles)) return false;
  return evidence.decidingCandles.some((item) => rec(item)?.role === "refined");
}

function dataSource(evidence: Record<string, unknown>): TatumReference {
  const symbol = text(evidence.symbol) ?? "unknown";
  const quoteCcy = text(evidence.quote) ?? "unknown";
  const interval = text(evidence.interval);
  const grain = interval ? `${interval} candles` : "candles";
  let label = `Tatum OHLCV ${symbol}/${quoteCcy}, ${grain}`;
  if (refinedPass(evidence)) label += "; coarse-to-fine, batch bounds not stored";
  return { kind: "data_source", label, requests: requestsOf(evidence) };
}

function evaluationOf(
  params: Record<string, unknown>,
  evidence: Record<string, unknown> | null,
): "touch" | "at_deadline" | null {
  const fromParams = params.evaluation;
  if (fromParams === "touch" || fromParams === "at_deadline") return fromParams;
  const fromEvidence = evidence?.evaluation;
  if (fromEvidence === "touch" || fromEvidence === "at_deadline") return fromEvidence;
  return null;
}

/**
 * Touch pages are `GET /OHLCV/batch` with `timeFrom` and `numberOfCandles`.
 * Those arguments are not on the evidence row. Reporting them as a single
 * `/OHLCV` call with `timeFrom`/`timeTo` would describe a request that did
 * not happen. A deadline print is one `/OHLCV` call and those three params
 * are stored.
 */
function tatumOf(
  evidence: Record<string, unknown> | null,
  evaluation: "touch" | "at_deadline" | null,
): TatumReference | null {
  const source = text(evidence?.source);
  if (!evidence || !source?.startsWith("tatum:")) return null;
  const symbol = text(evidence.symbol);
  const interval = text(evidence.interval);
  const deadline = iso(evidence.deadline);
  const requests = requestsOf(evidence);
  const windowed = rec(evidence.window) !== null;
  const candles = Array.isArray(evidence.decidingCandles) && evidence.decidingCandles.length > 0;
  const single =
    evaluation === "at_deadline" &&
    !windowed &&
    !candles &&
    !refinedPass(evidence) &&
    !text(evidence.intervalFallback) &&
    (requests === null || requests === 1) &&
    symbol !== null &&
    interval !== null &&
    PRICE_INTERVALS.has(interval) &&
    deadline !== null;
  if (single && symbol && interval && deadline) {
    return {
      kind: "request",
      endpoint: OHLCV_AT,
      params: { symbol, time: queryTime(deadline), interval },
    };
  }
  return dataSource(evidence);
}

function decidingCandlesOf(value: unknown): DecidingCandleView[] {
  if (!Array.isArray(value)) return [];
  const out: DecidingCandleView[] = [];
  for (const item of value) {
    const row = rec(item);
    if (!row) continue;
    const openTime = iso(row.openTime);
    const closeTime = iso(row.closeTime);
    const high = scalar(row.high);
    const low = scalar(row.low);
    const role = text(row.role);
    const usedAs = text(row.usedAs);
    if (!openTime || !closeTime || !high || !low || !role || !usedAs) continue;
    out.push({ openTime, closeTime, high, low, role, usedAs });
  }
  return out;
}

function digestsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

export function presentClaim(input: ClaimViewInput): ClaimDetail {
  const params = rec(input.params) ?? {};
  const evidence = rec(input.resolution?.evidence);
  const evaluation = evaluationOf(params, evidence);
  const direction = text(params.direction);
  const publishedAt = iso(input.publishedAt);
  const windowStart = iso(params.since);
  const deadline = iso(input.deadline);
  const extreme = extremeOf(evidence?.extreme) ?? extremeOf(evidence?.deadlinePrice);
  const basisText = text(input.deadlineBasis) ?? text(evidence?.deadlineBasis);
  const ignored = ignoredCondition(input.quote);
  const target = text(params.amount);

  return {
    id: input.id,
    quote: input.quote,
    claimType: input.claimType,
    status: input.status,
    publishedAt,
    windowStart,
    deadline,
    parsed: {
      symbol: text(params.symbol) ?? text(evidence?.symbol),
      quote: text(params.quote) ?? text(evidence?.quote),
      direction,
      target,
      window: windowStart || deadline ? { since: windowStart, deadline } : null,
      evaluation,
      priceBasis: priceBasis(evaluation, direction, extreme?.field ?? null),
      deadlineBasis: basisText,
      address: text(params.address),
      asset: text(params.asset),
      conditionIgnored: ignored ? { text: ignored.text } : null,
    },
    expected: target,
    actual: input.resolution
      ? {
          extreme,
          windowHigh: extremeOf(evidence?.windowHigh),
          windowLow: extremeOf(evidence?.windowLow),
          maxHigh: extremeOf(evidence?.maxHigh),
          minLow: extremeOf(evidence?.minLow),
          highAtMost: extremeOf(evidence?.highAtMost),
          lowAtLeast: extremeOf(evidence?.lowAtLeast),
          decidingCandles: decidingCandlesOf(evidence?.decidingCandles),
          unreadableDigests: digestsOf(evidence?.unreadableDigests),
          granularity: text(evidence?.interval),
          net: scalar(evidence?.net),
        }
      : null,
    transactions: transactionsOf(evidence, input.claimType),
    walrus: {
      blobId: input.resolution?.blobId ?? input.claimBlobId,
      claimBlobId: input.claimBlobId,
      resolutionBlobId: input.resolution?.blobId ?? null,
      url: null,
    },
    tatum: tatumOf(evidence, evaluation),
    outcome: input.resolution?.outcome ?? null,
    reason: input.resolution?.reason ?? null,
  };
}
