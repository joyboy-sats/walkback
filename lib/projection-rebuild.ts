/**
 * Rebuild the Postgres projection from Walrus Memory.
 *
 * Walrus is the system of record. This module reads memories back and turns
 * the fenced JSON that `lib/memory-text.ts` writes into sources, claims,
 * resolutions and score versions. Trust is recomputed from verdicts with
 * `computeScore`; a stored score that disagrees with the verdicts loses.
 *
 * `recall` is similarity search, not `SELECT *`. There is no cursor, no
 * filter, and no "give me every row" call. `restore()` rebuilds the relayer's
 * vector index and returns counts, not plaintext, and the SDK documents that
 * even `truncated: false` is not proof every on-chain blob was seen. The
 * practical consequence:
 *
 *   1. Each namespace is queried several times, with a large limit and both
 *      sort modes, and hits are deduped on `blob_id`. Order is never trusted.
 *   2. The unique count per namespace is compared with `listNamespaces`.
 *   3. If recall returned fewer memories than the relayer has indexed, or
 *      returned nothing, or the counts could not be read, the projection is
 *      left untouched. Truncating on a partial read would destroy the only
 *      structured copy of the ledger.
 *
 * A complete enumeration needs an API this SDK does not have: list-by-
 * namespace returning plaintext, or a cursor on `restore` that yields text.
 * Until that exists, a rebuild at demo scale (tens of memories, limit well
 * above the namespace size) can succeed, and a rebuild that cannot prove it
 * saw everything refuses.
 */
import "server-only";

import { NS, type ClaimType, type Namespace, type Outcome } from "./types";
import { computeScore, type TrustBand } from "./score";
import { stableUuid } from "./ids";

/** Large on purpose. Demo namespaces are tens of memories, not thousands. */
export const RECALL_LIMIT = 200;

export const RECALL_ENUMERATION_LIMIT =
  "recall is similarity search, not a listing. This rebuild queries every " +
  "namespace several times, dedupes on blob_id, and refuses to truncate the " +
  "projection when listNamespaces reports more memories than came back. " +
  "restore() returns counts, not text, and has no cursor, so it cannot " +
  "enumerate either. A guaranteed rebuild needs a list-by-namespace API.";

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
  walrusBlobId: string;
  createdAt: string;
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
    if (!claims.has(claimId)) resolutions.delete(claimId);
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

    const latest = liveScores
      .filter((v) => v.sourceId === source.id)
      .sort((a, b) => b.version - a.version)[0];
    if (
      latest &&
      (latest.hits !== score.hits ||
        latest.misses !== score.misses ||
        Math.abs(latest.score - score.score) > 1e-9)
    ) {
      notes.push(
        `${source.handle}: score memory v${latest.version} disagrees with the verdicts; ` +
          `the projection uses the recomputed score ${score.score.toFixed(4)}`,
      );
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => a.handle.localeCompare(b.handle)),
    claims: [...claims.values()].sort((a, b) => a.id.localeCompare(b.id)),
    resolutions: [...resolutions.values()].sort((a, b) => a.claimId.localeCompare(b.claimId)),
    scoreVersions: liveScores.sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.version - b.version,
    ),
    memoryLog: memoryLog.sort((a, b) => a.blobId.localeCompare(b.blobId)),
    skipped,
    duplicatesDropped,
    notes,
  };
}

export interface TruncationDecision {
  truncate: boolean;
  warning: string | null;
  gaps: Array<{ namespace: string; recalled: number; reported: number }>;
}

/**
 * Whether it is safe to drop the projection.
 *
 * An empty recall must not wipe Postgres: there is nothing to rebuild from.
 * A missing count must not wipe it either, because we cannot tell a partial
 * recall from a complete one. A shortfall against `listNamespaces` is the
 * same refusal.
 */
export function decideTruncation(input: {
  unique: number;
  recalledByNamespace: Record<string, number>;
  reportedByNamespace: Record<string, number> | null;
}): TruncationDecision {
  if (input.unique === 0) {
    return {
      truncate: false,
      gaps: [],
      warning: "recall returned no memories, so the projection was not modified.",
    };
  }
  if (!input.reportedByNamespace) {
    return {
      truncate: false,
      gaps: [],
      warning:
        "namespace counts could not be read, so completeness is unknown and the projection was not modified.",
    };
  }
  const gaps: TruncationDecision["gaps"] = [];
  for (const namespace of Object.values(NS)) {
    const reported = input.reportedByNamespace[namespace] ?? 0;
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
      warning:
        `recall did not return every indexed memory (${detail}). ` +
        `The projection was not modified.`,
    };
  }
  return { truncate: true, gaps: [], warning: null };
}

export interface RebuildReport {
  truncated: boolean;
  warning: string | null;
  limitation: string;
  notes: string[];
  duplicatesDropped: number;
  skipped: Array<{ blobId: string; reason: string }>;
  counts: {
    sources: number;
    claims: number;
    resolutions: number;
    scoreVersions: number;
    memoryLog: number;
  };
  coverage: {
    rawHits: number;
    unique: number;
    byNamespace: Record<string, number>;
    reported: Record<string, number> | null;
    gaps: Array<{ namespace: string; recalled: number; reported: number }>;
  };
}

/**
 * Recall, parse, and — only when the recall looks complete — replace the
 * projection. Returns the row counts either way, with `truncated: false`
 * when the tables were left alone.
 */
export async function rebuildProjection(): Promise<RebuildReport> {
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
  const projection = projectMemories(gathered.memories);
  const decision = decideTruncation({
    unique: gathered.memories.length,
    recalledByNamespace: byNamespace,
    reportedByNamespace: reported,
  });

  const counts = {
    sources: projection.sources.length,
    claims: projection.claims.length,
    resolutions: projection.resolutions.length,
    scoreVersions: projection.scoreVersions.length,
    memoryLog: projection.memoryLog.length,
  };

  if (decision.truncate) await applyProjection(projection);

  return {
    truncated: decision.truncate,
    warning: decision.warning,
    limitation: RECALL_ENUMERATION_LIMIT,
    notes: projection.notes,
    duplicatesDropped: gathered.duplicatesDropped + projection.duplicatesDropped,
    skipped: projection.skipped,
    counts,
    coverage: {
      rawHits: gathered.rawHits,
      unique: gathered.memories.length,
      byNamespace,
      reported,
      gaps: decision.gaps,
    },
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
  if (resolutions.has(claimId)) {
    skipped.push({ blobId: mem.blobId, reason: `duplicate resolution for ${claimId}` });
    return;
  }
  resolutions.set(claimId, {
    claimId,
    outcome,
    reason,
    evidence: asRecord(payload.evidence) ?? {},
    walrusBlobId: mem.blobId,
    resolvedAt: mem.createdAt ?? new Date(0).toISOString(),
  });
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
