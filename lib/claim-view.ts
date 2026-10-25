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

export interface ClaimDetail {
  id: string;
  quote: string;
  claimType: string;
  status: string;
  /** `params.since` when it is a timestamp. Not the row's insert time. */
  publishedAt: string | null;
  deadline: string | null;
  parsed: ParsedClaim;
  expected: string | null;
  actual: {
    extreme: ActualExtreme | null;
    /** Max or min inside the window when the evidence stored one. */
    windowHigh: ActualExtreme | null;
    windowLow: ActualExtreme | null;
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
  tatum: { endpoint: string; params: Record<string, string | number> } | null;
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

function tatumOf(evidence: Record<string, unknown> | null): ClaimDetail["tatum"] {
  const source = text(evidence?.source);
  if (!source || !source.startsWith("tatum:")) return null;
  const path = source.slice("tatum:".length);
  if (!path.startsWith("/")) return null;
  const params: Record<string, string | number> = {};
  const symbol = text(evidence?.symbol);
  const interval = text(evidence?.interval);
  if (symbol) params.symbol = symbol;
  if (interval) params.interval = interval;
  const window = rec(evidence?.window);
  const from = iso(window?.from);
  const to = iso(window?.to);
  if (from) params.timeFrom = from;
  if (to) params.timeTo = to;
  const deadline = iso(evidence?.deadline);
  if (!from && deadline) params.time = deadline;
  if (typeof evidence?.requests === "number" && Number.isFinite(evidence.requests)) {
    params.requests = evidence.requests;
  }
  return { endpoint: `GET ${path}`, params };
}

export function presentClaim(input: ClaimViewInput): ClaimDetail {
  const params = rec(input.params) ?? {};
  const evidence = rec(input.resolution?.evidence);
  const evaluation =
    params.evaluation === "touch" || params.evaluation === "at_deadline" ? params.evaluation : null;
  const direction = text(params.direction);
  const publishedAt = iso(params.since);
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
    deadline,
    parsed: {
      symbol: text(params.symbol) ?? text(evidence?.symbol),
      quote: text(params.quote) ?? text(evidence?.quote),
      direction,
      target,
      window: publishedAt || deadline ? { since: publishedAt, deadline } : null,
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
    tatum: tatumOf(evidence),
    outcome: input.resolution?.outcome ?? null,
    reason: input.resolution?.reason ?? null,
  };
}
