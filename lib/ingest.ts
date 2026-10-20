/**
 * Ingest: turn a pasted post into stored, memory-backed claims.
 *
 * The order here is deliberate and load-bearing:
 *
 *   1. resolve source
 *   2. extract claims (LLM)
 *   3. **snapshot chain state now** — before anything is persisted
 *   4. insert claim rows
 *   5. write claim memories to Walrus
 *
 * Step 3 has to happen at ingest because Sui exposes no historical balances.
 * If the snapshot is taken later, a `balance_change_since_ingest` claim can
 * never be adjudicated. This is the receipt: state frozen at the moment the
 * claim was made.
 *
 * Steps 4 and 5 are split on purpose. The claim row is cheap; the memory write
 * is ~6s/item. A caller that cannot wait should `await` the insert and let the
 * memory write finish in the background — `memoryWrittenAt` staying null is
 * the signal that a claim is not yet durable.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { extractClaims } from "./extract";
import { logMemories } from "./memory-log";
import { writeMemoriesBulk } from "./memwal";
import { claimMemory, sourceMemory } from "./memory-text";
import { getBalance } from "./tatum";
import { NS } from "./types";
import type { BalanceSnapshot, ClaimParams, ClaimType, SourceRef } from "./types";

const SUI_COIN_TYPE = "0x2::sui::SUI";

export interface IngestInput {
  handle: string;
  platform: "x" | "substack" | "rss" | "onchain" | "other";
  text: string;
  /** ISO timestamp the text was published. Anchors relative deadlines. */
  publishedAt: string;
  /** Known address for the source; used to fill params.address when text omits it. */
  suiAddress?: string;
  displayName?: string;
}

export interface IngestResult {
  sourceId: string;
  claimIds: string[];
  /** Claims rejected by validation or low confidence, with why. */
  rejected: Array<{ quote: string; reason: string }>;
  snapshot: BalanceSnapshot | null;
  memoryBlobIds: string[];
}

/** Find or create the source row for a handle. */
export async function upsertSource(input: IngestInput): Promise<SourceRef> {
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
      ...(existing.suiAddress ? { suiAddress: existing.suiAddress } : {}),
    };
  }

  const [created] = await db
    .insert(schema.sources)
    .values({
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
  const source = await upsertSource(input);

  // ── 1. extract ────────────────────────────────────────────────────────────
  const extracted = await extractClaims({
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

  // ── 2. snapshot before persisting ─────────────────────────────────────────
  const snapshot = await takeSnapshot(input.suiAddress);

  // ── 3. persist claims ─────────────────────────────────────────────────────
  const inserted = accepted.length
    ? await db
        .insert(schema.claims)
        .values(
          accepted.map((c) => ({
            sourceId: source.id,
            quote: c.quote,
            claimType: c.claimType,
            params: c.params as unknown as Record<string, unknown>,
            snapshot: snapshot as unknown as Record<string, unknown> | null,
            deadline: new Date(c.deadline),
            confidence: c.confidence,
            status: "pending" as const,
          })),
        )
        .returning({ id: schema.claims.id })
    : [];

  // ── 4. write memories ─────────────────────────────────────────────────────
  const writes: Array<{
    text: string;
    namespace: typeof NS.claim | typeof NS.source;
    idempotencyKey: string;
  }> = [];

  const srcMem = sourceMemory(source, { createdAt: new Date().toISOString() });
  writes.push({ text: srcMem.text, namespace: NS.source, idempotencyKey: srcMem.key });

  for (let i = 0; i < inserted.length; i++) {
    const claim = inserted[i];
    const c = accepted[i];
    if (!claim || !c) continue;
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
    );
    writes.push({
      text: mem.text,
      namespace: NS.claim,
      idempotencyKey: mem.key,
    });
  }

  const memoryBlobIds: string[] = [];
  const claimBlobByKey = new Map<string, string>();

  // `writeMemoriesBulk` requires one namespace per call; ingest writes sources
  // and claims, so group them. Results come back aligned with each batch.
  for (const ns of [NS.source, NS.claim] as const) {
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
      if (ns === NS.claim && w) claimBlobByKey.set(w.idempotencyKey, r.blobId);
    });

    // Record in the projection so the Memory Explorer can show every blob.
    await logMemories(batch, results);
  }

  // Backfill blob ids onto the claim rows so the UI can link to the blob and
  // the submission checklist can count mainnet memories.
  for (let i = 0; i < inserted.length; i++) {
    const claim = inserted[i];
    if (!claim) continue;
    const blobId = claimBlobByKey.get(`claim:${claim.id}`);
    if (!blobId) continue;
    await db
      .update(schema.claims)
      .set({ walrusBlobId: blobId })
      .where(eq(schema.claims.id, claim.id));
  }

  return {
    sourceId: source.id,
    claimIds: inserted.map((c) => c.id),
    rejected,
    snapshot,
    memoryBlobIds,
  };
}
