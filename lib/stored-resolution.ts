/**
 * Read a resolution or score memory that Walrus already accepted.
 *
 * The relayer rejects a second remember with the same idempotency key and
 * different bytes (409). Recall is not a query: hits are re-parsed, and a
 * hit counts only when the fenced JSON names this claim.
 */
import type { Outcome } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecallText {
  blobId: string;
  text: string;
  createdAt?: string;
}

export interface StoredResolution {
  claimId: string;
  outcome: Outcome;
  reason: string;
  evidence: Record<string, unknown>;
  revision: number;
  /** From the memory JSON when the writer stored one. Absent on a canonical body. */
  resolvedAt: string | null;
  blobId: string;
  text: string;
  createdAt?: string;
}

export interface StoredScore {
  sourceId: string;
  version: number;
  hits: number;
  misses: number;
  score: number;
  hitRate: number;
  triggeredByClaimId: string | null;
  reason: string;
  blobId: string;
  text: string;
}

/** Pull the fenced JSON block `memory-text.ts` appends. Null when it is missing or broken. */
export function parseFencedJson(text: string): Record<string, unknown> | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  const body = match?.[1];
  if (!body) return null;
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolutionIdempotencyKey(claimId: string, revision: number): string {
  return revision <= 1 ? `resolution:${claimId}` : `resolution:${claimId}:r${revision}`;
}

export function scoreIdempotencyKey(sourceId: string, version: number): string {
  return `score:${sourceId}:v${version}`;
}

/** Query text. The claim id is in the JSON, and the opening sentence is in the prose. */
export function resolutionRecallQuery(claim: { id: string; handle: string; quote: string }): string {
  const quote = claim.quote.replace(/\s+/g, " ").trim().slice(0, 120);
  return `${claim.id} [RESOLUTION] ${claim.handle} claimed ${quote}`;
}

export function scoreRecallQuery(claim: { id: string; handle: string }): string {
  return `${claim.id} [SCORE] ${claim.handle}`;
}

