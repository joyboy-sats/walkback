import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimMemory } from "./memory-text";
import {
  chunk,
  formatSeedSummary,
  isSynthetic,
  materializeClaims,
  parseClaimsFile,
  planSeedPost,
  plannedClaimIdentity,
  SEED_BULK_MAX,
} from "./seed-plan";

const file = parseClaimsFile(JSON.parse(readFileSync("data/claims.json", "utf8")));

describe("data/claims.json", () => {
  it("is a synthetic placeholder file, including a tx_replay and a recorded snapshot", () => {
    expect(file.posts.length).toBeGreaterThan(0);
    expect(file.posts.every(isSynthetic)).toBe(true);
    const replay = file.posts.find((p) => p.claims?.some((c) => c.claim_type === "tx_replay"));
    expect(replay).toBeDefined();
    const recorded = file.posts.find((p) => p.snapshot && p.snapshot.balance);
    expect(recorded?.snapshot && "balance" in recorded.snapshot && recorded.snapshot.balance).toBeTruthy();
    for (const post of file.posts) {
      expect(post.text.toLowerCase()).toContain("placeholder");
    }
  });
});

describe("planSeedPost", () => {
  const sourceMissing = { exists: true, walrusBlobId: null, memoryLogged: false };
  const sourceLogged = { exists: true, walrusBlobId: null, memoryLogged: true };
  const sourceStamped = { exists: true, walrusBlobId: "blob-src", memoryLogged: true };

  it("treats a source row with no claims as unfinished, and writes the source memory once", () => {
    const crashedBetweenInserts = planSeedPost({
      expectedClaimCount: 1,
      applied: false,
      claims: [],
      source: sourceMissing,
    });
    expect(crashedBetweenInserts.action).toBe("insert");
    expect(crashedBetweenInserts.writeSourceMemory).toBe(true);
    expect(crashedBetweenInserts.pendingClaimIndexes).toEqual([0]);

    const memoryAlreadyLogged = planSeedPost({
      expectedClaimCount: 1,
      applied: false,
      claims: [],
      source: sourceLogged,
    });
    expect(memoryAlreadyLogged.action).toBe("insert");
    expect(memoryAlreadyLogged.writeSourceMemory).toBe(false);
  });

  it("resumes only the claim memories that have no blob id", () => {
    const decision = planSeedPost({
      expectedClaimCount: 2,
      applied: false,
      claims: [
        { index: 0, walrusBlobId: "blob-0" },
        { index: 1, walrusBlobId: null },
      ],
      source: sourceStamped,
    });
    expect(decision.action).toBe("resume");
    expect(decision.writeSourceMemory).toBe(false);
    expect(decision.pendingClaimIndexes).toEqual([1]);
  });

  it("skips only when the applied marker is set, or when every memory is already persisted", () => {
    const partial = planSeedPost({
      expectedClaimCount: 1,
      applied: false,
      claims: [{ index: 0, walrusBlobId: null }],
      source: sourceMissing,
    });
    expect(partial.action).toBe("resume");
    expect(partial.writeSourceMemory).toBe(true);

    const persistedWithoutMarker = planSeedPost({
      expectedClaimCount: 1,
      applied: false,
      claims: [{ index: 0, walrusBlobId: "blob-0" }],
      source: sourceStamped,
    });
    expect(persistedWithoutMarker.action).toBe("skip");
    expect(persistedWithoutMarker.markApplied).toBe(true);
    expect(persistedWithoutMarker.writeSourceMemory).toBe(false);

    const marked = planSeedPost({
      expectedClaimCount: 1,
      applied: true,
      claims: [{ index: 0, walrusBlobId: null }],
      source: sourceMissing,
    });
    expect(marked.action).toBe("skip");
    expect(marked.writeSourceMemory).toBe(false);
    expect(marked.markApplied).toBe(false);
  });
});

