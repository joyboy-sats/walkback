/**
 * Page through the relayer's memory inventory.
 *
 * `@mysten-incubation/memwal` 0.1.8 does not export `listMemories`. The route
 * that GitHub main adds — `GET /v1/owners/:owner/memories` — returns metadata
 * only (blob id, namespace, tombstones). This module is the pure walk and the
 * coverage check. `lib/memwal.ts` signs the HTTP call. Plaintext, when the
 * list item does not carry it, is filled later by `recall()` and matched on
 * blob id. `recall` stays a fallback only when this route is missing.
 *
 * Paginate on `has_more`. The server clamps `limit`, a namespace filter can
 * empty a page while more owner-wide rows remain, and `next_cursor` is a
 * watermark even on the last page.
 */

export const LIST_PAGE_LIMIT = 500;

/** Relayer `POST /api/recall` clamps `limit` at 100. */
export const RECALL_PLAINTEXT_CAP = 100;

export const MAX_LIST_PAGES = 200;

/** One restart. A fresh walk that still sets must_resync is a failed inventory. */
export const MAX_RESYNC_RESTARTS = 1;

export class ListUnavailableError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ListUnavailableError";
    this.status = status;
  }
}

export function isListUnavailable(err: unknown): boolean {
  return err instanceof ListUnavailableError;
}

export interface ListedMemory {
  memoryId: string;
  namespaceId: string;
  blobId: string;
  createdAt: string;
  updatedAt: string;
  agentId: string | null;
  status: string;
  /**
   * Set only when a relayer includes plaintext on the list item. The published
   * read API does not. Empty string is treated as absent.
   */
  text?: string;
}

export interface DeletedMemoryRef {
  memoryId: string;
  namespaceId: string;
  deletedAt: string;
}

export interface MemoriesPage {
  memories: ListedMemory[];
  deleted: DeletedMemoryRef[];
  nextCursor: string | null;
  hasMore: boolean;
  mustResync: boolean;
}

export interface ListWalkResult {
  memories: ListedMemory[];
  deleted: DeletedMemoryRef[];
  pages: number;
  resyncs: number;
}

export interface HydratedText {
  blobId: string;
  text: string;
  namespace: string;
  createdAt?: string;
}

export interface ContentQuery {
  namespace: string;
  query: string;
  limit: number;
  sort: "relevance";
}

export interface InventoryGap {
  namespace: string;
  /** Plaintext rows matched to listed blob ids. */
  recalled: number;
  /** Live listed memories in this namespace. */
  reported: number;
}

export interface InventoryAssessment {
  coverageComplete: boolean;
  warning: string | null;
  memories: HydratedText[];
  gaps: InventoryGap[];
  excludedNamespaces: string[];
  listedByNamespace: Record<string, number>;
  hydratedByNamespace: Record<string, number>;
  deletedCount: number;
  missingBlobIds: string[];
  extraBlobIds: string[];
}

class MustResyncError extends Error {
  constructor() {
    super("must_resync");
    this.name = "MustResyncError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory list item is missing ${field}`);
  }
  return value;
}

/**
 * Accept the relayer JSON. Tombstone fields default for older payloads.
 * A missing `has_more` is a malformed body, not an empty ledger.
 */
export function parseMemoriesPage(raw: unknown): MemoriesPage {
  const body = asRecord(raw, "memory list response");
  if (!Array.isArray(body.memories) || typeof body.has_more !== "boolean") {
    throw new Error("memory list response is missing memories or has_more");
  }
  const memories = body.memories.map((item) => {
    const row = asRecord(item, "memory list item");
    const text = typeof row.text === "string" && row.text.length > 0 ? row.text : undefined;
    const listed: ListedMemory = {
      memoryId: requiredString(row.memory_id, "memory_id"),
      namespaceId: requiredString(row.namespace_id, "namespace_id"),
      blobId: typeof row.blob_id === "string" ? row.blob_id : "",
      createdAt: typeof row.created_at === "string" ? row.created_at : "",
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      agentId: typeof row.agent_id === "string" ? row.agent_id : null,
      status: typeof row.status === "string" ? row.status : "",
    };
    if (text) listed.text = text;
    return listed;
  });
  const deletedRaw = Array.isArray(body.deleted) ? body.deleted : [];
  const deleted = deletedRaw.map((item) => {
    const row = asRecord(item, "deleted memory");
    return {
      memoryId: requiredString(row.memory_id, "memory_id"),
      namespaceId: requiredString(row.namespace_id, "namespace_id"),
      deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : "",
    };
  });
  const next = body.next_cursor;
  return {
    memories,
    deleted,
    nextCursor: typeof next === "string" && next.length > 0 ? next : null,
    hasMore: body.has_more,
    mustResync: body.must_resync === true,
  };
}

