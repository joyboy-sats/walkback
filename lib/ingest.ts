/**
 * Ingest: turn a pasted post into stored, memory-backed claims.
 *
 * The order here is deliberate and load-bearing:
 *
 *   1. resolve source
 *   2. extract claims (LLM), unless the caller already has them
 *   3. **snapshot chain state now** — before anything is persisted
 *   4. insert claim rows
 *   5. write claim memories to Walrus
 *
 * Step 3 has to happen at ingest because Sui exposes no historical balances.
 * If the snapshot is taken later, a `balance_change_since_ingest` claim can
 * never be adjudicated. This is the receipt: state frozen at the moment the
 * claim was made. A caller that already recorded the receipt (the seed file)
 * passes `recordedSnapshot` and this step does not call Tatum.
 *
 * Steps 4 and 5 are split on purpose. The claim row is cheap; the memory write
 * is ~6s/item. `deferMemories` returns the writes so the seed script can
 * persist them one at a time. Each blob id is stamped before the next write.
 * A seeded post is skipped only after `seed_posts.applied_at` is set, which
 * happens once those writes have been recorded.
 */
import "server-only";

import { and, eq, like } from "drizzle-orm";
import { getDb, schema } from "./db";
import { pendingWrites } from "./durable-writes";
import { extractClaims } from "./extract";
import { claimExternalId, claimExternalPrefix, stableUuid } from "./ids";
import { logMemories } from "./memory-log";
import { writeMemoriesDurable, type MemoryWrite, type WriteObserver } from "./memwal";
import { claimMemory, sourceMemory } from "./memory-text";
import { findPersistedKeys } from "./persisted-keys";
import { claimIndexFromExternalId, planSeedPost, type SeedPostDecision } from "./seed-plan";
import { storedPublishedAt } from "./post-time";
import { getBalance } from "./tatum";
import { NS } from "./types";
import type {
  BalanceSnapshot,
  ClaimParams,
  ClaimType,
  ExtractedClaim,
  SourceRef,
} from "./types";

const SUI_COIN_TYPE = "0x2::sui::SUI";

export interface StoredClaim {
  id: string;
  quote: string;
  claimType: ClaimType;
  deadline: string;
  confidence: number;
  synthetic: boolean;
}

export interface IngestInput {
  handle: string;
  platform: "x" | "substack" | "rss" | "onchain" | "other";
  text: string;
  /**
   * ISO timestamp the text was published. Null when the client did not send one.
   * Extraction may still use a clock for relative deadlines; that clock is not stored.
   */
  publishedAt: string | null;
  /** Known address for the source; used to fill params.address when text omits it. */
  suiAddress?: string;
  displayName?: string;
  /**
   * Claims already in hand. When set, the model is not called. The seed uses
   * this for `tx_replay`, where the window has to be the one in the file.
   */
  claims?: ExtractedClaim[];
  /**
   * Receipt to store instead of reading Tatum. `null` means "no receipt, do
   * not try to take one". Omit the property to snapshot a live balance.
   */
  recordedSnapshot?: BalanceSnapshot | null;
  /** Demo fallback. Surfaced on the claim row and in the memory text. */
  synthetic?: boolean;
  /** Permalink of the original post. Stored on each claim and in its memory. */
  sourceUrl?: string;
  /**
   * Stable id of a seeded post. Claims are stored under `post:{id}:{index}`
   * so a second seed run finds them and does not write again.
   */
  externalId?: string;
  /** Insert the rows and return the memory writes without sending them. */
  deferMemories?: boolean;
  /**
   * Write the source memory. Default true, and still skipped when this source
   * already has a blob id — a second post from the same handle must not
   * append a second source memory.
   */
  includeSourceMemory?: boolean;
}

export interface IngestResult {
  sourceId: string;
  claimIds: string[];
  /** The claims that were stored, in insert order. Empty is a normal result. */
  claims: StoredClaim[];
  /** Claims rejected by validation or low confidence, with why. */
  rejected: Array<{ quote: string; reason: string }>;
  snapshot: BalanceSnapshot | null;
  memoryBlobIds: string[];
  /** Set when this post was already in the projection. Nothing was written. */
  skipped?: string;
  /** Present only when `deferMemories` is set. The caller must persist these. */
  pendingWrites?: MemoryWrite[];
  /**
   * The seed marker is not set yet. The caller sets it after `pendingWrites`
   * have been persisted. A skip that only needed the marker sets it here.
   */
  needsMarker?: boolean;
}

