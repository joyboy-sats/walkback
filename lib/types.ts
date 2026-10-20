/**
 * Domain types shared by the app, scripts and tests.
 *
 * The claim-type union is intentionally closed and small. Anything the system
 * cannot adjudicate automatically does not belong here — it becomes `manual`
 * or it is rejected at extraction time.
 */

// ── Claim types ──────────────────────────────────────────────────────────────

/**
 * `balance_threshold`  — "holds at least N X" at the deadline.
 * `balance_change_since_ingest` — snapshot at ingest vs. balance at deadline.
 * `tx_replay`         — historical: replay transfers within a window.
 * `price_threshold`   — market price at the deadline.
 * `manual`            — human verdict; the demo fallback.
 *
 * Note there is no `balance_delta` over past time: Tatum's Sui surface has no
 * historical balance query. That constraint is why `balance_change_since_ingest`
 * exists and why the app takes a snapshot at ingest.
 */
export type ClaimType =
  | "balance_threshold"
  | "balance_change_since_ingest"
  | "tx_replay"
  | "price_threshold"
  | "manual";

export type Direction = "gte" | "lte";

export interface BalanceThresholdParams {
  address: string;
  /** Coin type, e.g. "0x2::sui::SUI". */
  asset: string;
  direction: Direction;
  /** Base units (mist for SUI), integer. */
  amount: string;
}

export interface BalanceChangeParams {
  address: string;
  asset: string;
  /** Direction of the *change*, not the resulting balance. */
  direction: Direction;
  amount: string;
}

export interface TxReplayParams {
  address: string;
  asset: string;
  /** ISO timestamps; the window is [since, until). */
  since: string;
  until: string;
  direction: Direction;
  amount: string;
}

export interface PriceThresholdParams {
  /** Ticker as the rate API expects it, e.g. "SUI". */
  symbol: string;
  quote: string;
  direction: Direction;
  amount: string;
}

export interface ManualParams {
  note: string;
}

export type ClaimParams =
  | BalanceThresholdParams
  | BalanceChangeParams
  | TxReplayParams
  | PriceThresholdParams
  | ManualParams;

/** All claim types that are adjudicated automatically. */
export const AUTOMATED_CLAIM_TYPES: readonly ClaimType[] = [
  "balance_threshold",
  "balance_change_since_ingest",
  "tx_replay",
  "price_threshold",
] as const;

// ── Verdicts ─────────────────────────────────────────────────────────────────

/**
 * `void` is not `false`. A claim we could not check tells us nothing about the
 * source's honesty, so it never counts toward the score. The UI must say
 * "could not check", never "lied".
 */
export type Outcome = "true" | "false" | "void";

export interface Verdict {
  outcome: Outcome;
  /** One plain-English sentence, safe to embed in a memory. */
  reason: string;
  /** Raw, normalized provider payload. Shown in the evidence panel. */
  evidence: unknown;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/**
 * Chain state frozen at ingest. Without this, `balance_change_since_ingest`
 * cannot be adjudicated later, because historical balances are unqueryable.
 */
export interface BalanceSnapshot {
  address: string;
  asset: string;
  /** Base units as a decimal string. */
  balance: string;
  /** Sui checkpoint height the read was taken at, if available. */
  checkpoint?: string;
  asOf: string;
}

// ── Sources & claims (domain shapes, not DB rows) ────────────────────────────

export interface SourceRef {
  id: string;
  handle: string;
  platform: "x" | "substack" | "rss" | "onchain" | "other";
  suiAddress?: string;
}

export interface ExtractedClaim {
  quote: string;
  claimType: ClaimType;
  params: ClaimParams;
  /** ISO timestamp. */
  deadline: string;
  /** 0..1. Below 0.6 is dropped before storage. */
  confidence: number;
}

// ── Memory namespaces ────────────────────────────────────────────────────────

/**
 * Exact-match flat strings. No prefix search, no hierarchy — `receipts.claim`
 * and `receipts.claim.v2` are unrelated namespaces as far as the relayer is
 * concerned. Keep this list short and stable.
 */
export const NS = {
  source: "walkback.source",
  claim: "walkback.claim",
  resolution: "walkback.resolution",
  score: "walkback.score",
  digest: "walkback.digest",
  tombstone: "walkback.tombstone",
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];
