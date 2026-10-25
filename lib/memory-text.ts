/**
 * Memory text builders.
 *
 * Walrus Memory is recalled semantically, so every stored memory is written as
 * a paragraph of plain English with a fenced JSON payload underneath. Two
 * consequences, both intentional:
 *
 *   - A human reading the Memory Explorer understands the entry without
 *     decoding JSON. That is the difference between an audit trail and a log
 *     dump.
 *   - `recall("why did alice's score drop")` works, because the text contains
 *     the causal sentence. Recall is similarity search, not a query language;
 *     if the reason is not in the words, it cannot be found.
 *
 * The JSON block exists for the projection rebuild: `restore` replays these
 * strings and needs machine-readable fields, not prose.
 */
import type {
  BalanceSnapshot,
  ClaimParams,
  ClaimType,
  ExtractedClaim,
  Outcome,
  SourceRef,
} from "./types";
import type { CategoryScore, MuteBasis } from "./category-score";
import type { ScoreSnapshot } from "./score";

/** Text that is too long for a memory is truncated at a sentence boundary. */
function clip(s: string, max = 200): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastPeriod = cut.lastIndexOf(". ");
  return (lastPeriod > max * 0.6 ? cut.slice(0, lastPeriod + 1) : cut).trim();
}

function payload(o: Record<string, unknown>): string {
  return "```json\n" + JSON.stringify(o, null, 2) + "\n```";
}

// ── source ───────────────────────────────────────────────────────────────────

export function sourceMemory(
  source: SourceRef,
  meta: { createdAt: string; synthetic?: boolean },
): { text: string; key: string } {
  const addr = source.suiAddress ? `, address ${source.suiAddress}` : "";
  const syntheticLine = meta.synthetic
    ? `SYNTHETIC demo source, not a real account. Do not treat its record as evidence. `
    : "";
  return {
    key: `source:${source.id}`,
    text:
      `SOURCE ${source.handle} was added to Walkback on ${meta.createdAt.slice(0, 10)}. ` +
      `${syntheticLine}` +
      `Platform: ${source.platform}${addr}. ` +
      `Walkback will extract checkable claims this source makes about onchain ` +
      `state and adjudicate them against Sui mainnet at their deadlines. ` +
      `Trust starts at the unknown band until ${3} claims have been resolved.\n\n` +
      payload({
        kind: "source",
        source_id: source.id,
        handle: source.handle,
        platform: source.platform,
        sui_address: source.suiAddress ?? null,
        created_at: meta.createdAt,
        synthetic: meta.synthetic === true,
      }),
  };
}

// ── claim ────────────────────────────────────────────────────────────────────

export function claimMemory(
  claim: {
    id: string;
    sourceHandle: string;
    claimType: ClaimType;
    params: ClaimParams;
    deadline: string;
    confidence: number;
  },
  extracted: ExtractedClaim,
  snapshot: BalanceSnapshot | null,
  opts?: { synthetic?: boolean; externalId?: string; sourceUrl?: string; deadlineBasis?: string; publishedAt?: string },
): { text: string; key: string } {
  const snapLine = snapshot
    ? `At ingest, ${snapshot.address} held ${snapshot.balance} base units of ` +
      `${snapshot.asset} (checkpoint ${snapshot.checkpoint ?? "unknown"}, ` +
      `${snapshot.asOf}). This snapshot is the receipt; without it the change ` +
      `could never be measured later.`
    : `No snapshot was taken at ingest, so any claim about a change over time ` +
      `will resolve to void rather than be guessed.`;

  const syntheticLine = opts?.synthetic
    ? `SYNTHETIC demo fallback — this is not a real post and must not be counted as evidence. `
    : "";
  const sourceLine = opts?.sourceUrl ? `Original post: ${opts.sourceUrl}. ` : "";
  const basisLine = opts?.deadlineBasis ? `Deadline basis: ${opts.deadlineBasis}. ` : "";
  const publishedIso =
    opts?.publishedAt && !Number.isNaN(Date.parse(opts.publishedAt))
      ? new Date(opts.publishedAt).toISOString()
      : null;
  const publishedLine = publishedIso ? `Published at ${publishedIso}. ` : "";

  return {
    key: `claim:${claim.id}`,
    text:
      `CLAIM from ${claim.sourceHandle}, due ${claim.deadline.slice(0, 10)}: ` +
      `"${clip(extracted.quote)}"\n\n` +
      `${syntheticLine}` +
      `${sourceLine}` +
      `${basisLine}` +
      `${publishedLine}` +
      `Recorded as a ${claim.claimType} claim with ${claim.confidence.toFixed(2)} ` +
      `extraction confidence. ${snapLine}\n\n` +
      payload({
        kind: "claim",
        claim_id: claim.id,
        source_handle: claim.sourceHandle,
        claim_type: claim.claimType,
        params: claim.params,
        deadline: claim.deadline,
        quote: clip(extracted.quote),
        confidence: claim.confidence,
        snapshot,
        synthetic: opts?.synthetic === true,
        ...(opts?.externalId ? { external_id: opts.externalId } : {}),
        ...(opts?.sourceUrl ? { source_url: opts.sourceUrl } : {}),
        ...(opts?.deadlineBasis ? { deadline_basis: opts.deadlineBasis } : {}),
        ...(publishedIso ? { published_at: publishedIso } : {}),
      }),
  };
}