/** Find or create the source row for a handle. */
export async function upsertSource(
  input: IngestInput,
  opts?: { id?: string },
): Promise<SourceRef & { walrusBlobId: string | null; created: boolean }> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.handle, input.handle))
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      handle: existing.handle,
      platform: existing.platform,
      walrusBlobId: existing.walrusBlobId,
      created: false,
      ...(existing.suiAddress ? { suiAddress: existing.suiAddress } : {}),
    };
  }

  const [created] = await db
    .insert(schema.sources)
    .values({
      ...(opts?.id ? { id: opts.id } : {}),
      handle: input.handle,
      displayName: input.displayName ?? input.handle,
      platform: input.platform,
      suiAddress: input.suiAddress ?? null,
    })
    .returning();

  if (!created) throw new Error("failed to create source");

  // The source memory is written by the caller in the same batch as the
  // claims, so ingest produces one round trip rather than two.
  return {
    id: created.id,
    handle: created.handle,
    platform: created.platform,
    walrusBlobId: created.walrusBlobId,
    created: true,
    ...(created.suiAddress ? { suiAddress: created.suiAddress } : {}),
  };
}

/**
 * Take the receipt. Returns null when the source has no known address, which
 * makes `balance_change_since_ingest` unadjudicable — the claim will resolve
 * to `void` with that stated as the reason, rather than being guessed at.
 */
export async function takeSnapshot(
  address: string | undefined,
  asset = SUI_COIN_TYPE,
): Promise<BalanceSnapshot | null> {
  if (!address) return null;
  const asOf = new Date().toISOString();
  const bal = await getBalance(address, asset);
  return { address, asset, balance: bal.balance, asOf };
}

/**
 * Full ingest. Slow (~1s extraction + ~6s per memory). Call from a background
 * job or a route with a generous timeout — not from a page render.
 */
export async function ingest(input: IngestInput): Promise<IngestResult> {
  const db = getDb();
  const seeded = input.externalId ? await loadSeedLedger(input.externalId, input.handle) : null;

  if (input.externalId && seeded) {
    const decision = planSeedPost({
      expectedClaimCount: input.claims ? input.claims.length : null,
      applied: seeded.applied,
      claims: seeded.claims
        .map((row) => ({
          index: claimIndexFromExternalId(row.externalId ?? "", input.externalId!) ?? -1,
          walrusBlobId: row.walrusBlobId,
        }))
        .filter((row) => row.index >= 0),
      source: seeded.source
        ? {
            exists: true,
            walrusBlobId: seeded.source.walrusBlobId,
            memoryLogged: seeded.memoryLogged,
          }
        : null,
    });
    if (decision.action === "skip") {
      if (decision.markApplied && seeded.source) {
        await markSeedPostApplied(input.externalId, seeded.source.id);
      }
      return skippedResult(seeded, decision.reason);
    }
    const resumed = await resumeSeedPost(input, seeded, decision);
    if (resumed) return resumed;
  }

  const source = await upsertSource(input, {
    ...(input.externalId ? { id: stableUuid(`source:${input.platform}:${input.handle}`) } : {}),
  });

  // ── 1. extract ────────────────────────────────────────────────────────────
  const publishedAt = storedPublishedAt(input.publishedAt);
  const extractAnchor = publishedAt?.toISOString() ?? new Date().toISOString();
  const extracted = input.claims
    ? input.claims
    : await extractClaims({
        handle: input.handle,
        ...(input.suiAddress ? { suiAddress: input.suiAddress } : {}),
        publishedAt: extractAnchor,
        text: input.text,
      });

  const rejected: Array<{ quote: string; reason: string }> = [];
  const accepted = extracted.filter((c) => {
    // A claim about change over time is only checkable if we can freeze state
    // now. Reject at ingest instead of storing something that must resolve void.
    if (c.claimType === "balance_change_since_ingest" && !input.suiAddress) {
      rejected.push({
        quote: c.quote,
        reason: "change-over-time claim but the source has no known SUI address",
      });
      return false;
    }
    return true;
  });

  // ── 2. snapshot before persisting ─────────────────────────────────────────
  const snapshot =
    "recordedSnapshot" in input
      ? (input.recordedSnapshot ?? null)
      : await takeSnapshot(input.suiAddress);

  const synthetic = input.synthetic === true;
  const identities = accepted.map((_, i) =>
    input.externalId
      ? {
          externalId: claimExternalId(input.externalId, i),
          id: stableUuid(claimExternalId(input.externalId, i)),
        }
      : null,
  );

  // ── 3. persist claims ─────────────────────────────────────────────────────
  let rows: ClaimRow[] = [];
  if (accepted.length) {
    const values = accepted.map((c, i) => {
      const identity = identities[i];
      return {
        ...(identity ? { id: identity.id, externalId: identity.externalId } : {}),
        sourceId: source.id,
        quote: c.quote,
        claimType: c.claimType,
        params: c.params as unknown as Record<string, unknown>,
        snapshot: snapshot as unknown as Record<string, unknown> | null,
        deadline: new Date(c.deadline),
        confidence: c.confidence,
        status: "pending" as const,
        synthetic,
        sourceUrl: input.sourceUrl ?? null,
        deadlineBasis: c.deadlineBasis ?? null,
        publishedAt,
      };
    });
    if (input.externalId) {
      await db
        .insert(schema.claims)
        .values(values)
        .onConflictDoNothing({ target: schema.claims.externalId });
      rows = await reloadSeedClaims(input.externalId);
    } else {
      const inserted = await db.insert(schema.claims).values(values).returning({ id: schema.claims.id });
      rows = inserted.map((row, i) => {
        const c = accepted[i];
        if (!c) throw new Error("claim insert did not line up with the extracted list");
        return {
          id: row.id,
          sourceId: source.id,
          quote: c.quote,
          claimType: c.claimType,
          params: c.params as unknown as Record<string, unknown>,
          deadline: new Date(c.deadline),
          confidence: c.confidence,
          synthetic,
          externalId: null,
          sourceUrl: input.sourceUrl ?? null,
          deadlineBasis: c.deadlineBasis ?? null,
          publishedAt,
          snapshot: snapshot as unknown as Record<string, unknown> | null,
          walrusBlobId: null,
        };
      });
    }
  }

  const sourceLogged =
    Boolean(source.walrusBlobId) ||
    Boolean(seeded?.memoryLogged) ||
    (await sourceMemoryLogged(source.id));
  const writes = writesForRows(source, rows, snapshot, synthetic, !sourceLogged && input.includeSourceMemory !== false);

  return finishIngest(input, source.id, rows.map(toStoredClaim), rejected, snapshot, writes);
}

