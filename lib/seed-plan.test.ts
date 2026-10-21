import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimMemory } from "./memory-text";
import { exclusionVerdict } from "./scoring-exclusion";
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
const AS_OF = "2026-10-21T00:00:00.000Z";

describe("data/claims.json", () => {
  const claims = file.posts.flatMap((post) =>
    (post.claims ?? []).map((claim) => ({ post, claim })),
  );

  it("is the real set: 17 posts, 17 claims, no synthetic rows", () => {
    expect(file.posts).toHaveLength(17);
    expect(claims).toHaveLength(17);
    expect(file.posts.filter(isSynthetic)).toHaveLength(0);
    expect(claims.filter(({ claim }) => claim.claim_type === "tx_replay")).toHaveLength(11);
    expect(claims.filter(({ claim }) => claim.claim_type === "price_threshold")).toHaveLength(6);
    expect(claims.filter(({ claim }) => claim.claim_type === "balance_threshold")).toHaveLength(0);
    expect(new Set(file.posts.map((p) => p.handle)).size).toBe(7);
    expect(file.posts.some((p) => p.handle.toLowerCase().includes("mysqlsui"))).toBe(false);
    for (const post of file.posts) {
      expect(post.source_url?.startsWith("https://x.com/")).toBe(true);
      expect(post.text.toLowerCase()).not.toContain("placeholder");
    }
  });

  it("passes the seed checks and would not be voided as a placeholder", () => {
    const dueReplay: string[] = [];
    const pendingPrice: string[] = [];
    for (const { post, claim } of claims) {
      expect(post.text.includes(claim.quote)).toBe(true);
      expect(claim.quote.length).toBeLessThanOrEqual(200);
      expect(claim.confidence).toBeGreaterThanOrEqual(0.6);
      const materialized = materializeClaims(post);
      expect(materialized?.length).toBe(1);
      const stored = materialized![0]!;
      expect(exclusionVerdict({ synthetic: false, params: stored.params })).toBeNull();
      if (claim.claim_type === "tx_replay") {
        const since = String(claim.params.since);
        const until = String(claim.params.until);
        expect(Date.parse(since)).toBeLessThan(Date.parse(until));
        expect(Date.parse(claim.deadline)).toBeGreaterThanOrEqual(Date.parse(until));
        expect(post.snapshot).toBeNull();
        expect(post.sui_address).toBe(claim.params.address);
        if (claim.deadline <= AS_OF) dueReplay.push(post.id);
      }
      if (claim.claim_type === "price_threshold") {
        expect(String(claim.params.symbol).toUpperCase()).toBe("SUI");
        expect(String(claim.params.quote ?? "USD").toUpperCase()).toBe("USD");
        expect(claim.deadline > AS_OF).toBe(true);
        expect(post.sui_address).toBeUndefined();
        pendingPrice.push(post.id);
      }
    }
    expect(dueReplay).toHaveLength(11);
    expect(pendingPrice).toHaveLength(6);
    expect(pendingPrice.every((id) => claims.find((c) => c.post.id === id)!.claim.deadline >= "2026-10-30")).toBe(
      true,
    );
  });

  it("omits the replay whose quote names a different address than the one stored", () => {
    expect(file.posts.some((p) => p.id === "x-onchainwatch-2110064092434104572")).toBe(false);
    expect(file.posts.some((p) => p.text.includes("0x1ae70480"))).toBe(false);
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
    const post = file.posts.find((p) => p.id === "x-onchainwatch-2112521583134667061");
    expect(post).toBeDefined();
    const claims = materializeClaims(post!);
    expect(claims).toHaveLength(1);
    const claim = claims![0]!;
    expect(claim.claimType).toBe("tx_replay");
    expect(claim.params).toMatchObject({
      address: "0xbaae485e643532b4597f5ef9018103191452cc5c49ad7a3f5c59d9272c75ba69",
      since: "2026-10-20T10:51:00.000Z",
      until: "2026-10-20T12:31:00.000Z",
      direction: "gte",
      amount: "2075237000000000",
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

  it("records the original post url in the fenced JSON", () => {
    const post = file.posts[0]!;
    const claim = materializeClaims(post)![0]!;
    const mem = claimMemory(
      {
        id: "00000000-0000-4000-8000-000000000001",
        sourceHandle: post.handle,
        claimType: claim.claimType,
        params: claim.params,
        deadline: claim.deadline,
        confidence: claim.confidence,
      },
      claim,
      null,
      { sourceUrl: post.source_url },
    );
    expect(mem.text).toContain(post.source_url!);
    const json = mem.text.match(/```json\s*([\s\S]*?)```/)?.[1];
    const payload = JSON.parse(json!) as { source_url: string; synthetic: boolean };
    expect(payload.source_url).toBe(post.source_url);
    expect(payload.synthetic).toBe(false);
  });
});