// ── resolution ───────────────────────────────────────────────────────────────

export function resolutionMemory(
  r: {
    claimId: string;
    sourceHandle: string;
    claimType: ClaimType;
    quote: string;
    outcome: Outcome;
    reason: string;
    evidence: unknown;
  },
  score: { before: ScoreSnapshot; after: ScoreSnapshot },
  opts?: { revision?: number; resolvedAt?: string },
): { text: string; key: string } {
  const revision = opts?.revision ?? 1;

  const verdictLine =
    r.outcome === "void"
      ? `VOID — could not check. This tells us nothing about the source's honesty and does not move its score.`
      : `VERDICT: ${r.outcome.toUpperCase()}.`;

  // The idempotency key is the claim and the revision. The bytes have to be
  // the same on every retry, or the relayer answers 409 ("already used for a
  // request with different content") and the claim stays pending forever.
  // The clock and the live score both change between a worker pass and a
  // seed pass, so neither is part of this memory. The score memory records
  // the bound. `score` and `resolvedAt` stay on the signature so older
  // callers still compile; they are not written.
  void score;
  void opts?.resolvedAt;

  return {
    // Revision 1 keeps the original key so a retry of the first resolution
    // collapses onto the memory already written. A later revision is a new
    // append; Walrus has no update, and the first key must not be reused.
    key: revision <= 1 ? `resolution:${r.claimId}` : `resolution:${r.claimId}:r${revision}`,
    text:
      `[RESOLUTION] ${r.sourceHandle} claimed "${clip(r.quote, 120)}" ` +
      `(${r.claimType}). ` +
      `${verdictLine} ${r.reason}\n\n` +
      payload({
        kind: "resolution",
        claim_id: r.claimId,
        source_handle: r.sourceHandle,
        claim_type: r.claimType,
        outcome: r.outcome,
        reason: r.reason,
        evidence: r.evidence,
        ...(revision > 1 ? { revision } : {}),
      }),
  };
}

// ── score version ────────────────────────────────────────────────────────────

export interface ScoreMemoryCategories {
  reporting: CategoryScore;
  forecast: CategoryScore;
  muteBasis: MuteBasis;
}

/**
 * Score memories are append-only. `hits` / `misses` / `score` stay the overall
 * Wilson record so a replay of stored verdicts still matches blobs written
 * before categories existed. Those blobs have no `schema_version`.
 *
 * A new write that knows the category counts uses schema_version 2 and adds
 * `categories` and `mute_basis`. It does not rewrite or delete the older blob.
 * The idempotency key stays `score:{sourceId}:v{n}`.
 */
