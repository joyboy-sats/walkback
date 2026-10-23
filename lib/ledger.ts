/**
 * Ledger summary for the homepage.
 *
 * The feed is a ranked, capped list of claims. The overview needs every source,
 * and the totals need every claim plus the memory log. Both are derived here
 * from rows the API already stores. Walrus is not queried: a memory count from
 * this projection is inventory. `verified` is set only when the newest finished
 * rebuild job reported a complete list walk.
 */
import { MIN_SAMPLE, sourceIsMuted, trustBand, type TrustBand } from "./score";

const CLAIM_TYPE_ORDER = [
  "tx_replay",
  "price_threshold",
  "balance_threshold",
  "balance_change_since_ingest",
  "manual",
] as const;

const BAND_ORDER: Record<TrustBand, number> = {
  trusted: 0,
  normal: 1,
  muted: 2,
  unknown: 3,
};

export interface LedgerSourceInput {
  id: string;
  handle: string;
  score: number;
  hits: number;
  misses: number;
  storedMuted: boolean;
}

export interface LedgerClaimInput {
  sourceId: string;
  claimType: string;
  status: "pending" | "resolved" | "void";
}

export interface LedgerSource {
  id: string;
  handle: string;
  score: number;
  hits: number;
  misses: number;
  /** Formula band. Unrated wins over a stored mute when the sample is under 3. */
  band: TrustBand;
  /** Same rule as the feed: a stored mute does not hide an unrated source. */
  muted: boolean;
  claimTypes: string[];
}

export interface LedgerMemories {
  /** Rows in the projection's memory log. This is what the Memory page lists. */
  inventory: number;
  /**
   * Product memories read from a completed Walrus list walk.
   * Null when that walk has not been recorded.
   */
  verified: number | null;
}

export interface LedgerTotals {
  claims: number;
  resolved: number;
  pending: number;
  void: number;
  memories: LedgerMemories;
}

export interface LedgerView {
  sources: LedgerSource[];
  totals: LedgerTotals;
}

export function nonNegativeInt(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Stable order: tx reporting, then price predictions, then the rest. */
export function sortClaimTypes(types: Iterable<string>): string[] {
  return [...new Set(types)].sort((a, b) => {
    const ia = CLAIM_TYPE_ORDER.indexOf(a as (typeof CLAIM_TYPE_ORDER)[number]);
    const ib = CLAIM_TYPE_ORDER.indexOf(b as (typeof CLAIM_TYPE_ORDER)[number]);
    const ra = ia === -1 ? CLAIM_TYPE_ORDER.length : ia;
    const rb = ib === -1 ? CLAIM_TYPE_ORDER.length : ib;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

/**
 * Verified count from a rebuild job result.
 * Anything short of a finished list walk stays null, so the UI can say inventory.
 */
export function verifiedMemoryCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  if (row.coverageComplete !== true) return null;
  if (row.enumeration !== "list") return null;
  const coverage = row.coverage;
  if (!coverage || typeof coverage !== "object") return null;
  const unique = (coverage as { unique?: unknown }).unique;
  if (typeof unique !== "number" || !Number.isInteger(unique) || unique < 0) return null;
  return unique;
}

export function buildLedger(input: {
  sources: readonly LedgerSourceInput[];
  claims: readonly LedgerClaimInput[];
  memoryInventory: unknown;
  latestVerifyResult: unknown;
}): LedgerView {
  const typesBySource = new Map<string, string[]>();
  let resolved = 0;
  let pending = 0;
  let voids = 0;
  for (const claim of input.claims) {
    if (claim.status === "resolved") resolved += 1;
    else if (claim.status === "pending") pending += 1;
    else if (claim.status === "void") voids += 1;
    const list = typesBySource.get(claim.sourceId);
    if (list) list.push(claim.claimType);
    else typesBySource.set(claim.sourceId, [claim.claimType]);
  }

  const sources = input.sources.map((source) => {
    const adjudicated = source.hits + source.misses;
    return {
      id: source.id,
      handle: source.handle,
      score: source.score,
      hits: source.hits,
      misses: source.misses,
      band: trustBand(source.score, adjudicated),
      muted: sourceIsMuted(source.storedMuted, adjudicated),
      claimTypes: sortClaimTypes(typesBySource.get(source.id) ?? []),
    };
  });

  sources.sort((a, b) => {
    const band = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (band !== 0) return band;
    if (a.band !== "unknown" && a.score !== b.score) return b.score - a.score;
    const sample = b.hits + b.misses - (a.hits + a.misses);
    if (sample !== 0) return sample;
    return a.handle.localeCompare(b.handle);
  });

  return {
    sources,
    totals: {
      claims: input.claims.length,
      resolved,
      pending,
      void: voids,
      memories: {
        inventory: nonNegativeInt(input.memoryInventory),
        verified: verifiedMemoryCount(input.latestVerifyResult),
      },
    },
  };
}

export function includeMutedParam(value: string | string[] | undefined): boolean {
  return value === "1" || (Array.isArray(value) && value.includes("1"));
}

export function visibleClaims<T extends { source: { muted: boolean } }>(
  rows: readonly T[],
  includeMuted: boolean,
): { visible: T[]; hidden: number } {
  if (includeMuted) return { visible: [...rows], hidden: 0 };
  const visible = rows.filter((row) => !row.source.muted);
  return { visible, hidden: rows.length - visible.length };
}

export { MIN_SAMPLE };
