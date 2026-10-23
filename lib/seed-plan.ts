/**
 * Pure planning for `scripts/seed.ts`.
 *
 * No database, no relayer, no model. The script reads a file of posts the
 * owner collected, and this module decides which of those posts are new,
 * which claims they carry, and how the writes are grouped. Keeping it pure
 * means the idempotency rule can be tested without credentials.
 *
 * Real posts are the dataset. A post with `synthetic: true` is a demo
 * fallback and is counted separately. The file committed in the repo is the
 * real set; the script warns when synthetic posts are not a minority.
 */
import { z } from "zod";
import { claimExternalId, claimExternalPrefix, stableUuid } from "./ids";
import {
  BOUNDARY_REFINEMENT_CREDIT_CAP,
  OHLCV_BATCH_CREDITS,
  OHLCV_SINGLE_CREDITS,
  denseBatchCalls,
  priceParamsFromRaw,
  touchIntervalFor,
} from "./price-candle";
import type { ClaimParams, ClaimType, ExtractedClaim } from "./types";

/** Matches `writeMemoriesBulk`'s server cap. A seed batch must not exceed it. */
export const SEED_BULK_MAX = 20;

const claimTypes = [
  "balance_threshold",
  "balance_change_since_ingest",
  "tx_replay",
  "price_threshold",
  "manual",
] as const;

const snapshotSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  asset: z.string().min(1),
  balance: z.string().regex(/^\d+$/, "balance is base units, an integer string"),
  checkpoint: z.string().optional(),
  asOf: z.string().datetime(),
});

const claimSchema = z.object({
  quote: z.string().min(1).max(200),
  claim_type: z.enum(claimTypes),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  deadline: z.string().datetime(),
  /**
   * Why `deadline` is that timestamp. Required on price claims. The resolver
   * does not derive a deadline from this string.
   */
  deadline_basis: z.string().min(1).max(160).optional(),
  confidence: z.number().min(0).max(1),
});

export const seedPostSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id is a lowercase slug (letters, digits, hyphens)"),
  /**
   * Demo fallback. Real posts omit this or set it false. The seed summary,
   * the feed, and the memory text all surface a true value.
   */
  synthetic: z.boolean().optional(),
  handle: z.string().min(1).max(120),
  platform: z.enum(["x", "substack", "rss", "onchain", "other"]),
  published_at: z.string().datetime(),
  sui_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{1,64}$/)
    .optional(),
  text: z.string().min(1).max(20_000),
  /** Permalink of the original post. The feed links here. */
  source_url: z.string().url().optional(),
  /**
   * Receipt frozen when the post was collected. Present so a historical
   * `balance_change_since_ingest` does not need a live balance read — Sui
   * cannot answer "what was the balance then". `null` means there is no
   * receipt and the seed must not call Tatum for one. Omit the field to
   * take a live snapshot at seed time.
   */
  snapshot: snapshotSchema.nullable().optional(),
  /**
   * When set, these claims are stored as written and the model is not called.
   * Use this for `tx_replay`, where the window has to be exact. Omit it and
   * the seed run extracts claims from `text`.
   */
  claims: z.array(claimSchema).max(4).optional(),
});

export const seedFileSchema = z.object({
  note: z.string().optional(),
  posts: z.array(seedPostSchema).min(1),
});

export type SeedPost = z.infer<typeof seedPostSchema>;
export type SeedFile = z.infer<typeof seedFileSchema>;
export type SeedSnapshot = z.infer<typeof snapshotSchema>;

export function parseClaimsFile(raw: unknown): SeedFile {
  const parsed = seedFileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`data/claims.json is invalid:\n${lines.join("\n")}`);
  }
  const ids = parsed.data.posts.map((p) => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`data/claims.json has a duplicate post id: ${dup}`);
  return parsed.data;
}

export function isSynthetic(post: SeedPost): boolean {
  return post.synthetic === true;
}

export interface SeedClaimProgress {
  index: number;
  walrusBlobId: string | null;
}

export interface SeedSourceProgress {
  exists: boolean;
  walrusBlobId: string | null;
  /** A source memory is already in memory_log for this source. */
  memoryLogged: boolean;
}

