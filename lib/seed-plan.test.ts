import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimMemory } from "./memory-text";
import {
  chunk,
  formatSeedSummary,
  isSynthetic,
  materializeClaims,
  parseClaimsFile,
  plannedClaimIdentity,
  postsToApply,
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

describe("postsToApply", () => {
  it("skips a post whose external ids are already stored, so a second run adds nothing", () => {
    const first = postsToApply(file.posts, []);
    expect(first.apply.map((p) => p.id)).toEqual(file.posts.map((p) => p.id));
    expect(first.skip).toHaveLength(0);

    const existing = file.posts.flatMap((post) =>
      (post.claims ?? [{ quote: "" }]).map((_, index) => plannedClaimIdentity(post.id, index).externalId),
    );
    const second = postsToApply(file.posts, existing);
    expect(second.apply).toHaveLength(0);
    expect(second.skip.map((p) => p.id)).toEqual(file.posts.map((p) => p.id));
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
