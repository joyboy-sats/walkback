/**
 * Read models for the Coolify API. Selects only. Walrus writes happen in the worker.
 *
 * Scores shown here are recomputed from stored resolutions. That does not call
 * Tatum and does not write a memory. `muted` follows forecast-primary.
 */
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { presentClaim, type ClaimDetail } from "./claim-view";
import { foldVerdicts } from "./category-score";
import { getDb, schema } from "./db";
import {
  buildLedger,
  compareTrust,
  MUTE_RULE,
  type LedgerClaimInput,
  type LedgerSource,
  type LedgerSourceInput,
  type LedgerView,
} from "./ledger";
import { LIST_ENUMERATION_NOTE } from "./projection-rebuild";
import { explainVoidReason } from "./verdict-reason";
import type { Outcome } from "./types";

export interface FeedResolution {
  outcome: Outcome;
  /** Sentence safe to show. Provider errors are rewritten once. */
  reason: string;
}

const FEED_LIMIT = 100;

/** Latest row wins. A re-resolve updates the row; this still prefers the newest if more than one exists. */
export function latestResolution<T extends { claimId: string; resolvedAt: Date }>(
  rows: readonly T[],
): Map<string, T> {
  const byClaim = new Map<string, T>();
  for (const row of rows) {
    const prev = byClaim.get(row.claimId);
    if (!prev || row.resolvedAt.getTime() >= prev.resolvedAt.getTime()) byClaim.set(row.claimId, row);
  }
  return byClaim;
}

export function feedResolution(row: { outcome: Outcome; reason: string }): FeedResolution {
  return { outcome: row.outcome, reason: explainVoidReason(row.reason) };
}

interface ClaimScoreRow {
  id: string;
  sourceId: string;
  claimType: string;
  status: "pending" | "resolved" | "void";
}

function sourcesWithCategories(
  sources: readonly LedgerSourceInput[],
  claims: readonly ClaimScoreRow[],
  resolutions: ReadonlyMap<string, { outcome: Outcome }>,
): LedgerSourceInput[] {
  const bySource = new Map<string, Array<{ claimType: string; outcome: Outcome }>>();
  for (const claim of claims) {
    const resolution = resolutions.get(claim.id);
    if (!resolution) continue;
    const list = bySource.get(claim.sourceId) ?? [];
    list.push({ claimType: claim.claimType, outcome: resolution.outcome });
    bySource.set(claim.sourceId, list);
  }
  return sources.map((source) => {
    const folded = foldVerdicts(bySource.get(source.id) ?? []);
    return {
      ...source,
      hits: folded.overall.hits,
      misses: folded.overall.misses,
      score: folded.overall.score,
      reportingHits: folded.reporting.hits,
      reportingMisses: folded.reporting.misses,
      forecastHits: folded.forecast.hits,
      forecastMisses: folded.forecast.misses,
    };
  });
}

function claimsWithOutcomes(
  claims: readonly ClaimScoreRow[],
  resolutions: ReadonlyMap<string, { outcome: Outcome }>,
): LedgerClaimInput[] {
  return claims.map((claim) => ({
    sourceId: claim.sourceId,
    claimType: claim.claimType,
    status: claim.status,
    outcome: resolutions.get(claim.id)?.outcome ?? null,
  }));
}

export interface FeedView {
  /** Capped list. Muted sources are included; the page filters them. */
  rows: FeedRow[];
  rowsIncludeMuted: true;
  limit: number;
  muteRule: typeof MUTE_RULE;
  /** Uncapped. `all` includes muted sources. `visible` does not. */
  totals: LedgerView["totals"];
}

export interface FeedRow {
  claim: {
    id: string;
    quote: string;
    claimType: string;
    status: string;
    deadline: string;
    synthetic: boolean;
    sourceUrl: string | null;
    walrusBlobId: string | null;
    resolution: FeedResolution | null;
    detail: ClaimDetail;
  };
  source: LedgerSource;
}

