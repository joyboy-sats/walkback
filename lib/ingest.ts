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
 * is ~6s/item. A caller that cannot wait should `await` the insert and let the
 * memory write finish in the background — `walrusBlobId` staying null is the
 * signal that a claim is not yet durable. `deferMemories` is that split: the
 * seed script collects writes and flushes them with `writeMemoriesBulk` in
 * batches of 20.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { extractClaims } from "./extract";
import { claimExternalId, claimExternalPrefix, stableUuid } from "./ids";
import { logMemories } from "./memory-log";
import { writeMemoriesBulk, type MemoryWrite } from "./memwal";
import { claimMemory, sourceMemory } from "./memory-text";
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
  /** ISO timestamp the text was published. Anchors relative deadlines. */
  publishedAt: string;
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

  if (input.externalId) {
    const already = await findSeededPost(input.externalId);
    if (already) return already;
  }

  const source = await upsertSource(input, {
    ...(input.externalId ? { id: stableUuid(`source:${input.platform}:${input.handle}`) } : {}),
  });

  // ── 1. extract ────────────────────────────────────────────────────────────
  const extracted = input.claims
    ? input.claims
    : await extractClaims({
        handle: input.handle,
        ...(input.suiAddress ? { suiAddress: input.suiAddress } : {}),
        publishedAt: input.publishedAt,
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

  // Re-check after extraction. Two calls racing on the same post id should
  // not both insert, and the ids we are about to use are now known.
  if (input.externalId) {
    const already = await findSeededPost(input.externalId);
    if (already) return already;
  }

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
  const inserted = accepted.length
    ? await db
        .insert(schema.claims)
        .values(
          accepted.map((c, i) => {
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
            };
          }),
        )
        .returning({ id: schema.claims.id })
    : [];

  const stored: StoredClaim[] = inserted.map((row, i) => {
    const c = accepted[i];
    return {
      id: row.id,
      quote: c?.quote ?? "",
      claimType: (c?.claimType ?? "manual") as ClaimType,
      deadline: c ? new Date(c.deadline).toISOString() : "",
      confidence: c?.confidence ?? 0,
      synthetic,
    };
  });

  // ── 4. write memories ─────────────────────────────────────────────────────
  const writes: MemoryWrite[] = [];
  const writeSource = input.includeSourceMemory !== false && !source.walrusBlobId;

  if (writeSource) {
    const srcMem = sourceMemory(
      { id: source.id, handle: source.handle, platform: source.platform, ...(source.suiAddress ? { suiAddress: source.suiAddress } : {}) },
      { createdAt: new Date().toISOString(), synthetic },
    );
    writes.push({ text: srcMem.text, namespace: NS.source, idempotencyKey: srcMem.key });
  }

  for (let i = 0; i < inserted.length; i++) {
    const claim = inserted[i];
    const c = accepted[i];
    if (!claim || !c) continue;
    const identity = identities[i];
    const mem = claimMemory(
      {
        id: claim.id,
        sourceHandle: source.handle,
        claimType: c.claimType as ClaimType,
        params: c.params as ClaimParams,
        deadline: c.deadline,
        confidence: c.confidence,
      },
      c,
      snapshot,
      {
        synthetic,
        ...(identity ? { externalId: identity.externalId } : {}),
      },
    );
    writes.push({
      text: mem.text,
      namespace: NS.claim,
      idempotencyKey: mem.key,
    });
  }

  if (input.deferMemories) {
    return {
      sourceId: source.id,
      claimIds: stored.map((c) => c.id),
      claims: stored,
      rejected,
      snapshot,
      memoryBlobIds: [],
      pendingWrites: writes,
    };
  }

  const memoryBlobIds = await persistIngestWrites(writes);

  return {
    sourceId: source.id,
    claimIds: stored.map((c) => c.id),
    claims: stored,
    rejected,
    snapshot,
    memoryBlobIds,
  };
}

/**
 * Send ingest writes to Walrus and stamp blob ids back onto the rows.
 *
 * One namespace per `writeMemoriesBulk` call, and that helper already splits
 * at 20 items. Callers that batch several posts should still pass the grouped
 * list through here rather than calling `writeMemory` in a loop.
 */
export async function persistIngestWrites(writes: MemoryWrite[]): Promise<string[]> {
  const db = getDb();
  const memoryBlobIds: string[] = [];
  const claimBlobByKey = new Map<string, string>();
  const sourceBlobByKey = new Map<string, string>();

  const namespaces = [...new Set(writes.map((w) => w.namespace))];
  for (const ns of namespaces) {
    const batch = writes.filter((w) => w.namespace === ns);
    if (!batch.length) continue;
    const { results } = await writeMemoriesBulk(batch);
    const bad = results.filter((r) => r.error);
    if (bad.length) {
      throw new Error(
        `memory write failed for ${bad.length} ${ns} record(s): ` +
          bad.map((b) => b.error).join("; "),
      );
    }
    results.forEach((r, i) => {
      if (!r.blobId) return;
      memoryBlobIds.push(r.blobId);
      const w = batch[i];
      if (!w) return;
      if (ns === NS.claim) claimBlobByKey.set(w.idempotencyKey, r.blobId);
      if (ns === NS.source) sourceBlobByKey.set(w.idempotencyKey, r.blobId);
    });

    await logMemories(batch, results);
  }

  for (const [key, blobId] of claimBlobByKey) {
    const id = key.startsWith("claim:") ? key.slice("claim:".length) : "";
    if (!id) continue;
    await db.update(schema.claims).set({ walrusBlobId: blobId }).where(eq(schema.claims.id, id));
  }
  for (const [key, blobId] of sourceBlobByKey) {
    const id = key.startsWith("source:") ? key.slice("source:".length) : "";
    if (!id) continue;
    await db.update(schema.sources).set({ walrusBlobId: blobId }).where(eq(schema.sources.id, id));
  }

  return memoryBlobIds;
}

async function findSeededPost(postId: string): Promise<IngestResult | null> {
  const db = getDb();
  const prefix = claimExternalPrefix(postId);
  const rows = await db
    .select({
      id: schema.claims.id,
      sourceId: schema.claims.sourceId,
      quote: schema.claims.quote,
      claimType: schema.claims.claimType,
      deadline: schema.claims.deadline,
      confidence: schema.claims.confidence,
      synthetic: schema.claims.synthetic,
      externalId: schema.claims.externalId,
      snapshot: schema.claims.snapshot,
      walrusBlobId: schema.claims.walrusBlobId,
    })
    .from(schema.claims);

  const mine = rows.filter((r) => r.externalId?.startsWith(prefix));
  const first = mine[0];
  if (!first) return null;

  const snapshot = (first.snapshot as BalanceSnapshot | null) ?? null;
  return {
    sourceId: first.sourceId,
    claimIds: mine.map((r) => r.id),
    claims: mine.map((r) => ({
      id: r.id,
      quote: r.quote,
      claimType: r.claimType,
      deadline: r.deadline.toISOString(),
      confidence: r.confidence,
      synthetic: r.synthetic,
    })),
    rejected: [],
    snapshot,
    memoryBlobIds: mine.map((r) => r.walrusBlobId).filter((id): id is string => Boolean(id)),
    skipped: "already ingested",
  };
}
