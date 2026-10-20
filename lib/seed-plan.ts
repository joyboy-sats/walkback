/**
 * Pure planning for `scripts/seed.ts`.
 *
 * No database, no relayer, no model. The script reads a file of posts the
 * owner collected, and this module decides which of those posts are new,
 * which claims they carry, and how the writes are grouped. Keeping it pure
 * means the idempotency rule can be tested without credentials.
 *
 * Real posts are the dataset. A post with `synthetic: true` is a demo
 * fallback and is counted separately. The file committed in the repo is
 * placeholders only; the script warns when those are not a minority.
 */
import { z } from "zod";
import { claimExternalId, claimExternalPrefix, stableUuid } from "./ids";
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
  claims: z.array(claimSchema).max(3).optional(),
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

/**
 * Posts already present in the projection are not ingested again.
 * `existingExternalIds` are the `external_id` values already stored.
 */
export function postsToApply(
  posts: SeedPost[],
  existingExternalIds: readonly string[],
): { apply: SeedPost[]; skip: SeedPost[] } {
  const existing = new Set(existingExternalIds);
  const apply: SeedPost[] = [];
  const skip: SeedPost[] = [];
  for (const post of posts) {
    const prefix = claimExternalPrefix(post.id);
    const seen = [...existing].some((id) => id.startsWith(prefix));
    if (seen) skip.push(post);
    else apply.push(post);
  }
  return { apply, skip };
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
    return {
      quote: c.quote,
      claimType: c.claim_type,
      params,
      deadline: new Date(c.deadline).toISOString(),
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
      const symbol = str("symbol");
      const amount = str("amount");
      if (!symbol || !amount || Number.isNaN(Number(amount)) || !direction) return null;
      return {
        symbol: symbol.toUpperCase(),
        quote: (str("quote") || "USD").toUpperCase(),
        direction,
        amount,
      };
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