/**
 * Send writes one at a time. Each blob id is logged and stamped before the
 * next item is sent. Items already recorded are not sent again. A failure
 * stops the rest; the successes stay recorded, so a retry continues there.
 */
export async function persistIngestWrites(writes: MemoryWrite[], observer?: WriteObserver): Promise<string[]> {
  const known = await findPersistedKeys(writes);
  const pending = pendingWrites(writes, known);
  const fresh: string[] = [];
  const { error, cause } = await writeMemoriesDurable(pending, async (write, result) => {
    await logMemories([write], [{ id: result.id, blobId: result.blobId, namespace: write.namespace }]);
    await stampBlob(write.idempotencyKey, result.blobId);
    fresh.push(result.blobId);
  }, observer);
  if (error) {
    throw new Error(`memory write stopped after ${fresh.length} new blob(s): ${error}`, cause ? { cause } : undefined);
  }
  return fresh;
}

/** Set once every memory for the post has been persisted. */
export async function markSeedPostApplied(postId: string, sourceId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.seedPosts)
    .values({ id: postId, sourceId, appliedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.seedPosts.id,
      set: { sourceId, appliedAt: new Date() },
    });
}

const claimColumns = {
  id: schema.claims.id,
  sourceId: schema.claims.sourceId,
  quote: schema.claims.quote,
  claimType: schema.claims.claimType,
  params: schema.claims.params,
  deadline: schema.claims.deadline,
  confidence: schema.claims.confidence,
  synthetic: schema.claims.synthetic,
  externalId: schema.claims.externalId,
  sourceUrl: schema.claims.sourceUrl,
  deadlineBasis: schema.claims.deadlineBasis,
  publishedAt: schema.claims.publishedAt,
  snapshot: schema.claims.snapshot,
  walrusBlobId: schema.claims.walrusBlobId,
};

interface ClaimRow {
  id: string;
  sourceId: string;
  quote: string;
  claimType: ClaimType;
  params: Record<string, unknown>;
  deadline: Date;
  confidence: number;
  synthetic: boolean;
  externalId: string | null;
  sourceUrl: string | null;
  deadlineBasis: string | null;
  publishedAt: Date | null;
  snapshot: Record<string, unknown> | null;
  walrusBlobId: string | null;
}

