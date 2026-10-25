/**
 * Ledger summary for the homepage.
 *
 * The feed is a ranked, capped list of claims. The overview needs every source,
 * and the totals need every claim plus the memory log. Both are derived here
 * from rows the API already stores. Walrus is not queried. `inventory` is the
 * number of rows in Postgres `memory_log`. It is not the relayer's live list
 * (`npm run list:memories` counts that, including blobs never logged here).
 * `verified` is set only when the newest finished rebuild job reported a
 * complete list walk.
 *
 * Mute rule is `forecast-primary` (see `lib/category-score.ts`). When category
 * counts are supplied, the source's displayed score, hits, misses, band, and
 * `muted` flag are that category's record: forecast if the source has any
 * true/false price verdict, otherwise reporting. Totals say so explicitly.
 * `all` includes muted sources. `visible` does not.
 */
import {
  foldCategories,
  MUTE_RULE,
  type CategoryCounts,
  type CategoryScore,
  type MuteBasis,
} from "./category-score";
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
  /**
   * Latest true/false counts per category. When all four are set, muting
   * follows {@link MUTE_RULE} and ignores `storedMuted`.
   */
  reportingHits?: number;
  reportingMisses?: number;
  forecastHits?: number;
  forecastMisses?: number;
}

export interface LedgerClaimInput {
  sourceId: string;
  claimType: string;
  status: "pending" | "resolved" | "void";
  /** Latest verdict. Omit the field when outcomes were not loaded. */
  outcome?: "true" | "false" | "void" | null;
}

export interface LedgerSource {
  id: string;
  handle: string;
  /** Mute-basis record when categories were supplied. Otherwise the stored overall score. */
  score: number;
  hits: number;
  misses: number;
  /** Formula band. Unrated wins over a stored mute when the sample is under 3. */
  band: TrustBand;
  /** Same rule as the feed. */
  muted: boolean;
  /** Which record `band` and `muted` came from. Null when categories were not supplied. */
  muteBasis: MuteBasis | null;
  overall: CategoryScore | null;
  reporting: CategoryScore | null;
  forecast: CategoryScore | null;
  claimTypes: string[];
}

export interface LedgerMemories {
  /**
   * Rows in Postgres `memory_log`. The homepage labels this "logged".
   * It is not the relayer live count.
   */
  inventory: number;
  /**
   * Product memories read from a completed Walrus list walk.
   * Null when that walk has not been recorded.
   */
  verified: number | null;
}

export interface StatusCounts {
  claims: number;
  resolved: number;
  pending: number;
  void: number;
}

export interface CountingTotals {
  /** `forecast-primary`: see lib/category-score.ts. */
  muteRule: typeof MUTE_RULE;
  /** `all` counts claims from muted sources. */
  allIncludesMuted: true;
  /** `visible` drops claims whose source is muted. */
  visibleIncludesMuted: false;
  all: StatusCounts;
  visible: StatusCounts;
  /** Sources the mute rule hides. */
  mutedSources: number;
  /** Claims that belong to muted sources. */
  hiddenClaims: number;
  /**
   * Hidden claims whose latest verdict is false.
   * Null when the caller did not pass outcomes.
   */
  hiddenClaimsFalse: number | null;
}

export interface LedgerTotals extends CountingTotals {
  /** Same as `all`. Kept so the current homepage can keep reading these fields. */
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

function hasCategoryCounts(source: LedgerSourceInput): source is LedgerSourceInput & CategoryCounts {
  return (
    typeof source.reportingHits === "number" &&
    typeof source.reportingMisses === "number" &&
    typeof source.forecastHits === "number" &&
    typeof source.forecastMisses === "number"
  );
}

function emptyStatus(): StatusCounts {
  return { claims: 0, resolved: 0, pending: 0, void: 0 };
}

function addStatus(counts: StatusCounts, status: LedgerClaimInput["status"]): void {
  counts.claims += 1;
  if (status === "resolved") counts.resolved += 1;
  else if (status === "pending") counts.pending += 1;
  else if (status === "void") counts.void += 1;
}

export function buildLedger(input: {
  sources: readonly LedgerSourceInput[];
  claims: readonly LedgerClaimInput[];
  memoryInventory: unknown;
  latestVerifyResult: unknown;
}): LedgerView {
  const typesBySource = new Map<string, string[]>();
  for (const claim of input.claims) {
    const list = typesBySource.get(claim.sourceId);
    if (list) list.push(claim.claimType);
    else typesBySource.set(claim.sourceId, [claim.claimType]);
  }

  const sources = input.sources.map((source) => {
    const categories = hasCategoryCounts(source) ? foldCategories(source, source.hits, source.misses) : null;
    const adjudicated = source.hits + source.misses;
    const shown = categories?.basis;
    return {
      id: source.id,
      handle: source.handle,
      score: shown?.score ?? source.score,
      hits: shown?.hits ?? source.hits,
      misses: shown?.misses ?? source.misses,
      band: shown?.band ?? trustBand(source.score, adjudicated),
      muted: categories ? categories.muted : sourceIsMuted(source.storedMuted, adjudicated),
      muteBasis: categories?.muteBasis ?? null,
      overall: categories?.overall ?? null,
      reporting: categories?.reporting ?? null,
      forecast: categories?.forecast ?? null,
      claimTypes: sortClaimTypes(typesBySource.get(source.id) ?? []),
    };
  });

  sources.sort((a, b) => compareTrust(a, b) || a.handle.localeCompare(b.handle));

  const mutedIds = new Set(sources.filter((source) => source.muted).map((source) => source.id));
  const all = emptyStatus();
  const visible = emptyStatus();
  let hiddenClaims = 0;
  let hiddenFalse = 0;
  let outcomesKnown = true;
  for (const claim of input.claims) {
    addStatus(all, claim.status);
    const hidden = mutedIds.has(claim.sourceId);
    if (hidden) {
      hiddenClaims += 1;
      if (!("outcome" in claim)) outcomesKnown = false;
      else if (claim.outcome === "false") hiddenFalse += 1;
    } else {
      addStatus(visible, claim.status);
    }
  }
  if (input.claims.some((claim) => !("outcome" in claim))) outcomesKnown = false;

  return {
    sources,
    totals: {
      claims: all.claims,
      resolved: all.resolved,
      pending: all.pending,
      void: all.void,
      muteRule: MUTE_RULE,
      allIncludesMuted: true,
      visibleIncludesMuted: false,
      all,
      visible,
      mutedSources: mutedIds.size,
      hiddenClaims,
      hiddenClaimsFalse: outcomesKnown ? hiddenFalse : null,
      memories: {
        inventory: nonNegativeInt(input.memoryInventory),
        verified: verifiedMemoryCount(input.latestVerifyResult),
      },
    },
  };
}

export function compareTrust(
  a: { band: TrustBand; score: number; hits: number; misses: number },
  b: { band: TrustBand; score: number; hits: number; misses: number },
): number {
  const band = BAND_ORDER[a.band] - BAND_ORDER[b.band];
  if (band !== 0) return band;
  if (a.band !== "unknown" && a.score !== b.score) return b.score - a.score;
  return b.hits + b.misses - (a.hits + a.misses);
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

export function feedRows<T>(payload: readonly T[] | { rows?: readonly T[] } | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return [...payload];
  const rows = (payload as { rows?: readonly T[] }).rows;
  return Array.isArray(rows) ? [...rows] : [];
}

export { MIN_SAMPLE, MUTE_RULE };