export async function readFeed(): Promise<FeedView> {
  const db = getDb();
  const [joined, sourceRows, memoryRows, verifyRows] = await Promise.all([
    db
      .select({ claim: schema.claims, source: schema.sources })
      .from(schema.claims)
      .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id)),
    db
      .select({
        id: schema.sources.id,
        handle: schema.sources.handle,
        score: schema.sources.score,
        hits: schema.sources.hits,
        misses: schema.sources.misses,
        storedMuted: schema.sources.muted,
      })
      .from(schema.sources),
    db.select({ value: count() }).from(schema.memoryLog),
    db
      .select({ result: schema.ingestJobs.result })
      .from(schema.ingestJobs)
      .where(and(eq(schema.ingestJobs.kind, "rebuild"), eq(schema.ingestJobs.status, "done")))
      .orderBy(desc(schema.ingestJobs.finishedAt), desc(schema.ingestJobs.createdAt))
      .limit(1),
  ]);

  const claimIds = joined.map(({ claim }) => claim.id);
  const resolutionRows =
    claimIds.length === 0
      ? []
      : await db
          .select({
            claimId: schema.resolutions.claimId,
            outcome: schema.resolutions.outcome,
            reason: schema.resolutions.reason,
            evidence: schema.resolutions.evidence,
            resolvedAt: schema.resolutions.resolvedAt,
            walrusBlobId: schema.resolutions.walrusBlobId,
          })
          .from(schema.resolutions)
          .where(inArray(schema.resolutions.claimId, claimIds));
  const resolutions = latestResolution(resolutionRows);
  const claimRows: ClaimScoreRow[] = joined.map(({ claim }) => ({
    id: claim.id,
    sourceId: claim.sourceId,
    claimType: claim.claimType,
    status: claim.status,
  }));
  const ledger = buildLedger({
    sources: sourcesWithCategories(sourceRows, claimRows, resolutions),
    claims: claimsWithOutcomes(claimRows, resolutions),
    memoryInventory: memoryRows[0]?.value ?? 0,
    latestVerifyResult: verifyRows[0]?.result ?? null,
  });
  const bySource = new Map(ledger.sources.map((source) => [source.id, source]));

  const rows = joined.map(({ claim, source }) => {
    const resolution = resolutions.get(claim.id);
    const shown = bySource.get(source.id);
    const detail = presentClaim({
      id: claim.id,
      quote: claim.quote,
      claimType: claim.claimType,
      status: claim.status,
      params: claim.params,
      deadline: claim.deadline.toISOString(),
      deadlineBasis: claim.deadlineBasis,
      claimBlobId: claim.walrusBlobId,
      resolution: resolution
        ? {
            outcome: resolution.outcome,
            reason: explainVoidReason(resolution.reason),
            evidence: resolution.evidence,
            blobId: resolution.walrusBlobId,
          }
        : null,
    });
    return {
      claim: {
        id: claim.id,
        quote: claim.quote,
        claimType: claim.claimType,
        status: claim.status,
        deadline: claim.deadline.toISOString(),
        synthetic: claim.synthetic,
        sourceUrl: claim.sourceUrl,
        walrusBlobId: claim.walrusBlobId,
        resolution: resolution ? feedResolution(resolution) : null,
        detail,
      },
      source: shown ?? {
        id: source.id,
        handle: source.handle,
        score: source.score,
        hits: source.hits,
        misses: source.misses,
        band: "unknown" as const,
        muted: false,
        muteBasis: null,
        overall: null,
        reporting: null,
        forecast: null,
        claimTypes: [],
      },
    };
  });

  rows.sort((a, b) => {
    const trust = compareTrust(a.source, b.source);
    if (trust !== 0) return trust;
    const deadline = b.claim.deadline.localeCompare(a.claim.deadline);
    if (deadline !== 0) return deadline;
    return a.claim.id.localeCompare(b.claim.id);
  });

  return {
    rows: rows.slice(0, FEED_LIMIT),
    rowsIncludeMuted: true,
    limit: FEED_LIMIT,
    muteRule: MUTE_RULE,
    totals: ledger.totals,
  };
}

/** Every source, plus ledger totals. Not capped the way {@link readFeed} is. */
export async function readLedger(): Promise<LedgerView> {
  const db = getDb();
  const [sourceRows, claimRows, resolutionRows, memoryRows, verifyRows] = await Promise.all([
    db
      .select({
        id: schema.sources.id,
        handle: schema.sources.handle,
        score: schema.sources.score,
        hits: schema.sources.hits,
        misses: schema.sources.misses,
        storedMuted: schema.sources.muted,
      })
      .from(schema.sources),
    db
      .select({
        id: schema.claims.id,
        sourceId: schema.claims.sourceId,
        claimType: schema.claims.claimType,
        status: schema.claims.status,
      })
      .from(schema.claims),
    db
      .select({
        claimId: schema.resolutions.claimId,
        outcome: schema.resolutions.outcome,
        resolvedAt: schema.resolutions.resolvedAt,
      })
      .from(schema.resolutions),
    db.select({ value: count() }).from(schema.memoryLog),
    db
      .select({ result: schema.ingestJobs.result })
      .from(schema.ingestJobs)
      .where(and(eq(schema.ingestJobs.kind, "rebuild"), eq(schema.ingestJobs.status, "done")))
      .orderBy(desc(schema.ingestJobs.finishedAt), desc(schema.ingestJobs.createdAt))
      .limit(1),
  ]);
  const resolutions = latestResolution(resolutionRows);

  return buildLedger({
    sources: sourcesWithCategories(sourceRows, claimRows, resolutions),
    claims: claimsWithOutcomes(claimRows, resolutions),
    memoryInventory: memoryRows[0]?.value ?? 0,
    latestVerifyResult: verifyRows[0]?.result ?? null,
  });
}