interface SeedLedger {
  applied: boolean;
  claims: ClaimRow[];
  source: { id: string; walrusBlobId: string | null } | null;
  memoryLogged: boolean;
}

interface SourceRow {
  id: string;
  handle: string;
  platform: SourceRef["platform"];
  suiAddress?: string;
  walrusBlobId: string | null;
}

async function loadSeedLedger(postId: string, handle: string): Promise<SeedLedger> {
  const db = getDb();
  const claims = await reloadSeedClaims(postId);
  const [source] = await db
    .select({ id: schema.sources.id, walrusBlobId: schema.sources.walrusBlobId })
    .from(schema.sources)
    .where(eq(schema.sources.handle, handle))
    .limit(1);
  const memoryLogged = source ? await sourceMemoryLogged(source.id) : false;
  const [marker] = await db
    .select({ appliedAt: schema.seedPosts.appliedAt })
    .from(schema.seedPosts)
    .where(eq(schema.seedPosts.id, postId))
    .limit(1);
  return {
    applied: Boolean(marker?.appliedAt),
    claims,
    source: source ?? null,
    memoryLogged,
  };
}

async function reloadSeedClaims(postId: string): Promise<ClaimRow[]> {
  const prefix = claimExternalPrefix(postId);
  const rows = await getDb()
    .select(claimColumns)
    .from(schema.claims)
    .where(like(schema.claims.externalId, `${prefix}%`));
  return rows
    .map((row) => ({
      ...row,
      claimType: row.claimType as ClaimType,
      params: (row.params ?? {}) as Record<string, unknown>,
      snapshot: (row.snapshot as Record<string, unknown> | null) ?? null,
    }))
    .filter((row) => claimIndexFromExternalId(row.externalId ?? "", postId) !== null)
    .sort(
      (a, b) =>
        claimIndexFromExternalId(a.externalId ?? "", postId)! -
        claimIndexFromExternalId(b.externalId ?? "", postId)!,
    );
}

