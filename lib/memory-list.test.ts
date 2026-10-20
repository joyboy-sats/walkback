import { describe, expect, it, vi } from "vitest";
import {
  contentPlan,
  finishInventory,
  liveMemories,
  parseMemoriesPage,
  walkMemories,
  type ListedMemory,
  type MemoriesPage,
} from "./memory-list";

const PRODUCT = ["walkback.claim", "walkback.source"];

function page(partial: Partial<MemoriesPage> & Pick<MemoriesPage, "memories" | "hasMore">): MemoriesPage {
  return {
    deleted: [],
    nextCursor: null,
    mustResync: false,
    ...partial,
  };
}

function listed(partial: Partial<ListedMemory> & Pick<ListedMemory, "memoryId" | "namespaceId" | "blobId">): ListedMemory {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agentId: null,
    status: "active",
    ...partial,
  };
}

describe("parseMemoriesPage", () => {
  it("reads metadata, defaults tombstone fields, and does not require plaintext", () => {
    const parsed = parseMemoriesPage({
      memories: [
        {
          memory_id: "m1",
          namespace_id: "walkback.claim",
          blob_id: "blob-1",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
          agent_id: "ab",
          status: "active",
        },
      ],
      next_cursor: "cur",
      has_more: true,
      snapshot_version: 2,
    });
    expect(parsed.deleted).toEqual([]);
    expect(parsed.mustResync).toBe(false);
    expect(parsed.memories[0]).toMatchObject({
      memoryId: "m1",
      namespaceId: "walkback.claim",
      blobId: "blob-1",
      agentId: "ab",
    });
    expect(parsed.memories[0]?.text).toBeUndefined();
  });

  it("keeps plaintext when a list item actually carries it", () => {
    const parsed = parseMemoriesPage({
      memories: [
        {
          memory_id: "m1",
          namespace_id: "walkback.claim",
          blob_id: "blob-1",
          text: "CLAIM hello",
        },
      ],
      has_more: false,
      deleted: [],
      must_resync: false,
    });
    expect(parsed.memories[0]?.text).toBe("CLAIM hello");
  });

  it("rejects a body that cannot prove the walk ended", () => {
    expect(() => parseMemoriesPage({ memories: [] })).toThrow(/has_more/);
    expect(() => parseMemoriesPage({ has_more: false })).toThrow(/memories/);
  });
});

describe("walkMemories", () => {
  it("pages on has_more and stops when the last page still has a watermark cursor", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (!cursor) {
        return page({
          memories: [listed({ memoryId: "m1", namespaceId: "walkback.claim", blobId: "b1" })],
          hasMore: true,
          nextCursor: "c1",
        });
      }
      return page({
        memories: [listed({ memoryId: "m2", namespaceId: "walkback.claim", blobId: "b2" })],
        hasMore: false,
        nextCursor: "c2",
      });
    });

    const walked = await walkMemories({ fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]?.[0]).toBe("c1");
    expect(walked.memories.map((m) => m.memoryId)).toEqual(["m1", "m2"]);
    expect(walked.pages).toBe(2);
    expect(walked.resyncs).toBe(0);
  });

  it("keeps paging when a namespace filter empties a page that still has_more", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (!cursor) {
        return page({
          memories: [listed({ memoryId: "s1", namespaceId: "walkback.smoke", blobId: "smoke" })],
          hasMore: true,
          nextCursor: "c1",
        });
      }
      return page({
        memories: [listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "claim" })],
        hasMore: false,
        nextCursor: "c2",
      });
    });

    const walked = await walkMemories({
      fetchPage,
      namespaces: new Set(["walkback.claim"]),
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(walked.memories.map((m) => m.blobId)).toEqual(["claim"]);
  });

  it("restarts without a cursor when must_resync is set and drops the stale page", async () => {
    const decoy = listed({ memoryId: "stale", namespaceId: "walkback.claim", blobId: "stale" });
    const first = listed({ memoryId: "a", namespaceId: "walkback.claim", blobId: "a" });
    const second = listed({ memoryId: "b", namespaceId: "walkback.claim", blobId: "b" });
    let calls = 0;
    const fetchPage = vi.fn(async (cursor?: string) => {
      calls += 1;
      if (calls === 1) {
        return page({ memories: [decoy], hasMore: true, nextCursor: "old", mustResync: true });
      }
      if (!cursor) {
        return page({ memories: [first], hasMore: true, nextCursor: "c1" });
      }
      return page({ memories: [second], hasMore: false, nextCursor: "c2" });
    });

    const walked = await walkMemories({ fetchPage });
    expect(walked.resyncs).toBe(1);
    expect(walked.memories.map((m) => m.memoryId)).toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("fails when must_resync is still set on a fresh walk", async () => {
    const fetchPage = vi.fn(async () =>
      page({ memories: [], hasMore: false, mustResync: true }),
    );
    await expect(walkMemories({ fetchPage })).rejects.toThrow(/must_resync persisted/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("rejects a mid-walk failure instead of returning a partial inventory", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (!cursor) {
        return page({
          memories: [listed({ memoryId: "m1", namespaceId: "walkback.claim", blobId: "b1" })],
          hasMore: true,
          nextCursor: "c1",
        });
      }
      throw new Error("relayer 500");
    });
    await expect(walkMemories({ fetchPage })).rejects.toThrow(/relayer 500/);
  });

  it("rejects has_more without a cursor and a cursor that does not advance", async () => {
    await expect(
      walkMemories({
        fetchPage: async () => page({ memories: [], hasMore: true, nextCursor: null }),
      }),
    ).rejects.toThrow(/next_cursor/);

    await expect(
      walkMemories({
        fetchPage: async () => page({ memories: [], hasMore: true, nextCursor: "same" }),
      }),
    ).rejects.toThrow(/did not advance/);
  });
});