export function scoreMemory(
  s: {
    sourceId: string;
    sourceHandle: string;
    version: number;
    triggeredByClaimId: string | null;
    reason: string;
  },
  score: ScoreSnapshot,
  previous: number | null,
  categories?: ScoreMemoryCategories | null,
): { text: string; key: string } {
  const delta =
    previous === null
      ? `first recorded score`
      : `previously ${previous.toFixed(2)}, now ${score.score.toFixed(2)}`;

  const legacyBandLine =
    score.band === "muted"
      ? `This source is below the mute threshold and its claims no longer appear in the feed.`
      : score.band === "trusted"
        ? `This source sorts to the top of the feed.`
        : score.band === "unknown"
          ? `Too few adjudicated claims to judge; shown without a trust badge.`
          : `This source appears normally.`;
  const feedBand = categories
    ? categories.muteBasis === "forecast"
      ? categories.forecast.band
      : categories.reporting.band
    : score.band;
  const bandLine = !categories
    ? legacyBandLine
    : feedBand === "muted"
      ? `The ${categories.muteBasis} record is below the mute threshold and its claims no longer appear in the feed.`
      : feedBand === "trusted"
        ? `The ${categories.muteBasis} record sorts to the top of the feed.`
        : feedBand === "unknown"
          ? `The ${categories.muteBasis} record has too few adjudicated claims to judge; shown without a trust badge.`
          : `The ${categories.muteBasis} record appears normally.`;

  const categoryLine = categories
    ? ` Reporting ${categories.reporting.hits}/${categories.reporting.misses} (${categories.reporting.band}), ` +
      `forecast ${categories.forecast.hits}/${categories.forecast.misses} (${categories.forecast.band}). ` +
      `The feed follows the ${categories.muteBasis} record.`
    : "";

  const body: Record<string, unknown> = {
    kind: "score",
    source_id: s.sourceId,
    source_handle: s.sourceHandle,
    version: s.version,
    hits: score.hits,
    misses: score.misses,
    score: score.score,
    hit_rate: score.hitRate,
    band: score.band,
    previous,
    triggered_by_claim_id: s.triggeredByClaimId,
    reason: s.reason,
  };
  if (categories) {
    body.schema_version = 2;
    body.mute_basis = categories.muteBasis;
    body.categories = {
      reporting: {
        hits: categories.reporting.hits,
        misses: categories.reporting.misses,
        n: categories.reporting.n,
        score: categories.reporting.score,
        band: categories.reporting.band,
      },
      forecast: {
        hits: categories.forecast.hits,
        misses: categories.forecast.misses,
        n: categories.forecast.n,
        score: categories.forecast.score,
        band: categories.forecast.band,
      },
    };
  }

  return {
    key: `score:${s.sourceId}:v${s.version}`,
    text:
      `[SCORE] ${s.sourceHandle} is at trust v${s.version}: ${score.score.toFixed(2)} ` +
      `(${delta}; ${score.hits} hits / ${score.misses} misses, ` +
      `raw hit rate ${(score.hitRate * 100).toFixed(0)}%). ` +
      `Trigger: ${s.reason}. ${bandLine}${categoryLine}\n\n` +
      payload(body),
  };
}

// ── digest ───────────────────────────────────────────────────────────────────

export function digestMemory(d: {
  date: string;
  resolved: number;
  voids: number;
  muted: Array<{ handle: string; score: number }>;
  promoted: Array<{ handle: string; score: number }>;
  pending: number;
}): { text: string; key: string } {
  const parts: string[] = [
    `[DIGEST] ${d.date}: ${d.resolved} claims resolved, ${d.voids} could not be checked, ` +
      `${d.pending} still pending.`,
  ];
  if (d.muted.length) {
    parts.push(
      `Muted this period: ${d.muted.map((m) => `${m.handle} (${m.score.toFixed(2)})`).join(", ")}.`,
    );
  }
  if (d.promoted.length) {
    parts.push(
      `Promoted: ${d.promoted.map((m) => `${m.handle} (${m.score.toFixed(2)})`).join(", ")}.`,
    );
  }
  return {
    key: `digest:${d.date}`,
    text: parts.join(" ") + "\n\n" + payload({ kind: "digest", ...d }),
  };
}

// ── tombstone ────────────────────────────────────────────────────────────────

/**
 * Walrus Memory has no delete. To "remove" something we append a tombstone and
 * filter it out in the projection. Honest about what it is: a marker, not an
 * erasure, because the original blob remains on mainnet.
 */
export function tombstoneMemory(t: {
  refId: string;
  kind: "source" | "claim";
  reason: string;
}): { text: string; key: string } {
  return {
    key: `tombstone:${t.kind}:${t.refId}`,
    text:
      `[TOMBSTONE] ${t.kind} ${t.refId} was marked removed on ` +
      `${new Date().toISOString().slice(0, 10)}: ${t.reason}. ` +
      `The original memory remains on Walrus; this record hides it from the feed only.\n\n` +
      payload({ kind: "tombstone", ref_id: t.refId, ref_kind: t.kind, reason: t.reason }),
  };
}
