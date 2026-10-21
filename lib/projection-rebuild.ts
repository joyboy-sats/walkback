/**
 * Rebuild the Postgres projection from Walrus Memory.
 *
 * Walrus is the system of record. This module reads memories back and turns
 * the fenced JSON that `lib/memory-text.ts` writes into sources, claims,
 * resolutions and score versions. Trust is recomputed from verdicts with
 * `computeScore`; a stored score that disagrees with the verdicts loses.
 *
 * The inventory is `GET /v1/owners/:owner/memories`, paged until `has_more`
 * is false. That payload is metadata. Plaintext comes from `recall()` and is
 * matched to the listed blob ids (the relayer's only decrypting read, capped
 * at 100 hits per namespace). Coverage is complete when every live product
 * blob id has text and recall did not add blob ids the list did not have.
 * Replace (TRUNCATE + rebuild) runs only then, and only after confirm.
 *
 * If that route is missing, the older multi-query recall sample is the
 * report. It is marked `recall-fallback` and cannot replace the projection.
 */
import "server-only";

import { NS, type ClaimType, type Namespace, type Outcome } from "./types";
import { applyOutcome, computeScore, type TrustBand } from "./score";
import { stableUuid } from "./ids";
import {
  contentPlan,
  finishInventory,
  isListUnavailable,
  type HydratedText,
  type InventoryAssessment,
  type ListWalkResult,
} from "./memory-list";

/** Large on purpose. Demo namespaces are tens of memories, not thousands. */
export const RECALL_LIMIT = 200;

export const LIST_ENUMERATION_NOTE =
  "Verify pages GET /v1/owners/:owner/memories until has_more is false. That list is metadata " +
  "(blob id, namespace, tombstones), so plaintext is loaded with recall() and matched to those " +
  "blob ids. Coverage is exact: every live product-namespace blob id must come back with text, " +
  "and recall must not add blob ids the list did not have. The relayer decrypts at most 100 hits " +
  "per recall, so a larger namespace stays incomplete. walkback.smoke and walkback.timing are " +
  "excluded. walkback.score is not decrypted: each version is the Wilson bound replayed over " +
  "resolutions, so a long score history does not have to fit in one recall. Replace also stays " +
  "off when any of sources, claims, resolutions, or score versions would shrink, when the " +
  "rebuilt rows have an orphan, or when a seed post has no applied_at. allowShrink overrides " +
  "only the shrink check. If the list route is missing, the report is a marked recall sample " +
  "and Replace stays off.";

/** @deprecated Use LIST_ENUMERATION_NOTE. Kept so older imports still compile. */
export const RECALL_ENUMERATION_LIMIT = LIST_ENUMERATION_NOTE;

export const RECALL_FALLBACK_NOTE =
  "Listing was unavailable (this relayer has no GET /v1/owners/:owner/memories). " +
  "The figures below are a recall sample, not a full inventory. Replace stays off.";

/** Namespaces written by scripts/smoke.ts and scripts/timing.ts. Not product data. */
export const EXCLUDED_NAMESPACES = ["walkback.smoke", "walkback.timing"] as const;

const PLATFORMS = ["x", "substack", "rss", "onchain", "other"] as const;
type Platform = (typeof PLATFORMS)[number];

const CLAIM_TYPES: readonly ClaimType[] = [
  "balance_threshold",
  "balance_change_since_ingest",
  "tx_replay",
  "price_threshold",
  "manual",
];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecallQuery {
  namespace: Namespace;
  query: string;
  sort: "relevance" | "recent";
  limit: number;
}

/**
 * Several distinct queries per namespace. The wording is taken from the
 * sentences `memory-text.ts` actually writes, plus a broad query ordered by
 * recency so a memory that matches the prose poorly still has a second chance.
 * This is best-effort. It is not a scan.
 */
export function recallPlan(): RecallQuery[] {
  const specific: Record<Namespace, string> = {
    [NS.source]: "SOURCE was added to Walkback platform address trust",
    [NS.claim]: "CLAIM deadline snapshot receipt extraction confidence balance",
    [NS.resolution]: "RESOLUTION VERDICT could not check void trust hits misses",
    [NS.score]: "SCORE trust hits misses band muted trusted trigger",
    [NS.digest]: "DIGEST claims resolved could not be checked pending muted",
    [NS.tombstone]: "TOMBSTONE marked removed original memory remains",
  };
  const plan: RecallQuery[] = [];
  for (const namespace of Object.values(NS)) {
    plan.push({ namespace, query: specific[namespace], sort: "relevance", limit: RECALL_LIMIT });
    plan.push({ namespace, query: specific[namespace], sort: "recent", limit: RECALL_LIMIT });
    plan.push({
      namespace,
      query: "Walkback claim verdict snapshot SUI balance score",
      sort: "relevance",
      limit: RECALL_LIMIT,
    });
    plan.push({ namespace, query: "Walkback", sort: "recent", limit: RECALL_LIMIT });
  }
  return plan;
}

export interface GatheredMemory {
  blobId: string;
  text: string;
  namespace: string;
  createdAt?: string;
}

export interface Gathered {
  memories: GatheredMemory[];
  rawHits: number;
  duplicatesDropped: number;
}

interface RecallHitLike {
  blobId: string;
  text: string;
  createdAt?: string;
}

/**
 * Run the plan and dedupe on `blob_id`. The first time a blob is seen wins;
 * later copies from other queries are dropped. The result is sorted by blob
 * id so a shuffled recall order cannot change the projection.
 */
