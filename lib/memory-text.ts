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
  opts?: { synthetic?: boolean; externalId?: string },
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

  return {
    key: `claim:${claim.id}`,
    text:
      `CLAIM from ${claim.sourceHandle}, due ${claim.deadline.slice(0, 10)}: ` +
      `"${clip(extracted.quote)}"\n\n` +
      `${syntheticLine}` +
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
): { text: string; key: string } {
  const moved =
    score.before.score !== score.after.score
      ? `Trust moved ${score.before.score.toFixed(2)} → ${score.after.score.toFixed(2)} ` +
        `(${score.after.hits} hits / ${score.after.misses} misses across ` +
        `${score.after.adjudicated} adjudicated claims).`
      : score.after.adjudicated === 0
        ? `No adjudicated claims yet, so trust is unchanged.`
        : `Trust unchanged at ${score.after.score.toFixed(2)}.`;

  const verdictLine =
    r.outcome === "void"
      ? `VOID — could not check. This tells us nothing about the source's honesty and does not move its score.`
      : `VERDICT: ${r.outcome.toUpperCase()}.`;

  return {
    key: `resolution:${r.claimId}`,
    text:
      `[RESOLUTION] ${r.sourceHandle} claimed "${clip(r.quote, 120)}" ` +
      `(${r.claimType}, resolved ${new Date().toISOString().slice(0, 10)}). ` +
      `${verdictLine} ${r.reason} ` +
      `${r.outcome !== "void" ? moved : ""}\n\n` +
      payload({
        kind: "resolution",
        claim_id: r.claimId,
        source_handle: r.sourceHandle,
        claim_type: r.claimType,
        outcome: r.outcome,
        reason: r.reason,
        hits: score.after.hits,
        misses: score.after.misses,
        score_before: score.before.score,
        score_after: score.after.score,
        evidence: r.evidence,
      }),
  };
}

// ── score version ────────────────────────────────────────────────────────────

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
): { text: string; key: string } {
  const delta =
    previous === null
      ? `first recorded score`
      : `previously ${previous.toFixed(2)}, now ${score.score.toFixed(2)}`;

  const bandLine =
    score.band === "muted"
      ? `This source is below the mute threshold and its claims no longer appear in the feed.`
      : score.band === "trusted"
        ? `This source sorts to the top of the feed.`
        : score.band === "unknown"
          ? `Too few adjudicated claims to judge; shown without a trust badge.`
          : `This source appears normally.`;

  return {
    key: `score:${s.sourceId}:v${s.version}`,
    text:
      `[SCORE] ${s.sourceHandle} is at trust v${s.version}: ${score.score.toFixed(2)} ` +
      `(${delta}; ${score.hits} hits / ${score.misses} misses, ` +
      `raw hit rate ${(score.hitRate * 100).toFixed(0)}%). ` +
      `Trigger: ${s.reason}. ${bandLine}\n\n` +
      payload({
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
      }),
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