function asOutcome(value: unknown): Outcome | null {
  return value === "true" || value === "false" || value === "void" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function revisionOf(payload: Record<string, unknown>): number {
  const revision = payload.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function timeOf(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function parseStoredResolution(hit: RecallText): StoredResolution | null {
  const payload = parseFencedJson(hit.text);
  if (!payload) return null;
  if (payload.kind !== undefined && payload.kind !== "resolution") return null;
  const claimId = typeof payload.claim_id === "string" ? payload.claim_id : "";
  const outcome = asOutcome(payload.outcome);
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!UUID.test(claimId) || !outcome || !reason) return null;
  const createdAt = timeOf(hit.createdAt) ?? undefined;
  return {
    claimId,
    outcome,
    reason,
    evidence: asRecord(payload.evidence) ?? {},
    revision: revisionOf(payload),
    resolvedAt: timeOf(payload.resolved_at),
    blobId: hit.blobId,
    text: hit.text,
    ...(createdAt ? { createdAt } : {}),
  };
}

function laterResolution(a: StoredResolution, b: StoredResolution): number {
  if (a.revision !== b.revision) return b.revision - a.revision;
  const aTime = a.resolvedAt ?? a.createdAt ?? "";
  const bTime = b.resolvedAt ?? b.createdAt ?? "";
  if (aTime !== bTime) return bTime.localeCompare(aTime);
  return b.blobId.localeCompare(a.blobId);
}

/** The newest resolution memory whose JSON names `claimId`. */
export function selectStoredResolution(claimId: string, hits: readonly RecallText[]): StoredResolution | null {
  const matches = hits
    .map((hit) => parseStoredResolution(hit))
    .filter((row): row is StoredResolution => row !== null && row.claimId === claimId);
  matches.sort(laterResolution);
  return matches[0] ?? null;
}

/** The logged blob, and only that blob. A different hit is not this key. */
export function selectStoredResolutionForBlob(
  claimId: string,
  blobId: string,
  hits: readonly RecallText[],
): StoredResolution | null {
  for (const hit of hits) {
    if (hit.blobId !== blobId) continue;
    const parsed = parseStoredResolution(hit);
    if (parsed && parsed.claimId === claimId) return parsed;
  }
  return null;
}

export function parseStoredScore(hit: RecallText): StoredScore | null {
  const payload = parseFencedJson(hit.text);
  if (!payload || payload.kind !== "score") return null;
  const sourceId = typeof payload.source_id === "string" ? payload.source_id : "";
  const version = payload.version;
  const hits = payload.hits;
  const misses = payload.misses;
  const score = payload.score;
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!UUID.test(sourceId) || typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (typeof hits !== "number" || typeof misses !== "number" || typeof score !== "number" || !reason) return null;
  const trigger = payload.triggered_by_claim_id;
  const hitRate =
    typeof payload.hit_rate === "number" ? payload.hit_rate : hits + misses === 0 ? 0 : hits / (hits + misses);
  return {
    sourceId,
    version,
    hits,
    misses,
    score,
    hitRate,
    triggeredByClaimId: typeof trigger === "string" && UUID.test(trigger) ? trigger : null,
    reason,
    blobId: hit.blobId,
    text: hit.text,
  };
}

/** Highest score version triggered by this claim. Other claims' versions are ignored. */
export function selectStoredScore(
  claimId: string,
  sourceId: string,
  hits: readonly RecallText[],
): StoredScore | null {
  const matches = hits
    .map((hit) => parseStoredScore(hit))
    .filter(
      (row): row is StoredScore =>
        row !== null && row.sourceId === sourceId && row.triggeredByClaimId === claimId,
    );
  matches.sort((a, b) => b.version - a.version || b.blobId.localeCompare(a.blobId));
  return matches[0] ?? null;
}

const EVIDENCE_CLOCK_KEYS = new Set([
  "resolvedAt",
  "resolved_at",
  "revision",
  "score_before",
  "score_after",
  "hits",
  "misses",
  "score",
]);

/** Evidence with the clock and score fields removed, keys sorted. Those fields are why two resolvers 409. */
export function comparableEvidence(evidence: unknown): string {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return JSON.stringify(evidence ?? null);
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(evidence as Record<string, unknown>).sort()) {
    if (EVIDENCE_CLOCK_KEYS.has(key)) continue;
    copy[key] = (evidence as Record<string, unknown>)[key];
  }
  return JSON.stringify(copy);
}

/**
 * A 409 is "already written" only when the stored memory is this verdict.
 * Same claim, outcome, reason, and candle evidence. A different verdict is a
 * conflict, not a success.
 */
export function resolutionContentMatches(
  stored: { claimId: string; outcome: string; reason: string; evidence: Record<string, unknown> },
  expected: { claimId: string; outcome: string; reason: string; evidence: unknown },
): boolean {
  return (
    stored.claimId === expected.claimId &&
    stored.outcome === expected.outcome &&
    stored.reason === expected.reason &&
    comparableEvidence(stored.evidence) === comparableEvidence(expected.evidence)
  );
}

export function scoreContentMatches(
  stored: { sourceId: string; version: number; hits: number; misses: number; triggeredByClaimId: string | null },
  expected: { sourceId: string; version: number; hits: number; misses: number; triggeredByClaimId: string | null },
): boolean {
  return (
    stored.sourceId === expected.sourceId &&
    stored.version === expected.version &&
    stored.hits === expected.hits &&
    stored.misses === expected.misses &&
    stored.triggeredByClaimId === expected.triggeredByClaimId
  );
}

export function formatResolveLine(report: {
  handle: string;
  claimId: string;
  externalId?: string | null;
  outcome: string;
  reason: string;
  skipped?: string;
}): string {
  const ext = report.externalId ? ` ${report.externalId}` : "";
  const skip = report.skipped ? ` (${report.skipped})` : "";
  return `${report.handle} ${report.claimId}${ext} ${report.outcome}${skip}: ${report.reason}`;
}

/**
 * `npm run list:memories` counts the relayer list. The homepage figure is
 * `memory_log`. The two numbers are not interchangeable.
 */
export function formatRelayerListLines(live: number, counts?: Record<string, number>): string[] {
  const lines = [
    `relayer live ${live}`,
    "note       relayer list: every live memory on this delegate, all namespaces, including blobs never written to Postgres",
    'note       homepage "memories · logged" is the Postgres memory_log row count. It is a different set, taken at that moment. An earlier inventory is not this live total.',
  ];
  if (counts) {
    const smoke = counts["walkback.smoke"] ?? 0;
    const timing = counts["walkback.timing"] ?? 0;
    const script = smoke + timing;
    lines.push(
      `note       script probes: walkback.smoke ${smoke}, walkback.timing ${timing} (${script} total). scripts/smoke.ts and scripts/timing.ts wrote these. They are not product memories and they are not in memory_log.`,
    );
    lines.push(`note       product namespaces in this list: ${live - script}.`);
  } else {
    lines.push(
      "note       walkback.smoke and walkback.timing are script probes. They are part of this live total and are not part of memory_log.",
    );
  }
  return lines;
}