export async function gatherMemories(
  recall: (q: RecallQuery) => Promise<RecallHitLike[]>,
  plan: RecallQuery[] = recallPlan(),
): Promise<Gathered> {
  const byBlob = new Map<string, GatheredMemory>();
  let rawHits = 0;
  for (const q of plan) {
    const hits = await recall(q);
    for (const hit of hits) {
      if (!hit.blobId) continue;
      rawHits++;
      if (byBlob.has(hit.blobId)) continue;
      const memory: GatheredMemory = {
        blobId: hit.blobId,
        text: hit.text,
        namespace: q.namespace,
      };
      if (hit.createdAt) memory.createdAt = hit.createdAt;
      byBlob.set(hit.blobId, memory);
    }
  }
  const memories = [...byBlob.values()].sort((a, b) => a.blobId.localeCompare(b.blobId));
  return { memories, rawHits, duplicatesDropped: rawHits - memories.length };
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

export interface RebuiltSource {
  id: string;
  handle: string;
  platform: Platform;
  suiAddress: string | null;
  createdAt: string;
  walrusBlobId: string;
  hits: number;
  misses: number;
  score: number;
  hitRate: number;
  band: TrustBand;
  muted: boolean;
}

export interface RebuiltClaim {
  id: string;
  sourceId: string;
  sourceHandle: string;
  quote: string;
  claimType: ClaimType;
  params: Record<string, unknown>;
  snapshot: Record<string, unknown> | null;
  deadline: string;
  confidence: number;
  status: "pending" | "resolved" | "void";
  synthetic: boolean;
  externalId: string | null;
  sourceUrl: string | null;
  deadlineBasis: string | null;
  walrusBlobId: string;
  createdAt: string;
}

export interface RebuiltResolution {
  claimId: string;
  outcome: Outcome;
  reason: string;
  evidence: Record<string, unknown>;
  walrusBlobId: string;
  resolvedAt: string;
  /** 1 when the memory predates revisions. The highest revision is the verdict. */
  revision: number;
}

export interface RebuiltScoreVersion {
  sourceId: string;
  version: number;
  hits: number;
  misses: number;
  score: number;
  hitRate: number;
  triggeredByClaimId: string | null;
  reason: string;
  /** Null when the version was recomputed from resolutions and the score blob was not decrypted. */
  walrusBlobId: string | null;
  createdAt: string;
}

export interface ProjectionOrphan {
  kind: "claim" | "resolution" | "score";
  id: string;
  detail: string;
}

export interface RebuiltMemoryLog {
  kind: "source" | "claim" | "resolution" | "score" | "digest" | "tombstone";
  refId: string | null;
  namespace: string;
  blobId: string;
  textPreview: string;
  writtenAt: string;
}

export interface Projection {
  sources: RebuiltSource[];
  claims: RebuiltClaim[];
  resolutions: RebuiltResolution[];
  scoreVersions: RebuiltScoreVersion[];
  memoryLog: RebuiltMemoryLog[];
  skipped: Array<{ blobId: string; reason: string }>;
  duplicatesDropped: number;
  notes: string[];
  orphans: ProjectionOrphan[];
}

interface Tombstone {
  refId: string;
  refKind: "source" | "claim";
}

/**
 * Turn recalled memories into projection rows.
 *
 * Duplicate blob ids collapse. Duplicate domain ids (the same claim written
 * twice under two blobs) keep the lowest blob id. A memory whose JSON cannot
 * be parsed is skipped and counted; it does not fail the rebuild. Scores on
 * the source rows are recomputed from `true` and `false` resolutions. `void`
 * does not count.
 */
export function projectMemories(input: readonly GatheredMemory[]): Projection {
  const sorted = [...input].sort((a, b) => a.blobId.localeCompare(b.blobId));
  const seen = new Set<string>();
  const unique: GatheredMemory[] = [];
  let duplicatesDropped = 0;
  for (const mem of sorted) {
    if (seen.has(mem.blobId)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(mem.blobId);
    unique.push(mem);
  }

  const skipped: Array<{ blobId: string; reason: string }> = [];
  const sources = new Map<string, RebuiltSource>();
  const sourcesByHandle = new Map<string, RebuiltSource>();
  const claims = new Map<string, RebuiltClaim>();
  const resolutions = new Map<string, RebuiltResolution>();
  const scoreVersions: RebuiltScoreVersion[] = [];
  const scoreKey = new Set<string>();
  const tombstones: Tombstone[] = [];
  const memoryLog: RebuiltMemoryLog[] = [];

  for (const mem of unique) {
    const payload = parseFencedJson(mem.text);
    if (!payload) {
      skipped.push({ blobId: mem.blobId, reason: "malformed JSON" });
      const kind = kindFromNamespace(mem.namespace);
      if (kind) memoryLog.push(logRow(mem, kind, null));
      continue;
    }

    const kind = typeof payload.kind === "string" ? payload.kind : kindFromNamespace(mem.namespace);
    if (
      kind === "source" ||
      kind === "claim" ||
      kind === "resolution" ||
      kind === "score" ||
      kind === "digest" ||
      kind === "tombstone"
    ) {
      memoryLog.push(logRow(mem, kind, refFromPayload(kind, payload)));
    }

    switch (kind) {
      case "source":
        addSource(mem, payload, sources, sourcesByHandle, skipped);
        break;
      case "claim":
        addClaim(mem, payload, claims, skipped);
        break;
      case "resolution":
        addResolution(mem, payload, resolutions, skipped);
        break;
      case "score":
        addScore(mem, payload, scoreVersions, scoreKey, skipped);
        break;
      case "tombstone":
        addTombstone(payload, tombstones);
        break;
      case "digest":
        break;
      default:
        skipped.push({ blobId: mem.blobId, reason: "unknown memory kind" });
    }
  }

  const notes: string[] = [];
  const orphans: ProjectionOrphan[] = [];
  const deadSources = new Set(
    tombstones.filter((t) => t.refKind === "source").map((t) => t.refId),
  );
  const deadClaims = new Set(
    tombstones.filter((t) => t.refKind === "claim").map((t) => t.refId),
  );

  for (const claim of claims.values()) {
    const source = sourcesByHandle.get(claim.sourceHandle);
    if (source) {
      claim.sourceId = source.id;
      continue;
    }
    const id = stableUuid(`source:${claim.sourceHandle}`);
    const created = blankSource(id, claim.sourceHandle, claim.walrusBlobId, claim.createdAt);
    sources.set(id, created);
    sourcesByHandle.set(claim.sourceHandle, created);
    claim.sourceId = id;
    orphans.push({
      kind: "claim",
      id: claim.id,
      detail: `no source memory for ${claim.sourceHandle}`,
    });
    notes.push(
      `no source memory for ${claim.sourceHandle}; rebuilt a source row from its claims`,
    );
  }

  for (const id of deadSources) sources.delete(id);
  for (const [id, claim] of claims) {
    if (deadClaims.has(id) || deadSources.has(claim.sourceId) || !sources.has(claim.sourceId)) {
      claims.delete(id);
      deadClaims.add(id);
    }
  }
  for (const claimId of resolutions.keys()) {
    if (!claims.has(claimId)) {
      if (!deadClaims.has(claimId)) {
        orphans.push({
          kind: "resolution",
          id: claimId,
          detail: "claim is not in the projection",
        });
      }
      resolutions.delete(claimId);
    }
  }
  const liveScores = scoreVersions.filter((v) => sources.has(v.sourceId));

  for (const claim of claims.values()) {
    const resolution = resolutions.get(claim.id);
    claim.status = !resolution
      ? "pending"
      : resolution.outcome === "void"
        ? "void"
        : "resolved";
  }

  for (const source of sources.values()) {
    let hits = 0;
    let misses = 0;
    for (const claim of claims.values()) {
      if (claim.sourceId !== source.id) continue;
      const resolution = resolutions.get(claim.id);
      if (!resolution || resolution.outcome === "void") continue;
      if (resolution.outcome === "true") hits++;
      else misses++;
    }
    const score = computeScore(hits, misses);
    source.hits = score.hits;
    source.misses = score.misses;
    source.score = score.score;
    source.hitRate = score.hitRate;
    source.band = score.band;
    source.muted = score.band === "muted";

  }

  const scoreVersionsDerived = deriveScoreVersions({
    claims: [...claims.values()],
    resolutions: [...resolutions.values()],
    recalled: liveScores,
  });
  for (const version of scoreVersionsDerived) {
    const prior = liveScores.find((row) => row.sourceId === version.sourceId && row.version === version.version);
    if (
      prior &&
      (prior.hits !== version.hits ||
        prior.misses !== version.misses ||
        Math.abs(prior.score - version.score) > 1e-9)
    ) {
      const handle = [...sources.values()].find((source) => source.id === version.sourceId)?.handle;
      notes.push(
        `${handle ?? version.sourceId}: score memory v${version.version} disagrees with the verdicts; ` +
          `the projection uses the recomputed score ${version.score.toFixed(4)}`,
      );
    }
    if (version.triggeredByClaimId && !claims.has(version.triggeredByClaimId)) {
      orphans.push({
        kind: "score",
        id: `${version.sourceId}:v${version.version}`,
        detail: "triggered claim is not in the projection",
      });
    }
    if (!sources.has(version.sourceId)) {
      orphans.push({
        kind: "score",
        id: `${version.sourceId}:v${version.version}`,
        detail: "source is not in the projection",
      });
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => a.handle.localeCompare(b.handle)),
    claims: [...claims.values()].sort((a, b) => a.id.localeCompare(b.id)),
    resolutions: [...resolutions.values()].sort((a, b) => a.claimId.localeCompare(b.claimId)),
    scoreVersions: scoreVersionsDerived,
    memoryLog: memoryLog.sort((a, b) => a.blobId.localeCompare(b.blobId)),
    skipped,
    duplicatesDropped,
    notes,
    orphans,
  };
}

/**
 * Score versions are the Wilson bound replayed over resolutions.
 * A void does not add a version. Order is resolution time, then claim id.
 * Recalled score blobs are attached when the version number matches; they
 * are not required, so `walkback.score` does not have to fit in one recall.
 */
export function deriveScoreVersions(input: {
  claims: readonly { id: string; sourceId: string }[];
  resolutions: readonly { claimId: string; outcome: Outcome; resolvedAt: string }[];
  recalled?: readonly RebuiltScoreVersion[];
}): RebuiltScoreVersion[] {
  const sourceOf = new Map(input.claims.map((claim) => [claim.id, claim.sourceId]));
  const bySource = new Map<string, Array<{ claimId: string; outcome: Outcome; resolvedAt: string }>>();
  for (const resolution of input.resolutions) {
    const sourceId = sourceOf.get(resolution.claimId);
    if (!sourceId) continue;
    const rows = bySource.get(sourceId) ?? [];
    rows.push(resolution);
    bySource.set(sourceId, rows);
  }
  const recalled = new Map((input.recalled ?? []).map((version) => [`${version.sourceId}:${version.version}`, version]));
  const versions: RebuiltScoreVersion[] = [];
  for (const [sourceId, rows] of bySource) {
    rows.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.claimId.localeCompare(b.claimId));
    let hits = 0;
    let misses = 0;
    let version = 0;
    for (const row of rows) {
      const before = computeScore(hits, misses);
      const after = applyOutcome(hits, misses, row.outcome);
      hits = after.hits;
      misses = after.misses;
      if (after.adjudicated === before.adjudicated) continue;
      version += 1;
      const prior = recalled.get(`${sourceId}:${version}`);
      versions.push({
        sourceId,
        version,
        hits: after.hits,
        misses: after.misses,
        score: after.score,
        hitRate: after.hitRate,
        triggeredByClaimId: row.claimId,
        reason: prior?.reason ?? `claim resolved ${row.outcome}`,
        walrusBlobId: prior?.walrusBlobId ?? null,
        createdAt: row.resolvedAt,
      });
    }
  }
  versions.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.version - b.version);
  return versions;
}