describe("plannedClaimIdentity", () => {
  it("is stable and names the memory key the single-write path dedupes on", () => {
    const a = plannedClaimIdentity("placeholder-alpha-balance", 0);
    const b = plannedClaimIdentity("placeholder-alpha-balance", 0);
    expect(a).toEqual(b);
    expect(a.idempotencyKey).toBe(`claim:${a.claimId}`);
    expect(a.externalId).toBe("post:placeholder-alpha-balance:0");
  });
});

describe("materializeClaims", () => {
  it("keeps an explicit tx_replay, including the window", () => {
    const post = file.posts.find((p) => p.id === "placeholder-gamma-replay");
    expect(post).toBeDefined();
    const claims = materializeClaims(post!);
    expect(claims).toHaveLength(1);
    const claim = claims![0]!;
    expect(claim.claimType).toBe("tx_replay");
    expect(claim.params).toMatchObject({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-15T00:00:00.000Z",
      direction: "gte",
    });
  });

  it("returns null when the post should go through extraction", () => {
    const post = { ...file.posts[0]!, claims: undefined };
    expect(materializeClaims(post)).toBeNull();
  });
});

describe("chunk", () => {
  it("never hands the relayer more than 20 memories", () => {
    const batches = chunk(Array.from({ length: 45 }, (_, i) => i), SEED_BULK_MAX);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(batches.every((b) => b.length <= 20)).toBe(true);
    expect(() => chunk([1], 21)).toThrow(/20/);
  });
});

describe("formatSeedSummary", () => {
  it("prints namespace counts, blob ids, scores, and a separate synthetic total", () => {
    const text = formatSeedSummary({
      postsRead: 4,
      postsSeeded: 4,
      postsSkipped: 0,
      realPosts: 0,
      syntheticPosts: 4,
      realClaims: 0,
      syntheticClaims: 4,
      memoriesByNamespace: { "walkback.claim": 4, "walkback.source": 4 },
      blobIds: ["blob-aaa", "blob-bbb"],
      scores: [{ handle: "placeholder_alpha", score: 0, hits: 0, misses: 0 }],
      resolveErrors: [],
    });
    expect(text).toContain("walkback.claim  4");
    expect(text).toContain("blob-aaa");
    expect(text).toContain("placeholder_alpha  0.00");
    expect(text).toContain("synthetic  4 posts, 4 claims");
    expect(text).toContain("real       0 posts, 0 claims");
    expect(text).toContain("not a minority");
  });

  it("stays quiet about the mix when real posts are the majority", () => {
    const text = formatSeedSummary({
      postsRead: 3,
      postsSeeded: 3,
      postsSkipped: 0,
      realPosts: 2,
      syntheticPosts: 1,
      realClaims: 5,
      syntheticClaims: 1,
      memoriesByNamespace: {},
      blobIds: [],
      scores: [],
      resolveErrors: [],
    });
    expect(text).not.toContain("not a minority");
  });
});

describe("synthetic memory text", () => {
  it("says the claim is synthetic, in the prose and in the fenced JSON", () => {
    const post = file.posts[0]!;
    const claim = materializeClaims(post)![0]!;
    const identity = plannedClaimIdentity(post.id, 0);
    const mem = claimMemory(
      {
        id: identity.claimId,
        sourceHandle: post.handle,
        claimType: claim.claimType,
        params: claim.params,
        deadline: claim.deadline,
        confidence: claim.confidence,
      },
      claim,
      post.snapshot ?? null,
      { synthetic: true, externalId: identity.externalId },
    );
    expect(mem.text).toContain("SYNTHETIC");
    expect(mem.key).toBe(identity.idempotencyKey);
    const json = mem.text.match(/```json\s*([\s\S]*?)```/)?.[1];
    expect(json).toBeDefined();
    const payload = JSON.parse(json!) as { synthetic: boolean; external_id: string };
    expect(payload.synthetic).toBe(true);
    expect(payload.external_id).toBe(identity.externalId);
  });
});