export interface SeedPostDecision {
  action: "skip" | "insert" | "resume";
  /**
   * Append a source memory on this run. False when a blob id or a memory_log
   * row already proves one was persisted. A source row with neither is not
   * proof: the source memory is written only after the claim rows exist, so
   * a crash between those two inserts has not written one yet.
   */
  writeSourceMemory: boolean;
  /**
   * Claim indexes that still need a row or a blob id. Null when the post has
   * no explicit claims and extraction still has to run.
   */
  pendingClaimIndexes: number[] | null;
  /** Memories are already persisted. The caller sets the applied marker and writes nothing. */
  markApplied: boolean;
  reason: string;
}

export function claimIndexFromExternalId(externalId: string, postId: string): number | null {
  const prefix = claimExternalPrefix(postId);
  if (!externalId.startsWith(prefix)) return null;
  const rest = externalId.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

export function sourceMemoryAlreadyPersisted(source: SeedSourceProgress | null): boolean {
  if (!source?.exists) return false;
  return Boolean(source.walrusBlobId) || source.memoryLogged;
}

/**
 * What a seed rerun should do with one post.
 *
 * The applied marker is the only full skip, and it is written after every
 * memory for the post has been persisted. A source row, or a claim row whose
 * blob id is still null, is a partial run: insert the missing claims and
 * write only the memories that are not already stored.
 */
export function planSeedPost(input: {
  expectedClaimCount: number | null;
  applied: boolean;
  claims: readonly SeedClaimProgress[];
  source: SeedSourceProgress | null;
}): SeedPostDecision {
  const writeSourceMemory = !sourceMemoryAlreadyPersisted(input.source);

  if (input.applied) {
    return {
      action: "skip",
      writeSourceMemory: false,
      pendingClaimIndexes: [],
      markApplied: false,
      reason: "post marker is set; memories were persisted on an earlier run",
    };
  }

  if (input.expectedClaimCount === null) {
    if (input.claims.length === 0) {
      return {
        action: "insert",
        writeSourceMemory,
        pendingClaimIndexes: null,
        markApplied: false,
        reason: writeSourceMemory
          ? "new post"
          : "source memory already persisted; extract and insert claims only",
      };
    }
    const missing = input.claims.filter((c) => !c.walrusBlobId).map((c) => c.index);
    if (missing.length === 0 && !writeSourceMemory) {
      return {
        action: "skip",
        writeSourceMemory: false,
        pendingClaimIndexes: [],
        markApplied: true,
        reason: "claims and source memory are persisted; marker was not set",
      };
    }
    return {
      action: "resume",
      writeSourceMemory,
      pendingClaimIndexes: missing,
      markApplied: false,
      reason: "some extracted memories are not persisted",
    };
  }

  const missing: number[] = [];
  const byIndex = new Map(input.claims.map((c) => [c.index, c]));
  for (let i = 0; i < input.expectedClaimCount; i++) {
    const row = byIndex.get(i);
    if (!row || !row.walrusBlobId) missing.push(i);
  }

  const nothingLeft =
    missing.length === 0 && !writeSourceMemory && (input.claims.length > 0 || input.expectedClaimCount === 0);
  if (nothingLeft) {
    return {
      action: "skip",
      writeSourceMemory: false,
      pendingClaimIndexes: [],
      markApplied: true,
      reason: "every memory is persisted; marker was not set",
    };
  }

  if (input.claims.length === 0) {
    return {
      action: "insert",
      writeSourceMemory,
      pendingClaimIndexes: missing,
      markApplied: false,
      reason: input.source?.exists
        ? "source row exists from a partial run; claims were not inserted"
        : "new post",
    };
  }

  return {
    action: "resume",
    writeSourceMemory,
    pendingClaimIndexes: missing,
    markApplied: false,
    reason: "partial seed; write only memories that are not persisted",
  };
}

/** Split a write list into relayer-sized batches. Throws above the cap. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > SEED_BULK_MAX) {
    throw new Error(`bulk chunk size must be an integer from 1 to ${SEED_BULK_MAX}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Turn an explicit `claims` array into the shape ingest stores.
 * Returns null when the post has no array, which means "call the extractor".
 */
export function materializeClaims(post: SeedPost): ExtractedClaim[] | null {
  if (!post.claims) return null;
  return post.claims.map((c, index) => {
    if (c.confidence < 0.6) {
      throw new Error(
        `post ${post.id} claim ${index} has confidence ${c.confidence}; the floor is 0.6`,
      );
    }
    const params = normalize(c.claim_type, c.params, post);
    if (!params) {
      throw new Error(
        `post ${post.id} claim ${index} (${c.claim_type}) is missing a field it needs to be checkable`,
      );
    }
    if (c.claim_type === "price_threshold" && !c.deadline_basis?.trim()) {
      throw new Error(
        `post ${post.id} claim ${index} is a price claim and needs deadline_basis`,
      );
    }
    return {
      quote: c.quote,
      claimType: c.claim_type,
      params,
      deadline: new Date(c.deadline).toISOString(),
      ...(c.deadline_basis?.trim() ? { deadlineBasis: c.deadline_basis.trim() } : {}),
      confidence: c.confidence,
    };
  });
}

export function plannedClaimIdentity(
  postId: string,
  index: number,
): { externalId: string; claimId: string; idempotencyKey: string } {
  const externalId = claimExternalId(postId, index);
  const claimId = stableUuid(externalId);
  return { externalId, claimId, idempotencyKey: `claim:${claimId}` };
}

export interface SeedSummaryInput {
  postsRead: number;
  postsSeeded: number;
  postsSkipped: number;
  realPosts: number;
  syntheticPosts: number;
  realClaims: number;
  syntheticClaims: number;
  memoriesByNamespace: Record<string, number>;
  blobIds: string[];
  scores: Array<{ handle: string; score: number; hits: number; misses: number }>;
  resolveErrors: Array<{ claimId: string; error: string }>;
  /** Posts or phases that threw. The applied marker was not set for these posts. */
  failures?: Array<{ step: string; error: string }>;
  /** Posts left for a rerun because an earlier step timed out. */
  notAttempted?: string[];
  /** What checking this file's past-deadline price claims costs, if they are still pending. */
  ohlcvEstimate?: OhlcvCreditEstimate;
  /** Live OHLCV calls made during this process. Replay mode stays at zero. */
  ohlcvObserved?: { singles: number; batches: number; credits: number };
}

export interface OhlcvCreditEstimate {
  claims: number;
  batchCalls: number;
  singleCalls: number;
  credits: number;
  /** Extra batch credits if every touch claim has to refine both boundary hours. */
  refinementCapCredits: number;
}

/**
 * Credits to check every past-deadline price claim in the file.
 *
 * A touch is hourly batch calls (daily when the window exceeds the hourly
 * budget), including the one-interval lead. `at_deadline` is one single
 * candle. Boundary minutes are not included; `refinementCapCredits` is the
 * ceiling if every touch claim has to settle both edges.
 */
export function estimateSeedOhlcv(posts: readonly SeedPost[], now: Date): OhlcvCreditEstimate {
  let claims = 0;
  let batchCalls = 0;
  let singleCalls = 0;
  let touchClaims = 0;
  for (const post of posts) {
    for (const claim of post.claims ?? []) {
      if (claim.claim_type !== "price_threshold") continue;
      if (Date.parse(claim.deadline) > now.getTime()) continue;
      claims += 1;
      const evaluation = claim.params.evaluation === undefined ? "at_deadline" : String(claim.params.evaluation);
      if (evaluation === "touch") {
        const since = String(claim.params.since ?? post.published_at);
        const fromMs = Date.parse(since);
        const toMs = Date.parse(claim.deadline);
        const interval = touchIntervalFor(fromMs, toMs);
        batchCalls += denseBatchCalls(fromMs, toMs, interval);
        touchClaims += 1;
      } else {
        singleCalls += 1;
      }
    }
  }
  return {
    claims,
    batchCalls,
    singleCalls,
    credits: batchCalls * OHLCV_BATCH_CREDITS + singleCalls * OHLCV_SINGLE_CREDITS,
    refinementCapCredits: touchClaims * BOUNDARY_REFINEMENT_CREDIT_CAP,
  };
}

/** Human-readable summary. The script prints this and nothing else at the end. */
export function formatSeedSummary(s: SeedSummaryInput): string {
  const lines: string[] = [];
  lines.push("seed summary");
  lines.push(
    `posts      ${s.postsRead} read, ${s.postsSeeded} ingested, ${s.postsSkipped} already present`,
  );
  lines.push(`real       ${s.realPosts} posts, ${s.realClaims} claims`);
  lines.push(`synthetic  ${s.syntheticPosts} posts, ${s.syntheticClaims} claims`);
  if (s.syntheticPosts >= s.realPosts) {
    lines.push(
      "warning    synthetic posts are not a minority. Add real posts to data/claims.json before the demo.",
    );
  }
  lines.push("memories");
  const namespaces = Object.keys(s.memoriesByNamespace).sort();
  if (namespaces.length === 0) lines.push("  (none)");
  for (const ns of namespaces) {
    lines.push(`  ${ns}  ${s.memoriesByNamespace[ns]}`);
  }
  lines.push(`blob ids   ${s.blobIds.length}`);
  for (const id of s.blobIds) lines.push(`  ${id}`);
  lines.push("scores");
  if (s.scores.length === 0) lines.push("  (no sources)");
  for (const src of s.scores) {
    lines.push(
      `  ${src.handle}  ${src.score.toFixed(2)}  (${src.hits} hits / ${src.misses} misses)`,
    );
  }
  if (s.resolveErrors.length) {
    lines.push("resolve errors");
    for (const e of s.resolveErrors) lines.push(`  ${e.claimId}  ${e.error}`);
  }
  if (s.failures?.length) {
    lines.push("failed");
    for (const failure of s.failures) lines.push(`  ${failure.step}  ${failure.error}`);
  }
  if (s.notAttempted?.length) {
    lines.push("not attempted");
    for (const id of s.notAttempted) lines.push(`  ${id}`);
  }
  if (s.ohlcvEstimate) {
    const estimate = s.ohlcvEstimate;
    lines.push(
      `tatum      estimate ${estimate.claims} past-deadline price claim(s): ` +
        `${estimate.batchCalls} batch (${OHLCV_BATCH_CREDITS} credits) + ` +
        `${estimate.singleCalls} single (${OHLCV_SINGLE_CREDITS} credits) = ${estimate.credits} credits ` +
        `if each is still unresolved. Boundary refinement is extra and only when a partial candle could decide the touch, ` +
        `at most ${estimate.refinementCapCredits} credits. Budget remaining about 99000.`,
    );
  }
  if (s.ohlcvObserved) {
    const observed = s.ohlcvObserved;
    lines.push(
      `tatum      observed this run: ${observed.singles} single, ${observed.batches} batch, ${observed.credits} credits`,
    );
  }
  const incomplete = Boolean(s.failures?.length || s.notAttempted?.length || s.resolveErrors.length);
  lines.push(`status     ${incomplete ? "incomplete" : "ok"}`);
  return lines.join("\n");
}

function normalize(
  type: ClaimType,
  raw: Record<string, string | number>,
  post: SeedPost,
): ClaimParams | null {
  const str = (k: string) => (raw[k] === undefined ? undefined : String(raw[k]).trim());
  const addr = str("address") || post.sui_address;
  const direction = asDirection(str("direction"));

  switch (type) {
    case "balance_threshold":
    case "balance_change_since_ingest": {
      const amount = str("amount");
      if (!isAddress(addr) || !amount || !/^\d+$/.test(amount) || !direction) return null;
      return { address: addr, asset: str("asset") || "0x2::sui::SUI", direction, amount };
    }
    case "tx_replay": {
      const amount = str("amount");
      const since = str("since");
      const until = str("until");
      if (
        !isAddress(addr) ||
        !amount ||
        !/^\d+$/.test(amount) ||
        !direction ||
        !isIso(since) ||
        !isIso(until)
      ) {
        return null;
      }
      return {
        address: addr,
        asset: str("asset") || "0x2::sui::SUI",
        since,
        until,
        direction,
        amount,
      };
    }
    case "price_threshold": {
      return priceParamsFromRaw({
        symbol: str("symbol"),
        quote: str("quote"),
        ...(direction ? { direction } : {}),
        amount: str("amount"),
        evaluation: str("evaluation"),
        since: str("since"),
        publishedAt: post.published_at,
      });
    }
    case "manual":
      return { note: str("note") || "no detail provided" };
    default:
      return null;
  }
}

function isAddress(a: string | undefined): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(a);
}

function isIso(s: string | undefined): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function asDirection(s: string | undefined): "gte" | "lte" | undefined {
  if (s === "gte" || s === "lte") return s;
  return undefined;
}