export const TABLE_NAMES = ["sources", "claims", "resolutions", "scoreVersions"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export interface TableDiff {
  table: TableName;
  before: number;
  after: number;
}

/**
 * Memories a demo writes, and which of them rebuild has to decrypt.
 * Score versions are one per non-void resolution and are recomputed, so they
 * are not in `decrypted`. Digest is not written by ingest or resolve.
 */
export function demoMemoryCounts(input: {
  sources: number;
  claims: number;
  nonVoidResolutions: number;
  voidResolutions?: number;
}): { written: Record<string, number>; decrypted: Record<string, number>; maxDecrypted: number } {
  const voids = input.voidResolutions ?? 0;
  const written: Record<string, number> = {
    [NS.source]: input.sources,
    [NS.claim]: input.claims,
    [NS.resolution]: input.nonVoidResolutions + voids,
    [NS.score]: input.nonVoidResolutions,
    [NS.digest]: 0,
    [NS.tombstone]: 0,
  };
  const decrypted: Record<string, number> = { ...written, [NS.score]: 0 };
  const maxDecrypted = Math.max(0, ...Object.values(decrypted));
  return { written, decrypted, maxDecrypted };
}

export function projectionDiff(before: Record<TableName, number>, after: Record<TableName, number>): TableDiff[] {
  return TABLE_NAMES.map((table) => ({ table, before: before[table], after: after[table] }));
}

export function replaceSafety(input: {
  tables: readonly TableDiff[];
  orphans: readonly ProjectionOrphan[];
  unappliedSeedPosts: readonly string[];
}): { shrinks: TableDiff[]; warning: string | null } {
  const shrinks = input.tables.filter((row) => row.after < row.before);
  const lines: string[] = [];
  if (shrinks.length > 0) {
    const detail = shrinks.map((row) => `${row.table} ${row.before} -> ${row.after}`).join("; ");
    lines.push(
      `rebuild would drop rows (${detail}). Replace stays off unless allowShrink is set.`,
    );
  }
  if (input.orphans.length > 0) {
    lines.push(`${input.orphans.length} orphan row(s) in the rebuilt projection. Replace stays off.`);
  }
  if (input.unappliedSeedPosts.length > 0) {
    lines.push(
      `${input.unappliedSeedPosts.length} seed post(s) have no applied_at. Replace stays off.`,
    );
  }
  return { shrinks, warning: lines.length > 0 ? lines.join(" ") : null };
}

export interface TruncationDecision {
  truncate: boolean;
  warning: string | null;
  gaps: Array<{ namespace: string; recalled: number; reported: number }>;
  /** Namespaces listNamespaces returned that are not part of the product schema. */
  excludedNamespaces: string[];
}

const PRODUCT_NAMESPACES = new Set<string>(Object.values(NS));

/**
 * Split relayer counts into the six product namespaces and everything else.
 * Test namespaces (`walkback.smoke`, `walkback.timing`) land in `excluded`
 * and are not coverage gaps.
 */
export function partitionNamespaceCounts(reported: Record<string, number> | null): {
  product: Record<string, number> | null;
  excluded: string[];
} {
  if (!reported) return { product: null, excluded: [] };
  const excluded = Object.keys(reported)
    .filter((name) => !PRODUCT_NAMESPACES.has(name))
    .sort();
  const product: Record<string, number> = {};
  for (const name of PRODUCT_NAMESPACES) product[name] = reported[name] ?? 0;
  return { product, excluded };
}

/**
 * Whether it is safe to drop the projection.
 *
 * An empty recall must not wipe Postgres. A missing count must not wipe it
 * either. A shortfall on a product namespace is the same refusal. Counts in
 * other namespaces, including the smoke and timing scripts, are ignored.
 */
export function decideTruncation(input: {
  unique: number;
  recalledByNamespace: Record<string, number>;
  reportedByNamespace: Record<string, number> | null;
}): TruncationDecision {
  const { product, excluded } = partitionNamespaceCounts(input.reportedByNamespace);
  if (input.unique === 0) {
    return {
      truncate: false,
      gaps: [],
      excludedNamespaces: excluded,
      warning: "recall returned no memories, so the projection was not modified.",
    };
  }
  if (!product) {
    return {
      truncate: false,
      gaps: [],
      excludedNamespaces: excluded,
      warning:
        "namespace counts could not be read, so completeness is unknown and the projection was not modified.",
    };
  }
  const gaps: TruncationDecision["gaps"] = [];
  for (const namespace of Object.values(NS)) {
    const reported = product[namespace] ?? 0;
    const recalled = input.recalledByNamespace[namespace] ?? 0;
    if (recalled < reported) gaps.push({ namespace, recalled, reported });
  }
  if (gaps.length > 0) {
    const detail = gaps
      .map((g) => `${g.namespace} recalled ${g.recalled} of ${g.reported}`)
      .join("; ");
    return {
      truncate: false,
      gaps,
      excludedNamespaces: excluded,
      warning:
        `recall did not return every indexed product memory (${detail}). ` +
        `The projection was not modified.`,
    };
  }
  return { truncate: true, gaps: [], excludedNamespaces: excluded, warning: null };
}

export function rebuildAllowed(input: {
  mode: "verify" | "rebuild";
  confirm: boolean;
  coverageComplete: boolean;
  enumeration?: "list" | "recall-fallback";
  shrinks?: boolean;
  orphans?: boolean;
  unappliedSeed?: boolean;
  allowShrink?: boolean;
  /** No live memories in the namespaces rebuild decrypts. Smoke and timing do not count. */
  emptyInventory?: boolean;
}): { truncate: boolean; reason: string } {
  if (input.enumeration === "recall-fallback") {
    return {
      truncate: false,
      reason: "the list route was unavailable, so the recall fallback cannot replace the projection",
    };
  }
  if (input.mode !== "rebuild") {
    return { truncate: false, reason: "verify reads Walrus and leaves Postgres as it is" };
  }
  if (!input.coverageComplete) {
    return { truncate: false, reason: "coverage is incomplete, so the projection was not replaced" };
  }
  if (input.emptyInventory) {
    return {
      truncate: false,
      reason: "the product namespaces listed no memories, so the projection was not replaced",
    };
  }
  if (input.unappliedSeed) {
    return { truncate: false, reason: "a seed post has no applied_at, so the projection was not replaced" };
  }
  if (input.orphans) {
    return { truncate: false, reason: "the rebuilt projection has orphan rows, so it was not replaced" };
  }
  if (input.shrinks && !input.allowShrink) {
    return {
      truncate: false,
      reason: "the rebuild would drop rows that Postgres still has, so the projection was not replaced",
    };
  }
  if (!input.confirm) {
    return { truncate: false, reason: "coverage is complete; replace was not confirmed" };
  }
  if (input.shrinks && input.allowShrink) {
    return { truncate: true, reason: "allowShrink was set, so a smaller projection replaced Postgres" };
  }
  return { truncate: true, reason: "coverage is complete and replace was confirmed" };
}

export interface StoredSourceRow {
  id: string;
  handle: string;
  score: number;
  hits: number;
  misses: number;
  walrusBlobId: string | null;
}

export interface StoredClaimRow {
  id: string;
  quote: string;
  status: string;
  synthetic: boolean;
  walrusBlobId: string | null;
}

export interface StoredResolutionRow {
  claimId: string;
  outcome: string;
}

export interface VerifyComparison {
  matched: number;
  mismatched: number;
  missingFromRecall: number;
  recalledNotInPostgres: number;
  mismatches: Array<{ kind: string; id: string; detail: string }>;
  missing: Array<{ kind: string; id: string }>;
  scores: Array<{
    sourceId: string;
    handle: string;
    storedScore: number;
    recomputedScore: number | null;
    agree: boolean;
  }>;
  notes: string[];
}

/**
 * Compare one recalled projection with the rows Postgres already has.
 * Score agreement uses the score recomputed from recalled verdicts.
 */
export function compareWithStored(input: {
  recalled: Projection;
  sources: readonly StoredSourceRow[];
  claims: readonly StoredClaimRow[];
  resolutions: readonly StoredResolutionRow[];
}): VerifyComparison {
  const mismatches: VerifyComparison["mismatches"] = [];
  const missing: VerifyComparison["missing"] = [];
  let matched = 0;
  let mismatched = 0;
  let missingFromRecall = 0;

  const recalledSources = new Map(input.recalled.sources.map((s) => [s.id, s]));
  const recalledClaims = new Map(input.recalled.claims.map((c) => [c.id, c]));
  const recalledResolutions = new Map(input.recalled.resolutions.map((r) => [r.claimId, r]));

  for (const row of input.sources) {
    const got = recalledSources.get(row.id);
    if (!got) {
      missingFromRecall++;
      missing.push({ kind: "source", id: row.id });
      continue;
    }
    if (got.handle !== row.handle) {
      mismatched++;
      mismatches.push({ kind: "source", id: row.id, detail: `handle ${row.handle} vs ${got.handle}` });
    } else matched++;
  }
  for (const row of input.claims) {
    const got = recalledClaims.get(row.id);
    if (!got) {
      missingFromRecall++;
      missing.push({ kind: "claim", id: row.id });
      continue;
    }
    const details: string[] = [];
    if (got.quote !== row.quote) details.push("quote");
    if (got.status !== row.status) details.push(`status ${row.status} vs ${got.status}`);
    if (got.synthetic !== row.synthetic) details.push("synthetic");
    if (row.walrusBlobId && got.walrusBlobId && row.walrusBlobId !== got.walrusBlobId) details.push("blob id");
    if (details.length) {
      mismatched++;
      mismatches.push({ kind: "claim", id: row.id, detail: details.join(", ") });
    } else matched++;
  }
  for (const row of input.resolutions) {
    const got = recalledResolutions.get(row.claimId);
    if (!got) {
      missingFromRecall++;
      missing.push({ kind: "resolution", id: row.claimId });
      continue;
    }
    if (got.outcome !== row.outcome) {
      mismatched++;
      mismatches.push({
        kind: "resolution",
        id: row.claimId,
        detail: `outcome ${row.outcome} vs ${got.outcome}`,
      });
    } else matched++;
  }

  const storedSourceIds = new Set(input.sources.map((s) => s.id));
  const storedClaimIds = new Set(input.claims.map((c) => c.id));
  const storedResolutionIds = new Set(input.resolutions.map((r) => r.claimId));
  let recalledNotInPostgres = 0;
  for (const row of input.recalled.sources) {
    if (!storedSourceIds.has(row.id)) recalledNotInPostgres++;
  }
  for (const row of input.recalled.claims) {
    if (!storedClaimIds.has(row.id)) recalledNotInPostgres++;
  }
  for (const row of input.recalled.resolutions) {
    if (!storedResolutionIds.has(row.claimId)) recalledNotInPostgres++;
  }

  const notes = [
    "missing-from-recall means recall did not surface the record. It does not mean Walrus lacks it.",
  ];
  const scores = input.sources.map((row) => {
    const got = recalledSources.get(row.id);
    if (!got) {
      notes.push(
        `${row.handle}: recall did not surface this source, so its stored score was not recomputed from verdicts`,
      );
      return {
        sourceId: row.id,
        handle: row.handle,
        storedScore: row.score,
        recomputedScore: null,
        agree: false,
      };
    }
    const agree =
      Math.abs(got.score - row.score) < 1e-6 && got.hits === row.hits && got.misses === row.misses;
    return {
      sourceId: row.id,
      handle: row.handle,
      storedScore: row.score,
      recomputedScore: got.score,
      agree,
    };
  });

  return {
    matched,
    mismatched,
    missingFromRecall,
    recalledNotInPostgres,
    mismatches,
    missing,
    scores,
    notes,
  };
}

export interface ProjectionReport {
  mode: "verify" | "rebuild";
  /** `list` paged the inventory. `recall-fallback` means that route was missing. */
  enumeration: "list" | "recall-fallback";
  truncated: boolean;
  warning: string | null;
  limitation: string;
  notes: string[];
  matched: number;
  mismatched: number;
  missingFromRecall: number;
  recalledNotInPostgres: number;
  mismatches: VerifyComparison["mismatches"];
  missing: VerifyComparison["missing"];
  scores: VerifyComparison["scores"];
  coverageComplete: boolean;
  excludedNamespaces: string[];
  duplicatesDropped: number;
  skipped: Array<{ blobId: string; reason: string }>;
  counts: {
    sources: number;
    claims: number;
    resolutions: number;
    scoreVersions: number;
    memoryLog: number;
  };
  /** Per-table sizes before (Postgres) and after (rebuilt projection). */
  tables: TableDiff[];
  orphans: ProjectionOrphan[];
  unappliedSeedPosts: string[];
  /** True when a confirmed rebuild would truncate. Verify sets this so the button can follow the same gates. */
  replaceAllowed: boolean;
  coverage: {
    rawHits: number;
    unique: number;
    byNamespace: Record<string, number>;
    reported: Record<string, number> | null;
    gaps: Array<{ namespace: string; recalled: number; reported: number }>;
  };
}

/**
 * Read Walrus and compare it with Postgres. The default mode is verify, which
 * never truncates. `rebuild` replaces the projection only when coverage of the
 * product namespaces is complete and `confirm` is set.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyCoverage(): ProjectionReport["coverage"] {
  return { rawHits: 0, unique: 0, byNamespace: {}, reported: {}, gaps: [] };
}

function unfinishedReport(input: {
  mode: "verify" | "rebuild";
  enumeration: "list" | "recall-fallback";
  warning: string;
  limitation: string;
}): ProjectionReport {
  return {
    mode: input.mode,
    enumeration: input.enumeration,
    truncated: false,
    warning: input.warning,
    limitation: input.limitation,
    notes: [],
    matched: 0,
    mismatched: 0,
    missingFromRecall: 0,
    recalledNotInPostgres: 0,
    mismatches: [],
    missing: [],
    scores: [],
    coverageComplete: false,
    excludedNamespaces: [],
    duplicatesDropped: 0,
    skipped: [],
    counts: { sources: 0, claims: 0, resolutions: 0, scoreVersions: 0, memoryLog: 0 },
    tables: [],
    orphans: [],
    unappliedSeedPosts: [],
    replaceAllowed: false,
    coverage: emptyCoverage(),
  };
}

async function finishReport(input: {
  mode: "verify" | "rebuild";
  confirm: boolean;
  enumeration: "list" | "recall-fallback";
  limitation: string;
  assessment: InventoryAssessment;
  rawHits: number;
  extraNotes: string[];
  duplicatesDropped?: number;
  allowShrink?: boolean;
  stored: {
    sources: StoredSourceRow[];
    claims: StoredClaimRow[];
    resolutions: StoredResolutionRow[];
    scoreVersionCount: number;
    unappliedSeedIds: string[];
  };
}): Promise<ProjectionReport> {
  const gathered = input.assessment.memories.map((memory) => ({
    blobId: memory.blobId,
    text: memory.text,
    namespace: memory.namespace,
    ...(memory.createdAt ? { createdAt: memory.createdAt } : {}),
  }));
  const projection = projectMemories(gathered);
  const comparison = compareWithStored({
    recalled: projection,
    sources: input.stored.sources,
    claims: input.stored.claims,
    resolutions: input.stored.resolutions,
  });
  const tables = projectionDiff(
    {
      sources: input.stored.sources.length,
      claims: input.stored.claims.length,
      resolutions: input.stored.resolutions.length,
      scoreVersions: input.stored.scoreVersionCount,
    },
    {
      sources: projection.sources.length,
      claims: projection.claims.length,
      resolutions: projection.resolutions.length,
      scoreVersions: projection.scoreVersions.length,
    },
  );
  const safety = replaceSafety({
    tables,
    orphans: projection.orphans,
    unappliedSeedPosts: input.stored.unappliedSeedIds,
  });
  const emptyInventory = plaintextNamespaces().every(
    (namespace) => (input.assessment.listedByNamespace[namespace] ?? 0) === 0,
  );
  const gate = {
    coverageComplete: input.assessment.coverageComplete,
    enumeration: input.enumeration,
    shrinks: safety.shrinks.length > 0,
    orphans: projection.orphans.length > 0,
    unappliedSeed: input.stored.unappliedSeedIds.length > 0,
    allowShrink: input.allowShrink === true,
    emptyInventory,
  };
  const allowed = rebuildAllowed({ mode: input.mode, confirm: input.confirm, ...gate });
  const replaceAllowed = rebuildAllowed({ mode: "rebuild", confirm: true, ...gate }).truncate;
  if (allowed.truncate) await applyProjection(projection);

  const warning = [
    input.assessment.warning,
    safety.warning,
    input.mode === "verify" ? allowed.reason : allowed.truncate ? null : allowed.reason,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");

  const notes = comparison.notes.filter((note) => !note.includes("does not mean Walrus lacks it"));
  if (input.enumeration === "list" && input.assessment.coverageComplete) {
    notes.push("Every listed product memory was read. A row missing here is not in that inventory.");
  } else if (input.enumeration === "list") {
    notes.push("Coverage is incomplete, so a row missing from this report may still be on Walrus.");
  } else {
    notes.push("Listing was unavailable. These figures are a recall sample, not a full inventory.");
  }

  return {
    mode: input.mode,
    enumeration: input.enumeration,
    truncated: allowed.truncate,
    warning: warning || null,
    limitation: input.limitation,
    notes: [...notes, ...projection.notes, ...input.extraNotes],
    matched: comparison.matched,
    mismatched: comparison.mismatched,
    missingFromRecall: comparison.missingFromRecall,
    recalledNotInPostgres: comparison.recalledNotInPostgres,
    mismatches: comparison.mismatches,
    missing: comparison.missing,
    scores: comparison.scores,
    coverageComplete: input.enumeration === "list" && input.assessment.coverageComplete,
    excludedNamespaces: input.assessment.excludedNamespaces,
    duplicatesDropped: projection.duplicatesDropped + (input.duplicatesDropped ?? 0),
    skipped: projection.skipped,
    counts: {
      sources: projection.sources.length,
      claims: projection.claims.length,
      resolutions: projection.resolutions.length,
      scoreVersions: projection.scoreVersions.length,
      memoryLog: projection.memoryLog.length,
    },
    tables,
    orphans: projection.orphans,
    unappliedSeedPosts: input.stored.unappliedSeedIds,
    replaceAllowed,
    coverage: {
      rawHits: input.rawHits,
      unique: input.assessment.memories.length,
      byNamespace: input.assessment.hydratedByNamespace,
      reported: input.assessment.listedByNamespace,
      gaps: input.assessment.gaps,
    },
  };
}

async function hydrateListed(
  walk: ListWalkResult,
): Promise<{ texts: HydratedText[]; rawHits: number; hydrationError?: string }> {
  const { recallMemory } = await import("./memwal");
  const { memwalReadLimiter } = await import("./ratelimit");
  const plan = contentPlan({
    memories: walk.memories,
    deleted: walk.deleted,
    productNamespaces: plaintextNamespaces(),
  });
  const texts: HydratedText[] = [];
  let rawHits = 0;
  for (const query of plan) {
    try {
      await memwalReadLimiter.acquire();
      const hits = await recallMemory({
        query: query.query,
        namespace: query.namespace as Namespace,
        limit: query.limit,
        sort: query.sort,
      });
      for (const hit of hits) {
        rawHits += 1;
        texts.push({
          blobId: hit.blobId,
          text: hit.text,
          namespace: query.namespace,
          ...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
        });
      }
    } catch (err) {
      return {
        texts,
        rawHits,
        hydrationError: `plaintext recall failed (${errorMessage(err)}). The projection was not modified.`,
      };
    }
  }
  return { texts, rawHits };
}

/** Product namespaces whose plaintext rebuild must load. Score is derived. */
export function plaintextNamespaces(): string[] {
  return Object.values(NS).filter((namespace) => namespace !== NS.score);
}

export async function rebuildProjection(opts?: {
  mode?: "verify" | "rebuild";
  confirm?: boolean;
  /** Replace even when a table would shrink. Does not bypass orphans or an unfinished seed. */
  allowShrink?: boolean;
}): Promise<ProjectionReport> {
  const mode = opts?.mode === "rebuild" ? "rebuild" : "verify";
  const confirm = opts?.confirm === true;
  const allowShrink = opts?.allowShrink === true;
  const { listAllMemories } = await import("./memwal");

  let walk: ListWalkResult;
  try {
    walk = await listAllMemories();
  } catch (err) {
    if (isListUnavailable(err)) return rebuildFromRecallFallback(mode, confirm, allowShrink);
    return unfinishedReport({
      mode,
      enumeration: "list",
      limitation: LIST_ENUMERATION_NOTE,
      warning: `memory list failed before coverage was complete: ${errorMessage(err)}. The projection was not modified.`,
    });
  }

  const hydrated = await hydrateListed(walk);
  const assessment = finishInventory({
    walk,
    texts: hydrated.texts,
    productNamespaces: Object.values(NS),
    plaintextNamespaces: plaintextNamespaces(),
    ...(hydrated.hydrationError ? { hydrationError: hydrated.hydrationError } : {}),
  });
  const stored = await readStoredRows();
  const extraNotes = [
    `Listed ${walk.memories.length} memories and ${walk.deleted.length} tombstones across ${walk.pages} page(s).`,
  ];
  if (walk.resyncs > 0) {
    extraNotes.push("The list cursor was older than tombstone retention, so the walk restarted without a cursor.");
  }
  return finishReport({
    mode,
    confirm,
    enumeration: "list",
    limitation: LIST_ENUMERATION_NOTE,
    assessment,
    rawHits: hydrated.rawHits,
    extraNotes,
    allowShrink,
    stored,
  });
}

async function rebuildFromRecallFallback(
  mode: "verify" | "rebuild",
  confirm: boolean,
  allowShrink: boolean,
): Promise<ProjectionReport> {
  const { recallMemory, listNamespaces } = await import("./memwal");
  const gathered = await gatherMemories((q) => recallMemory(q));

  let reported: Record<string, number> | null = null;
  try {
    const namespaces = await listNamespaces();
    reported = {};
    for (const n of namespaces) reported[n.name] = n.memoryCount;
  } catch {
    reported = null;
  }

  const byNamespace = countByNamespace(gathered.memories);
  const decision = decideTruncation({
    unique: gathered.memories.length,
    recalledByNamespace: byNamespace,
    reportedByNamespace: reported,
  });
  const { product, excluded } = partitionNamespaceCounts(reported);
  const listedByNamespace = product ?? byNamespace;
  const assessment: InventoryAssessment = {
    coverageComplete: false,
    warning: decision.warning,
    memories: gathered.memories.map((memory) => ({
      blobId: memory.blobId,
      text: memory.text,
      namespace: memory.namespace,
      ...(memory.createdAt ? { createdAt: memory.createdAt } : {}),
    })),
    gaps: decision.gaps,
    excludedNamespaces: excluded,
    listedByNamespace,
    hydratedByNamespace: byNamespace,
    deletedCount: 0,
    missingBlobIds: [],
    extraBlobIds: [],
  };
  const stored = await readStoredRows();
  return finishReport({
    mode,
    confirm,
    enumeration: "recall-fallback",
    limitation: RECALL_FALLBACK_NOTE,
    assessment,
    rawHits: gathered.rawHits,
    extraNotes: [],
    duplicatesDropped: gathered.duplicatesDropped,
    allowShrink,
    stored,
  });
}

async function readStoredRows(): Promise<{
  sources: StoredSourceRow[];
  claims: StoredClaimRow[];
  resolutions: StoredResolutionRow[];
  scoreVersionCount: number;
  unappliedSeedIds: string[];
}> {
  const { getDb } = await import("./db");
  const schema = await import("./db/schema");
  const { isNull, sql } = await import("drizzle-orm");
  const db = getDb();
  const [sources, claims, resolutions, scoreRows, unapplied] = await Promise.all([
    db
      .select({
        id: schema.sources.id,
        handle: schema.sources.handle,
        score: schema.sources.score,
        hits: schema.sources.hits,
        misses: schema.sources.misses,
        walrusBlobId: schema.sources.walrusBlobId,
      })
      .from(schema.sources),
    db
      .select({
        id: schema.claims.id,
        quote: schema.claims.quote,
        status: schema.claims.status,
        synthetic: schema.claims.synthetic,
        walrusBlobId: schema.claims.walrusBlobId,
      })
      .from(schema.claims),
    db
      .select({
        claimId: schema.resolutions.claimId,
        outcome: schema.resolutions.outcome,
      })
      .from(schema.resolutions),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.scoreVersions),
    db.select({ id: schema.seedPosts.id }).from(schema.seedPosts).where(isNull(schema.seedPosts.appliedAt)),
  ]);
  return {
    sources,
    claims,
    resolutions,
    scoreVersionCount: Number(scoreRows[0]?.n ?? 0),
    unappliedSeedIds: unapplied.map((row) => row.id),
  };
}

