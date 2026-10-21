/**
 * Postgres schema — the queryable projection.
 *
 * This is a *cache*, not the source of truth. Walrus Memory holds every claim,
 * verdict and score version as durable text; this schema exists because
 * similarity search cannot answer "which claims are still pending" or "sort
 * sources by score". If the two ever disagree, Walrus wins and `restore`
 * rebuilds this.
 *
 * Every table that mirrors a memory carries `walrusBlobId` so the two layers
 * can be cross-checked, and the UI can link straight to the blob.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  real,
  pgEnum,
} from "drizzle-orm/pg-core";

export const platformEnum = pgEnum("platform", [
  "x",
  "substack",
  "rss",
  "onchain",
  "other",
]);

export const claimTypeEnum = pgEnum("claim_type", [
  "balance_threshold",
  "balance_change_since_ingest",
  "tx_replay",
  "price_threshold",
  "manual",
]);

export const claimStatusEnum = pgEnum("claim_status", [
  "pending",
  "resolved",
  "void",
]);

export const outcomeEnum = pgEnum("outcome", ["true", "false", "void"]);

export const memoryKindEnum = pgEnum("memory_kind", [
  "source",
  "claim",
  "resolution",
  "score",
  "digest",
  "tombstone",
]);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    platform: platformEnum("platform").notNull().default("other"),
    suiAddress: text("sui_address"),
    rssUrl: text("rss_url"),
    /** Denormalised current score; recomputed from verdicts, never edited by hand. */
    hits: integer("hits").notNull().default(0),
    misses: integer("misses").notNull().default(0),
    score: real("score").notNull().default(0),
    /** Soft delete. Real deletion does not exist in Walrus Memory. */
    muted: boolean("muted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    walrusBlobId: text("walrus_blob_id"),
  },
  (t) => [index("sources_score_idx").on(t.score), index("sources_handle_idx").on(t.handle)],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Exact span of source text asserting the claim. Never paraphrased. */
    quote: text("quote").notNull(),
    claimType: claimTypeEnum("claim_type").notNull(),
    /** Type-specific params; validated by lib/adjudicate before storage. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    /**
     * Chain state frozen at ingest. Null means the claim arrived without a
     * receipt, which makes `balance_change_since_ingest` unadjudicable — the
     * claim resolves to `void` with that as the stated reason.
     */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    status: claimStatusEnum("status").notNull().default("pending"),
    /** Extraction confidence, kept for auditing the extractor itself. */
    confidence: real("confidence").notNull().default(0),
    /**
     * Demo fallback. Real posts leave this false. The feed and the memory
     * text both surface it so a synthetic row cannot be mistaken for evidence.
     */
    synthetic: boolean("synthetic").notNull().default(false),
    /**
     * Stable id from `data/claims.json` (`post:{id}:{index}`). Null for claims
     * pasted through the UI. Re-running the seed looks this up and skips.
     */
    externalId: text("external_id"),
    /**
     * Link to the original post. Null for claims pasted through the UI.
     * The feed and the source page render it when it is an https URL.
     */
    sourceUrl: text("source_url"),
    /**
     * Why `deadline` is that timestamp. Null on rows written before the field
     * existed. The resolver does not read it to choose a time.
     */
    deadlineBasis: text("deadline_basis"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    walrusBlobId: text("walrus_blob_id"),
  },
  (t) => [
    index("claims_status_deadline_idx").on(t.status, t.deadline),
    index("claims_source_idx").on(t.sourceId),
    uniqueIndex("claims_external_id_uidx").on(t.externalId),
  ],
);

export const resolutions = pgTable(
  "resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    outcome: outcomeEnum("outcome").notNull(),
    /** Raw normalized provider payload. The evidence panel and blog both read this. */
    evidence: jsonb("evidence").notNull(),
    /** One plain-English sentence, stored verbatim in the memory text. */
    reason: text("reason").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    walrusBlobId: text("walrus_blob_id"),
  },
  (t) => [index("resolutions_claim_idx").on(t.claimId)],
);

/**
 * Append-only score history. A row here is a *score version*, not an edit:
 * the source's current score is the most recent row, and the chain of rows is
 * the audit trail behind "why did this source get muted".
 */
export const scoreVersions = pgTable(
  "score_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    hits: integer("hits").notNull(),
    misses: integer("misses").notNull(),
    score: real("score").notNull(),
    hitRate: real("hit_rate").notNull(),
    /** The resolution that triggered this recomputation, if any. */
    triggeredByClaimId: uuid("triggered_by_claim_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    walrusBlobId: text("walrus_blob_id"),
  },
  (t) => [index("score_versions_source_idx").on(t.sourceId, t.version)],
);

/**
 * The join between projection and truth: one row per memory ever written.
 * `restore` reads this to know what to expect back from Walrus, and the
 * Memory Explorer renders it directly.
 */
export const memoryLog = pgTable(
  "memory_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: memoryKindEnum("kind").notNull(),
    /** Domain id this memory describes (claim id, source id, …). */
    refId: uuid("ref_id"),
    namespace: text("namespace").notNull(),
    blobId: text("blob_id").notNull(),
    /** Server job/vector row id returned alongside blob_id. */
    serverId: text("server_id"),
    /**
     * `claim:{id}`, `source:{id}`, `resolution:{id}`, `score:{sourceId}:v{n}`.
     * A retry skips a key that is already here. Null on rows rebuilt from
     * recall, which do not carry the key.
     */
    idempotencyKey: text("idempotency_key"),
    textPreview: text("text_preview").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_log_kind_idx").on(t.kind),
    index("memory_log_blob_idx").on(t.blobId),
    uniqueIndex("memory_log_idempotency_key_uidx").on(t.idempotencyKey),
  ],
);

/**
 * One row per seeded post. `applied_at` is set only after every memory for
 * that post has been persisted. A rerun that sees the timestamp skips the
 * post. A rerun that does not resumes whatever blob ids are still missing.
 */
export const seedPosts = pgTable("seed_posts", {
  id: text("id").primaryKey(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

export const jobKindEnum = pgEnum("job_kind", [
  "ingest",
  "rebuild",
  "resolve",
  "restore",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

/**
 * Queue between the Vercel routes and the Coolify worker.
 *
 * A request inserts a row and returns its id. The worker claims one row with
 * `FOR UPDATE SKIP LOCKED`, runs the Walrus write, and stores the result.
 * `attempts` counts claims. A failure before the limit goes back to `pending`
 * with `next_attempt_at` set; after the limit the row is `failed`.
 */
export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: jobKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** When a retry may be claimed. Null means the row is due immediately. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (t) => [index("ingest_jobs_claim_idx").on(t.status, t.nextAttemptAt, t.createdAt)],
);

export type Source = typeof sources.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Resolution = typeof resolutions.$inferSelect;
export type ScoreVersion = typeof scoreVersions.$inferSelect;
export type MemoryLogRow = typeof memoryLog.$inferSelect;
export type SeedPostRow = typeof seedPosts.$inferSelect;
export type IngestJob = typeof ingestJobs.$inferSelect;