/**
 * Live rows: tombstones win, and a repeated memory id is kept once.
 * Order follows the first time each id was listed.
 */
export function liveMemories(
  memories: readonly ListedMemory[],
  deleted: readonly DeletedMemoryRef[],
): ListedMemory[] {
  const deletedIds = new Set(deleted.map((d) => d.memoryId));
  const seen = new Set<string>();
  const live: ListedMemory[] = [];
  for (const memory of memories) {
    if (deletedIds.has(memory.memoryId) || seen.has(memory.memoryId)) continue;
    seen.add(memory.memoryId);
    live.push(memory);
  }
  return live;
}

async function walkOnce(
  fetchPage: (cursor: string | undefined) => Promise<MemoriesPage>,
  namespaces: ReadonlySet<string> | undefined,
  maxPages: number,
): Promise<Omit<ListWalkResult, "resyncs">> {
  const memories: ListedMemory[] = [];
  const deleted: DeletedMemoryRef[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) {
      throw new Error(`memory list still has more pages after ${maxPages}; coverage is incomplete`);
    }
    const page = await fetchPage(cursor);
    pages += 1;
    if (page.mustResync) throw new MustResyncError();
    for (const memory of page.memories) {
      if (namespaces && !namespaces.has(memory.namespaceId)) continue;
      memories.push(memory);
    }
    for (const tombstone of page.deleted) {
      if (namespaces && !namespaces.has(tombstone.namespaceId)) continue;
      deleted.push(tombstone);
    }
    if (!page.hasMore) return { memories, deleted, pages };
    if (!page.nextCursor) {
      throw new Error("memory list has_more is true but next_cursor is missing");
    }
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      throw new Error("memory list cursor did not advance");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/**
 * Walk until `has_more` is false. `must_resync` discards the walk and starts
 * again with no cursor. A throw from `fetchPage` rejects the whole walk —
 * callers must not treat a partial collection as coverage.
 */
export async function walkMemories(opts: {
  fetchPage: (cursor: string | undefined) => Promise<MemoriesPage>;
  namespaces?: ReadonlySet<string>;
  maxPages?: number;
}): Promise<ListWalkResult> {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  let resyncs = 0;
  for (;;) {
    try {
      const once = await walkOnce(opts.fetchPage, opts.namespaces, maxPages);
      return { ...once, resyncs };
    } catch (err) {
      if (!(err instanceof MustResyncError)) throw err;
      resyncs += 1;
      if (resyncs > MAX_RESYNC_RESTARTS) {
        throw new Error("must_resync persisted after restarting the memory list without a cursor");
      }
    }
  }
}

function countsOf(rows: readonly { namespace: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.namespace] = (counts[row.namespace] ?? 0) + 1;
  return counts;
}

/**
 * One relevance recall per product namespace that still needs plaintext.
 * Limit is the live size of that namespace, clamped to the relayer cap.
 * Recall ranks the whole namespace; it cannot be asked for specific blob ids,
 * so a partial inline-text namespace still requests `min(cap, live count)`.
 */
export function contentPlan(input: {
  memories: readonly ListedMemory[];
  deleted: readonly DeletedMemoryRef[];
  productNamespaces: readonly string[];
  recallCap?: number;
}): ContentQuery[] {
  const cap = input.recallCap ?? RECALL_PLAINTEXT_CAP;
  const live = liveMemories(input.memories, input.deleted);
  const plan: ContentQuery[] = [];
  for (const namespace of input.productNamespaces) {
    const rows = live.filter((m) => m.namespaceId === namespace && m.blobId);
    if (rows.length === 0) continue;
    if (rows.every((m) => m.text)) continue;
    plan.push({
      namespace,
      query: "Walkback",
      limit: Math.min(cap, rows.length),
      sort: "relevance",
    });
  }
  return plan;
}

/**
 * Coverage is complete when every live product-namespace memory has plaintext
 * and recall did not return blob ids outside that list. Tombstones are not
 * rows. Namespaces outside `productNamespaces` are excluded from the gaps.
 * A failed walk is incomplete even if some texts were already in hand.
 */
export function finishInventory(input: {
  walk: ListWalkResult | { failed: string };
  texts: readonly HydratedText[];
  productNamespaces: readonly string[];
  /**
   * Namespaces whose plaintext must be loaded. Defaults to every product
   * namespace. `walkback.score` is omitted: those versions are recomputed
   * from resolutions, so a long score history does not have to fit in one recall.
   */
  plaintextNamespaces?: readonly string[];
  hydrationError?: string;
}): InventoryAssessment {
  const product = new Set(input.productNamespaces);
  const requireText = new Set(input.plaintextNamespaces ?? input.productNamespaces);
  if ("failed" in input.walk) {
    return {
      coverageComplete: false,
      warning: input.walk.failed,
      memories: [],
      gaps: [],
      excludedNamespaces: [],
      listedByNamespace: {},
      hydratedByNamespace: {},
      deletedCount: 0,
      missingBlobIds: [],
      extraBlobIds: [],
    };
  }

  const live = liveMemories(input.walk.memories, input.walk.deleted);
  const listedByNamespace = countsOf(live.map((m) => ({ namespace: m.namespaceId })));
  const excludedNamespaces = [...new Set(live.map((m) => m.namespaceId).concat(input.walk.deleted.map((d) => d.namespaceId)))]
    .filter((name) => !product.has(name))
    .sort();

  const textByKey = new Map<string, HydratedText>();
  for (const hit of input.texts) {
    if (!hit.blobId || !hit.text) continue;
    const key = `${hit.namespace}\0${hit.blobId}`;
    if (!textByKey.has(key)) textByKey.set(key, hit);
  }

  const listedKeys = new Set<string>();
  const hydrated: HydratedText[] = [];
  const missingBlobIds: string[] = [];
  for (const memory of live) {
    if (!product.has(memory.namespaceId) || !requireText.has(memory.namespaceId)) continue;
    const key = memory.blobId ? `${memory.namespaceId}\0${memory.blobId}` : `missing:${memory.memoryId}`;
    listedKeys.add(key);
    const inline = memory.text;
    const recalled = memory.blobId ? textByKey.get(`${memory.namespaceId}\0${memory.blobId}`) : undefined;
    const text = inline || recalled?.text;
    if (!memory.blobId || !text) {
      missingBlobIds.push(memory.blobId || memory.memoryId);
      continue;
    }
    const row: HydratedText = {
      blobId: memory.blobId,
      text,
      namespace: memory.namespaceId,
    };
    const createdAt = recalled?.createdAt || memory.createdAt;
    if (createdAt) row.createdAt = createdAt;
    hydrated.push(row);
  }

  const extraBlobIds: string[] = [];
  for (const hit of textByKey.values()) {
    if (!product.has(hit.namespace)) continue;
    if (!listedKeys.has(`${hit.namespace}\0${hit.blobId}`)) extraBlobIds.push(hit.blobId);
  }

  const gaps: InventoryGap[] = [];
  for (const namespace of requireText) {
    if (!product.has(namespace)) continue;
    const reported = live.filter((m) => m.namespaceId === namespace).length;
    const recalled = hydrated.filter((m) => m.namespace === namespace).length;
    if (recalled < reported) gaps.push({ namespace, recalled, reported });
  }

  hydrated.sort((a, b) => a.blobId.localeCompare(b.blobId) || a.namespace.localeCompare(b.namespace));
  missingBlobIds.sort();
  extraBlobIds.sort();

  let warning: string | null = null;
  if (gaps.length > 0) {
    const detail = gaps.map((g) => `${g.namespace} plaintext ${g.recalled} of ${g.reported} listed`).join("; ");
    warning = `plaintext is missing for listed memories (${detail}). The projection was not modified.`;
  } else if (extraBlobIds.length > 0) {
    warning =
      "recall returned blob ids that were not in the list, so the inventory moved during the walk. The projection was not modified.";
  }
  if (input.hydrationError) warning = input.hydrationError;

  const complete = !input.hydrationError && gaps.length === 0 && extraBlobIds.length === 0;
  return {
    coverageComplete: complete,
    warning,
    memories: hydrated,
    gaps,
    excludedNamespaces,
    listedByNamespace,
    hydratedByNamespace: countsOf(hydrated),
    deletedCount: input.walk.deleted.length,
    missingBlobIds,
    extraBlobIds,
  };
}