async function sourceMemoryLogged(sourceId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.memoryLog.id })
    .from(schema.memoryLog)
    .where(and(eq(schema.memoryLog.kind, "source"), eq(schema.memoryLog.refId, sourceId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Resume a partial seed. A first insert (no claim rows yet) returns null so
 * the caller can extract and insert. Existing claim rows are not inserted again.
 */
async function resumeSeedPost(
  input: IngestInput,
  ledger: SeedLedger,
  decision: SeedPostDecision,
): Promise<IngestResult | null> {
  if (decision.action !== "resume" || !input.externalId) return null;
  const postId = input.externalId;
  const source = await upsertSource(input, {
    id: stableUuid(`source:${input.platform}:${input.handle}`),
  });
  const pending = new Set(decision.pendingClaimIndexes ?? []);
  const have = new Set(
    ledger.claims
      .map((row) => claimIndexFromExternalId(row.externalId ?? "", postId))
      .filter((index): index is number => index !== null),
  );
  const missing = [...pending].filter((index) => !have.has(index));
  const publishedAt = storedPublishedAt(input.publishedAt);
  if (missing.length && input.claims) {
    const snapshot =
      "recordedSnapshot" in input ? (input.recordedSnapshot ?? null) : ((ledger.claims[0]?.snapshot as BalanceSnapshot | null) ?? null);
    await getDb()
      .insert(schema.claims)
      .values(
        missing.map((index) => {
          const c = input.claims?.[index];
          if (!c) throw new Error(`post ${postId} is missing claim ${index}`);
          const externalId = claimExternalId(postId, index);
          return {
            id: stableUuid(externalId),
            externalId,
            sourceId: source.id,
            quote: c.quote,
            claimType: c.claimType,
            params: c.params as unknown as Record<string, unknown>,
            snapshot: snapshot as unknown as Record<string, unknown> | null,
            deadline: new Date(c.deadline),
            confidence: c.confidence,
            status: "pending" as const,
            synthetic: input.synthetic === true,
            sourceUrl: input.sourceUrl ?? null,
            deadlineBasis: c.deadlineBasis ?? null,
            publishedAt,
          };
        }),
      )
      .onConflictDoNothing({ target: schema.claims.externalId });
  }

  const rows = await reloadSeedClaims(postId);
  const snapshot = (rows[0]?.snapshot as BalanceSnapshot | null) ?? null;
  const logged = Boolean(source.walrusBlobId) || ledger.memoryLogged || (await sourceMemoryLogged(source.id));
  const writes: MemoryWrite[] = [];
  if (decision.writeSourceMemory && input.includeSourceMemory !== false && !logged) {
    writes.push(sourceWrite(source, input.synthetic === true));
  }
  for (const row of rows) {
    const index = claimIndexFromExternalId(row.externalId ?? "", postId);
    if (index === null || !pending.has(index) || row.walrusBlobId) continue;
    writes.push(claimWrite(row, source.handle, (row.snapshot as BalanceSnapshot | null) ?? snapshot));
  }
  return finishIngest(input, source.id, rows.map(toStoredClaim), [], snapshot, writes);
}

function writesForRows(
  source: SourceRow,
  rows: readonly ClaimRow[],
  snapshot: BalanceSnapshot | null,
  synthetic: boolean,
  writeSource: boolean,
): MemoryWrite[] {
  const writes: MemoryWrite[] = [];
  if (writeSource) writes.push(sourceWrite(source, synthetic));
  for (const row of rows) {
    if (row.walrusBlobId) continue;
    writes.push(claimWrite(row, source.handle, (row.snapshot as BalanceSnapshot | null) ?? snapshot));
  }
  return writes;
}

function sourceWrite(source: SourceRow, synthetic: boolean): MemoryWrite {
  const mem = sourceMemory(
    {
      id: source.id,
      handle: source.handle,
      platform: source.platform,
      ...(source.suiAddress ? { suiAddress: source.suiAddress } : {}),
    },
    { createdAt: new Date().toISOString(), synthetic },
  );
  return { text: mem.text, namespace: NS.source, idempotencyKey: mem.key };
}

function claimWrite(row: ClaimRow, handle: string, snapshot: BalanceSnapshot | null): MemoryWrite {
  const deadline = row.deadline.toISOString();
  const params = row.params as unknown as ClaimParams;
  const mem = claimMemory(
    {
      id: row.id,
      sourceHandle: handle,
      claimType: row.claimType,
      params,
      deadline,
      confidence: row.confidence,
    },
    { quote: row.quote, claimType: row.claimType, params, deadline, confidence: row.confidence },
    snapshot,
    {
      synthetic: row.synthetic,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
      ...(row.deadlineBasis ? { deadlineBasis: row.deadlineBasis } : {}),
      ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    },
  );
  return { text: mem.text, namespace: NS.claim, idempotencyKey: mem.key };
}

async function finishIngest(
  input: IngestInput,
  sourceId: string,
  stored: StoredClaim[],
  rejected: Array<{ quote: string; reason: string }>,
  snapshot: BalanceSnapshot | null,
  writes: MemoryWrite[],
): Promise<IngestResult> {
  const base = {
    sourceId,
    claimIds: stored.map((c) => c.id),
    claims: stored,
    rejected,
    snapshot,
  };
  if (input.deferMemories) {
    return { ...base, memoryBlobIds: [], pendingWrites: writes, needsMarker: Boolean(input.externalId) };
  }
  const memoryBlobIds = writes.length ? await persistIngestWrites(writes) : [];
  if (input.externalId) await markSeedPostApplied(input.externalId, sourceId);
  return { ...base, memoryBlobIds, needsMarker: false };
}

function skippedResult(ledger: SeedLedger, reason: string): IngestResult {
  const first = ledger.claims[0];
  return {
    sourceId: ledger.source?.id ?? first?.sourceId ?? "",
    claimIds: ledger.claims.map((c) => c.id),
    claims: ledger.claims.map(toStoredClaim),
    rejected: [],
    snapshot: (first?.snapshot as BalanceSnapshot | null) ?? null,
    memoryBlobIds: ledger.claims.map((c) => c.walrusBlobId).filter((id): id is string => Boolean(id)),
    skipped: reason,
    needsMarker: false,
  };
}

function toStoredClaim(row: ClaimRow): StoredClaim {
  return {
    id: row.id,
    quote: row.quote,
    claimType: row.claimType,
    deadline: row.deadline.toISOString(),
    confidence: row.confidence,
    synthetic: row.synthetic,
  };
}

async function stampBlob(key: string, blobId: string): Promise<void> {
  const db = getDb();
  if (key.startsWith("claim:")) {
    const id = key.slice("claim:".length);
    await db.update(schema.claims).set({ walrusBlobId: blobId }).where(eq(schema.claims.id, id));
    return;
  }
  if (key.startsWith("source:")) {
    const id = key.slice("source:".length);
    await db.update(schema.sources).set({ walrusBlobId: blobId }).where(eq(schema.sources.id, id));
  }
}