export async function readClaim(id: string): Promise<{
  source: { id: string; handle: string };
  detail: ClaimDetail;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({ claim: schema.claims, source: schema.sources })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .where(eq(schema.claims.id, id))
    .limit(1);
  if (!row) return null;

  const resolutionRows = await db
    .select({
      claimId: schema.resolutions.claimId,
      outcome: schema.resolutions.outcome,
      reason: schema.resolutions.reason,
      evidence: schema.resolutions.evidence,
      resolvedAt: schema.resolutions.resolvedAt,
      walrusBlobId: schema.resolutions.walrusBlobId,
    })
    .from(schema.resolutions)
    .where(eq(schema.resolutions.claimId, id));
  const resolution = latestResolution(resolutionRows).get(id) ?? null;

  return {
    source: { id: row.source.id, handle: row.source.handle },
    detail: presentClaim({
      id: row.claim.id,
      quote: row.claim.quote,
      claimType: row.claim.claimType,
      status: row.claim.status,
      params: row.claim.params,
      deadline: row.claim.deadline.toISOString(),
      deadlineBasis: row.claim.deadlineBasis,
      claimBlobId: row.claim.walrusBlobId,
      resolution: resolution
        ? {
            outcome: resolution.outcome,
            reason: explainVoidReason(resolution.reason),
            evidence: resolution.evidence,
            blobId: resolution.walrusBlobId,
          }
        : null,
    }),
  };
}

export async function readSource(id: string) {
  const db = getDb();
  const [source] = await db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1);
  if (!source) return null;

  const versions = await db
    .select()
    .from(schema.scoreVersions)
    .where(eq(schema.scoreVersions.sourceId, id))
    .orderBy(asc(schema.scoreVersions.version));

  const claims = await db
    .select({
      claim: schema.claims,
      resolution: schema.resolutions,
    })
    .from(schema.claims)
    .leftJoin(schema.resolutions, eq(schema.resolutions.claimId, schema.claims.id))
    .where(eq(schema.claims.sourceId, id))
    .orderBy(desc(schema.claims.deadline))
    .limit(50);

  const verdicts = await db
    .select({
      claimId: schema.claims.id,
      claimType: schema.claims.claimType,
      outcome: schema.resolutions.outcome,
      resolvedAt: schema.resolutions.resolvedAt,
    })
    .from(schema.claims)
    .innerJoin(schema.resolutions, eq(schema.resolutions.claimId, schema.claims.id))
    .where(eq(schema.claims.sourceId, id));
  const latest = latestResolution(
    verdicts.filter((row): row is typeof row & { outcome: Outcome; resolvedAt: Date } => row.outcome !== null && row.resolvedAt !== null),
  );
  const folded = foldVerdicts(
    [...latest.values()].map((row) => ({ claimType: row.claimType, outcome: row.outcome })),
  );

  return {
    source: {
      id: source.id,
      handle: source.handle,
      score: folded.basis.score,
      hits: folded.basis.hits,
      misses: folded.basis.misses,
      band: folded.basis.band,
      muted: folded.muted,
      muteBasis: folded.muteBasis,
      overall: folded.overall,
      reporting: folded.reporting,
      forecast: folded.forecast,
    },
    versions: versions.map((v) => ({ version: v.version, score: v.score })),
    claims: claims.map(({ claim, resolution }) => ({
      claim: {
        id: claim.id,
        quote: claim.quote,
        claimType: claim.claimType,
        status: claim.status,
        deadline: claim.deadline.toISOString(),
        synthetic: claim.synthetic,
        sourceUrl: claim.sourceUrl,
        walrusBlobId: claim.walrusBlobId,
      },
      resolution: resolution
        ? {
            outcome: resolution.outcome,
            reason: explainVoidReason(resolution.reason),
            evidence: resolution.evidence,
            walrusBlobId: resolution.walrusBlobId,
          }
        : null,
    })),
  };
}

export async function claimsForSourceUrls(urls: readonly string[]) {
  if (urls.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: schema.claims.id,
      sourceUrl: schema.claims.sourceUrl,
      status: schema.claims.status,
    })
    .from(schema.claims)
    .where(inArray(schema.claims.sourceUrl, [...urls]));
}

export async function readMemory() {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.memoryLog)
    .orderBy(desc(schema.memoryLog.writtenAt))
    .limit(200);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      namespace: r.namespace,
      blobId: r.blobId,
      textPreview: r.textPreview,
    })),
    limitation: LIST_ENUMERATION_NOTE,
  };
}