describe("live memories and coverage", () => {
  it("drops tombstones even when the same id is also in memories", () => {
    const live = liveMemories(
      [
        listed({ memoryId: "gone", namespaceId: "walkback.claim", blobId: "gone" }),
        listed({ memoryId: "keep", namespaceId: "walkback.claim", blobId: "keep" }),
      ],
      [{ memoryId: "gone", namespaceId: "walkback.claim", deletedAt: "2026-02-01T00:00:00.000Z" }],
    );
    expect(live.map((m) => m.memoryId)).toEqual(["keep"]);
  });

  it("plans one recall per product namespace that still needs plaintext, under the cap", () => {
    const memories = [
      listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "c1" }),
      listed({ memoryId: "c2", namespaceId: "walkback.claim", blobId: "c2", text: "already" }),
      listed({ memoryId: "s1", namespaceId: "walkback.source", blobId: "s1", text: "source text" }),
      listed({ memoryId: "smoke", namespaceId: "walkback.smoke", blobId: "smoke" }),
      listed({ memoryId: "gone", namespaceId: "walkback.claim", blobId: "gone" }),
    ];
    const deleted = [{ memoryId: "gone", namespaceId: "walkback.claim", deletedAt: "t" }];
    const plan = contentPlan({ memories, deleted, productNamespaces: PRODUCT, recallCap: 100 });
    expect(plan).toEqual([
      { namespace: "walkback.claim", query: "Walkback", limit: 2, sort: "relevance" },
    ]);

    const many = Array.from({ length: 101 }, (_, i) =>
      listed({ memoryId: `m${i}`, namespaceId: "walkback.claim", blobId: `b${i}` }),
    );
    expect(contentPlan({ memories: many, deleted: [], productNamespaces: PRODUCT })[0]?.limit).toBe(100);
  });

  it("is complete only when every live product blob has plaintext", () => {
    const walk = {
      memories: [
        listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "c1" }),
        listed({ memoryId: "c2", namespaceId: "walkback.claim", blobId: "c2" }),
        listed({ memoryId: "smoke", namespaceId: "walkback.smoke", blobId: "smoke" }),
      ],
      deleted: [{ memoryId: "gone", namespaceId: "walkback.claim", deletedAt: "t" }],
      pages: 1,
      resyncs: 0,
    };
    walk.memories.push(listed({ memoryId: "gone", namespaceId: "walkback.claim", blobId: "gone" }));

    const short = finishInventory({
      walk,
      texts: [{ blobId: "c1", text: "one", namespace: "walkback.claim" }],
      productNamespaces: PRODUCT,
    });
    expect(short.coverageComplete).toBe(false);
    expect(short.gaps).toEqual([{ namespace: "walkback.claim", recalled: 1, reported: 2 }]);
    expect(short.missingBlobIds).toEqual(["c2"]);
    expect(short.excludedNamespaces).toEqual(["walkback.smoke"]);
    expect(short.memories.map((m) => m.blobId)).toEqual(["c1"]);
    expect(short.deletedCount).toBe(1);

    const full = finishInventory({
      walk,
      texts: [
        { blobId: "c2", text: "two", namespace: "walkback.claim" },
        { blobId: "c1", text: "one", namespace: "walkback.claim" },
      ],
      productNamespaces: PRODUCT,
    });
    expect(full.coverageComplete).toBe(true);
    expect(full.memories.map((m) => m.blobId)).toEqual(["c1", "c2"]);
    expect(full.warning).toBeNull();
  });

  it("treats an empty finished list as complete and a failed walk as incomplete", () => {
    const empty = finishInventory({
      walk: { memories: [], deleted: [], pages: 1, resyncs: 0 },
      texts: [],
      productNamespaces: PRODUCT,
    });
    expect(empty.coverageComplete).toBe(true);

    const failed = finishInventory({
      walk: { failed: "relayer 500" },
      texts: [{ blobId: "c1", text: "one", namespace: "walkback.claim" }],
      productNamespaces: PRODUCT,
    });
    expect(failed.coverageComplete).toBe(false);
    expect(failed.memories).toEqual([]);
    expect(failed.warning).toBe("relayer 500");
  });

  it("refuses coverage when recall returns blob ids outside the list or hydration throws", () => {
    const walk = {
      memories: [listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "c1" })],
      deleted: [],
      pages: 1,
      resyncs: 0,
    };
    const extra = finishInventory({
      walk,
      texts: [
        { blobId: "c1", text: "one", namespace: "walkback.claim" },
        { blobId: "other", text: "extra", namespace: "walkback.claim" },
      ],
      productNamespaces: PRODUCT,
    });
    expect(extra.coverageComplete).toBe(false);
    expect(extra.extraBlobIds).toEqual(["other"]);
    expect(extra.memories.map((m) => m.blobId)).toEqual(["c1"]);

    const thrown = finishInventory({
      walk,
      texts: [{ blobId: "c1", text: "one", namespace: "walkback.claim" }],
      productNamespaces: PRODUCT,
      hydrationError: "plaintext recall failed",
    });
    expect(thrown.coverageComplete).toBe(false);
    expect(thrown.warning).toBe("plaintext recall failed");
    expect(thrown.memories).toHaveLength(1);
  });

  it("does not require plaintext for a namespace marked as derived", () => {
    const walk = {
      memories: [
        listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "c1" }),
        listed({ memoryId: "s1", namespaceId: "walkback.score", blobId: "score-1" }),
      ],
      deleted: [],
      pages: 1,
      resyncs: 0,
    };
    const assessment = finishInventory({
      walk,
      texts: [{ blobId: "c1", text: "claim", namespace: "walkback.claim" }],
      productNamespaces: ["walkback.claim", "walkback.score"],
      plaintextNamespaces: ["walkback.claim"],
    });
    expect(assessment.coverageComplete).toBe(true);
    expect(assessment.gaps).toEqual([]);
    expect(assessment.listedByNamespace["walkback.score"]).toBe(1);
    expect(assessment.memories.map((memory) => memory.blobId)).toEqual(["c1"]);
  });

  it("uses inline list plaintext and ignores a blank blob id", () => {
    const walk = {
      memories: [
        listed({ memoryId: "c1", namespaceId: "walkback.claim", blobId: "c1", text: "inline" }),
        listed({ memoryId: "c2", namespaceId: "walkback.claim", blobId: "" }),
      ],
      deleted: [],
      pages: 1,
      resyncs: 0,
    };
    const assessment = finishInventory({ walk, texts: [], productNamespaces: PRODUCT });
    expect(assessment.coverageComplete).toBe(false);
    expect(assessment.memories.map((m) => m.text)).toEqual(["inline"]);
    expect(assessment.missingBlobIds).toEqual(["c2"]);
  });
});