async function applyProjection(p: Projection): Promise<void> {
  const { getDb } = await import("./db");
  const schema = await import("./db/schema");
  const { sql } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE TABLE memory_log, score_versions, resolutions, claims, sources RESTART IDENTITY CASCADE`,
    );

    if (p.sources.length > 0) {
      await tx.insert(schema.sources).values(
        p.sources.map((s) => ({
          id: s.id,
          handle: s.handle,
          displayName: s.handle,
          platform: s.platform,
          suiAddress: s.suiAddress,
          hits: s.hits,
          misses: s.misses,
          score: s.score,
          muted: s.muted,
          createdAt: new Date(s.createdAt),
          walrusBlobId: s.walrusBlobId,
        })),
      );
    }

    if (p.claims.length > 0) {
      await tx.insert(schema.claims).values(
        p.claims.map((c) => ({
          id: c.id,
          sourceId: c.sourceId,
          quote: c.quote,
          claimType: c.claimType,
          params: c.params,
          snapshot: c.snapshot,
          deadline: new Date(c.deadline),
          status: c.status,
          confidence: c.confidence,
          synthetic: c.synthetic,
          externalId: c.externalId,
          sourceUrl: c.sourceUrl,
          deadlineBasis: c.deadlineBasis,
          createdAt: new Date(c.createdAt),
          walrusBlobId: c.walrusBlobId,
        })),
      );
    }

    if (p.resolutions.length > 0) {
      await tx.insert(schema.resolutions).values(
        p.resolutions.map((r) => ({
          id: randomUUID(),
          claimId: r.claimId,
          outcome: r.outcome,
          evidence: r.evidence,
          reason: r.reason,
          resolvedAt: new Date(r.resolvedAt),
          walrusBlobId: r.walrusBlobId,
        })),
      );
    }

    if (p.scoreVersions.length > 0) {
      await tx.insert(schema.scoreVersions).values(
        p.scoreVersions.map((v) => ({
          id: randomUUID(),
          sourceId: v.sourceId,
          version: v.version,
          hits: v.hits,
          misses: v.misses,
          score: v.score,
          hitRate: v.hitRate,
          triggeredByClaimId: v.triggeredByClaimId,
          reason: v.reason,
          createdAt: new Date(v.createdAt),
          walrusBlobId: v.walrusBlobId,
        })),
      );
    }

    if (p.memoryLog.length > 0) {
      await tx.insert(schema.memoryLog).values(
        p.memoryLog.map((m) => ({
          kind: m.kind,
          refId: m.refId,
          namespace: m.namespace,
          blobId: m.blobId,
          textPreview: m.textPreview,
          writtenAt: new Date(m.writtenAt),
        })),
      );
    }
  });
}

function countByNamespace(memories: readonly GatheredMemory[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of memories) counts[m.namespace] = (counts[m.namespace] ?? 0) + 1;
  return counts;
}

function kindFromNamespace(
  namespace: string,
): "source" | "claim" | "resolution" | "score" | "digest" | "tombstone" | null {
  switch (namespace) {
    case NS.source:
      return "source";
    case NS.claim:
      return "claim";
    case NS.resolution:
      return "resolution";
    case NS.score:
      return "score";
    case NS.digest:
      return "digest";
    case NS.tombstone:
      return "tombstone";
    default:
      return null;
  }
}

function logRow(
  mem: GatheredMemory,
  kind: RebuiltMemoryLog["kind"],
  refId: string | null,
): RebuiltMemoryLog {
  return {
    kind,
    refId,
    namespace: mem.namespace,
    blobId: mem.blobId,
    textPreview: mem.text.replace(/\s+/g, " ").slice(0, 180),
    writtenAt: mem.createdAt ?? new Date(0).toISOString(),
  };
}

function refFromPayload(kind: string, payload: Record<string, unknown>): string | null {
  const key =
    kind === "source" || kind === "score"
      ? payload.source_id
      : kind === "claim" || kind === "resolution"
        ? payload.claim_id
        : kind === "tombstone"
          ? payload.ref_id
          : null;
  return typeof key === "string" && UUID.test(key) ? key : null;
}

function addSource(
  mem: GatheredMemory,
  payload: Record<string, unknown>,
  sources: Map<string, RebuiltSource>,
  byHandle: Map<string, RebuiltSource>,
  skipped: Array<{ blobId: string; reason: string }>,
): void {
  const id = typeof payload.source_id === "string" ? payload.source_id : "";
  const handle = typeof payload.handle === "string" ? payload.handle : "";
  const platform = asPlatform(payload.platform);
  if (!UUID.test(id) || !handle || !platform) {
    skipped.push({ blobId: mem.blobId, reason: "source memory is missing id, handle, or platform" });
    return;
  }
  if (byHandle.has(handle)) {
    skipped.push({ blobId: mem.blobId, reason: `duplicate source handle ${handle}` });
    return;
  }
  if (sources.has(id)) {
    skipped.push({ blobId: mem.blobId, reason: `duplicate source id ${id}` });
    return;
  }
  const createdAt =
    typeof payload.created_at === "string" && !Number.isNaN(Date.parse(payload.created_at))
      ? new Date(payload.created_at).toISOString()
      : (mem.createdAt ?? new Date(0).toISOString());
  const row = blankSource(id, handle, mem.blobId, createdAt);
  row.platform = platform;
  row.suiAddress = typeof payload.sui_address === "string" ? payload.sui_address : null;
  sources.set(id, row);
  byHandle.set(handle, row);
}

function addClaim(
  mem: GatheredMemory,
  payload: Record<string, unknown>,
  claims: Map<string, RebuiltClaim>,
  skipped: Array<{ blobId: string; reason: string }>,
): void {
  const id = typeof payload.claim_id === "string" ? payload.claim_id : "";
  const handle = typeof payload.source_handle === "string" ? payload.source_handle : "";
  const claimType = asClaimType(payload.claim_type);
  const deadline = typeof payload.deadline === "string" ? payload.deadline : "";
  const quote = typeof payload.quote === "string" ? payload.quote : "";
  const params = asRecord(payload.params);
  if (!UUID.test(id) || !handle || !claimType || !quote || !params || Number.isNaN(Date.parse(deadline))) {
    skipped.push({ blobId: mem.blobId, reason: "claim memory is missing a required field" });
    return;
  }
  if (claims.has(id)) {
    skipped.push({ blobId: mem.blobId, reason: `duplicate claim id ${id}` });
    return;
  }
  const confidence = typeof payload.confidence === "number" ? payload.confidence : 0;
  claims.set(id, {
    id,
    sourceId: "",
    sourceHandle: handle,
    quote,
    claimType,
    params,
    snapshot: payload.snapshot === null ? null : asRecord(payload.snapshot),
    deadline: new Date(deadline).toISOString(),
    confidence,
    status: "pending",
    synthetic: payload.synthetic === true,
    externalId: typeof payload.external_id === "string" ? payload.external_id : null,
    sourceUrl: typeof payload.source_url === "string" ? payload.source_url : null,
    deadlineBasis:
      typeof payload.deadline_basis === "string" && payload.deadline_basis.trim()
        ? payload.deadline_basis.trim().slice(0, 160)
        : null,
    walrusBlobId: mem.blobId,
    createdAt: mem.createdAt ?? new Date(0).toISOString(),
  });
}

function addResolution(
  mem: GatheredMemory,
  payload: Record<string, unknown>,
  resolutions: Map<string, RebuiltResolution>,
  skipped: Array<{ blobId: string; reason: string }>,
): void {
  const claimId = typeof payload.claim_id === "string" ? payload.claim_id : "";
  const outcome = asOutcome(payload.outcome);
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!UUID.test(claimId) || !outcome || !reason) {
    skipped.push({ blobId: mem.blobId, reason: "resolution memory is missing claim, outcome, or reason" });
    return;
  }
  const revision = resolutionRevision(payload);
  const resolvedAt = resolutionTime(payload, mem.createdAt);
  const incoming: RebuiltResolution = {
    claimId,
    outcome,
    reason,
    evidence: asRecord(payload.evidence) ?? {},
    walrusBlobId: mem.blobId,
    resolvedAt,
    revision,
  };
  const existing = resolutions.get(claimId);
  if (existing && !resolutionBeats(incoming, existing)) {
    skipped.push({ blobId: mem.blobId, reason: `older resolution for ${claimId}` });
    return;
  }
  if (existing) {
    skipped.push({ blobId: existing.walrusBlobId, reason: `superseded resolution for ${claimId}` });
  }
  resolutions.set(claimId, incoming);
}

/** Missing revision is the original resolution. Later revisions replace it. */
function resolutionRevision(payload: Record<string, unknown>): number {
  const revision = payload.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function resolutionTime(payload: Record<string, unknown>, createdAt?: string): string {
  const raw = payload.resolved_at;
  if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return createdAt ?? new Date(0).toISOString();
}

/**
 * The latest resolution is the one the score replay uses. Revision wins,
 * then time, then blob id so two memories cannot tie.
 */
function resolutionBeats(next: RebuiltResolution, prev: RebuiltResolution): boolean {
  if (next.revision !== prev.revision) return next.revision > prev.revision;
  if (next.resolvedAt !== prev.resolvedAt) return next.resolvedAt > prev.resolvedAt;
  return next.walrusBlobId > prev.walrusBlobId;
}

function addScore(
  mem: GatheredMemory,
  payload: Record<string, unknown>,
  versions: RebuiltScoreVersion[],
  seen: Set<string>,
  skipped: Array<{ blobId: string; reason: string }>,
): void {
  const sourceId = typeof payload.source_id === "string" ? payload.source_id : "";
  const version = typeof payload.version === "number" ? payload.version : NaN;
  const hits = typeof payload.hits === "number" ? payload.hits : NaN;
  const misses = typeof payload.misses === "number" ? payload.misses : NaN;
  const score = typeof payload.score === "number" ? payload.score : NaN;
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!UUID.test(sourceId) || !Number.isInteger(version) || !Number.isFinite(hits) || !Number.isFinite(misses) || !Number.isFinite(score) || !reason) {
    skipped.push({ blobId: mem.blobId, reason: "score memory is missing a required field" });
    return;
  }
  const key = `${sourceId}:${version}`;
  if (seen.has(key)) {
    skipped.push({ blobId: mem.blobId, reason: `duplicate score ${key}` });
    return;
  }
  seen.add(key);
  const trigger = payload.triggered_by_claim_id;
  const hitRate = typeof payload.hit_rate === "number" ? payload.hit_rate : hits + misses === 0 ? 0 : hits / (hits + misses);
  versions.push({
    sourceId,
    version,
    hits,
    misses,
    score,
    hitRate,
    triggeredByClaimId: typeof trigger === "string" && UUID.test(trigger) ? trigger : null,
    reason,
    walrusBlobId: mem.blobId,
    createdAt: mem.createdAt ?? new Date(0).toISOString(),
  });
}

function addTombstone(payload: Record<string, unknown>, tombstones: Tombstone[]): void {
  const refId = typeof payload.ref_id === "string" ? payload.ref_id : "";
  const refKind = payload.ref_kind === "source" || payload.ref_kind === "claim" ? payload.ref_kind : null;
  if (!refId || !refKind) return;
  tombstones.push({ refId, refKind });
}

function blankSource(id: string, handle: string, blobId: string, createdAt: string): RebuiltSource {
  return {
    id,
    handle,
    platform: "other",
    suiAddress: null,
    createdAt,
    walrusBlobId: blobId,
    hits: 0,
    misses: 0,
    score: 0,
    hitRate: 0,
    band: "unknown",
    muted: false,
  };
}

function asPlatform(v: unknown): Platform | null {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v) ? (v as Platform) : null;
}

function asClaimType(v: unknown): ClaimType | null {
  return typeof v === "string" && (CLAIM_TYPES as readonly string[]).includes(v) ? (v as ClaimType) : null;
}

function asOutcome(v: unknown): Outcome | null {
  return v === "true" || v === "false" || v === "void" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
