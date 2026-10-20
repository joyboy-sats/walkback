/**
 * Rebuild the projection from memory text, without a database or a relayer.
 *
 * The fixture is written with the same builders ingest and resolve use, then
 * shuffled, duplicated, and given a broken memory. The rows that come back
 * have to match the originals, and the scores have to match `computeScore`
 * on the verdicts — including a void that must not move anything.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { claimMemory, resolutionMemory, scoreMemory, sourceMemory, tombstoneMemory } from "./memory-text";
import {
  compareWithStored,
  decideTruncation,
  EXCLUDED_NAMESPACES,
  gatherMemories,
  projectMemories,
  rebuildAllowed,
  recallPlan,
  type GatheredMemory,
  type RecallQuery,
} from "./projection-rebuild";
import { applyOutcome, computeScore, type ScoreSnapshot } from "./score";
import { NS } from "./types";
import type { ClaimParams, ClaimType, Outcome } from "./types";

const WHEN = "2026-10-01T00:00:00.000Z";
const DEADLINE = "2026-11-01T00:00:00.000Z";
const SOURCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const params: ClaimParams = {
  address: "0xabc",
  asset: "0x2::sui::SUI",
  direction: "gte",
  amount: "1",
};

function claimUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function memory(namespace: string, built: { text: string }, blobId: string): GatheredMemory {
  return { blobId, text: built.text, namespace, createdAt: WHEN };
}

function shuffle<T>(items: readonly T[], seed = 42): T[] {
  const arr = [...items];
  let state = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

interface SourceFix {
  id: string;
  handle: string;
  platform: "x" | "onchain";
}

interface BuiltWorld {
  memories: GatheredMemory[];
  expected: Record<string, ScoreSnapshot>;
  voidClaimId: string;
  pendingClaimId: string;
  syntheticClaimId: string;
  claimCount: number;
  resolutionCount: number;
  scoreVersionCount: number;
}

function buildWorld(): BuiltWorld {
  const sources: Record<string, SourceFix> = {
    [SOURCE_A]: { id: SOURCE_A, handle: "alpha", platform: "x" },
    [SOURCE_B]: { id: SOURCE_B, handle: "beta", platform: "onchain" },
  };
  const memories: GatheredMemory[] = [
    memory(NS.source, sourceMemory(sources[SOURCE_A]!, { createdAt: WHEN }), "blob-source-alpha"),
    memory(NS.source, sourceMemory(sources[SOURCE_B]!, { createdAt: WHEN }), "blob-source-beta"),
  ];

  const steps: Array<{ sourceId: string; outcome: Outcome | "pending"; synthetic?: boolean }> = [
    ...Array.from({ length: 16 }, () => ({ sourceId: SOURCE_A, outcome: "true" as const })),
    ...Array.from({ length: 4 }, () => ({ sourceId: SOURCE_B, outcome: "false" as const })),
    ...Array.from({ length: 4 }, () => ({ sourceId: SOURCE_A, outcome: "false" as const })),
    { sourceId: SOURCE_A, outcome: "void" },
    ...Array.from({ length: 2 }, () => ({ sourceId: SOURCE_B, outcome: "true" as const })),
    ...Array.from({ length: 6 }, () => ({ sourceId: SOURCE_B, outcome: "false" as const })),
    { sourceId: SOURCE_B, outcome: "pending", synthetic: true },
  ];

  const running = new Map<string, { hits: number; misses: number; version: number; previous: number | null }>();
  let voidClaimId = "";
  let pendingClaimId = "";
  let syntheticClaimId = "";
  let n = 1;
  let resolutionCount = 0;
  let scoreVersionCount = 0;

  for (const step of steps) {
    const source = sources[step.sourceId]!;
    const st = running.get(source.id) ?? { hits: 0, misses: 0, version: 0, previous: null };
    const id = claimUuid(n++);
    const quote = `${source.handle} claim ${id.slice(-4)}`;
    const extracted = {
      quote,
      claimType: "balance_threshold" as ClaimType,
      params,
      deadline: DEADLINE,
      confidence: 0.9,
    };
    memories.push(
      memory(
        NS.claim,
        claimMemory(
          {
            id,
            sourceHandle: source.handle,
            claimType: "balance_threshold",
            params,
            deadline: DEADLINE,
            confidence: 0.9,
          },
          extracted,
          null,
          step.synthetic ? { synthetic: true, externalId: `post:demo:${id}` } : undefined,
        ),
        `blob-claim-${id}`,
      ),
    );

    if (step.synthetic) syntheticClaimId = id;
    if (step.outcome === "pending") {
      pendingClaimId = id;
      running.set(source.id, st);
      continue;
    }
    if (step.outcome === "void") voidClaimId = id;

    const before = computeScore(st.hits, st.misses);
    const after = applyOutcome(st.hits, st.misses, step.outcome);
    memories.push(
      memory(
        NS.resolution,
        resolutionMemory(
          {
            claimId: id,
            sourceHandle: source.handle,
            claimType: "balance_threshold",
            quote,
            outcome: step.outcome,
            reason: step.outcome === "void" ? "could not check" : "checked against mainnet",
            evidence: { outcome: step.outcome },
          },
          { before, after },
        ),
        `blob-resolution-${id}`,
      ),
    );
    resolutionCount++;

    if (after.adjudicated !== before.adjudicated) {
      st.version += 1;
      memories.push(
        memory(
          NS.score,
          scoreMemory(
            {
              sourceId: source.id,
              sourceHandle: source.handle,
              version: st.version,
              triggeredByClaimId: id,
              reason: `claim resolved ${step.outcome}`,
            },
            after,
            st.previous,
          ),
          `blob-score-${source.id}-${st.version}`,
        ),
      );
      scoreVersionCount++;
      st.previous = after.score;
    }
    st.hits = after.hits;
    st.misses = after.misses;
    running.set(source.id, st);
  }

  const expected: Record<string, ScoreSnapshot> = {};
  for (const [id, st] of running) expected[id] = computeScore(st.hits, st.misses);

  return {
    memories,
    expected,
    voidClaimId,
    pendingClaimId,
    syntheticClaimId,
    claimCount: steps.length,
    resolutionCount,
    scoreVersionCount,
  };
}

describe("projectMemories", () => {
  const world = buildWorld();
  const dirty = shuffle([
    ...world.memories,
    world.memories[0]!,
    { blobId: "blob-bad-json", text: "this memory has no fenced payload", namespace: NS.claim, createdAt: WHEN },
    { blobId: "blob-bad-parse", text: "```json\n{not json\n```", namespace: NS.score, createdAt: WHEN },
  ]);
  const projection = projectMemories(dirty);

  it("drops duplicate blob ids and skips a memory whose JSON does not parse", () => {
    expect(projection.duplicatesDropped).toBe(1);
    expect(projection.skipped.map((s) => s.blobId).sort()).toEqual(["blob-bad-json", "blob-bad-parse"]);
    const unique = new Set(dirty.map((m) => m.blobId));
    expect(projection.memoryLog).toHaveLength(unique.size);
  });

  it("rebuilds the same claims, and a void stays a void", () => {
    expect(projection.claims).toHaveLength(world.claimCount);
    expect(projection.resolutions).toHaveLength(world.resolutionCount);
    expect(projection.scoreVersions).toHaveLength(world.scoreVersionCount);

    const voided = projection.claims.find((c) => c.id === world.voidClaimId);
    expect(voided?.status).toBe("void");
    const voidResolution = projection.resolutions.find((r) => r.claimId === world.voidClaimId);
    expect(voidResolution?.outcome).toBe("void");

    const pending = projection.claims.find((c) => c.id === world.pendingClaimId);
    expect(pending?.status).toBe("pending");
    expect(pending?.synthetic).toBe(true);
    expect(pending?.externalId).toBe(`post:demo:${world.syntheticClaimId}`);
    expect(projection.resolutions.some((r) => r.claimId === world.pendingClaimId)).toBe(false);
  });

  it("recomputes scores from verdicts, and they match the originals", () => {
    const alpha = projection.sources.find((s) => s.handle === "alpha");
    const beta = projection.sources.find((s) => s.handle === "beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    const expectedA = world.expected[SOURCE_A]!;
    const expectedB = world.expected[SOURCE_B]!;
    expect(alpha).toMatchObject({
      id: SOURCE_A,
      hits: expectedA.hits,
      misses: expectedA.misses,
      score: expectedA.score,
      band: expectedA.band,
      muted: expectedA.band === "muted",
    });
    expect(beta).toMatchObject({
      id: SOURCE_B,
      hits: expectedB.hits,
      misses: expectedB.misses,
      score: expectedB.score,
      band: expectedB.band,
      muted: expectedB.band === "muted",
    });

    // The void on alpha is the difference between 21 stored claims and 20
    // adjudicated ones. It must not have been counted as a miss.
    expect(expectedA.hits).toBe(16);
    expect(expectedA.misses).toBe(4);
    expect(expectedA.band).toBe("trusted");
    expect(expectedB.hits).toBe(2);
    expect(expectedB.misses).toBe(10);
    expect(expectedB.band).toBe("muted");
    expect(alpha!.score).toBeGreaterThan(beta!.score);
    expect(projection.notes).toEqual([]);

    const latestAlpha = projection.scoreVersions.filter((v) => v.sourceId === SOURCE_A).at(-1);
    expect(latestAlpha?.score).toBe(expectedA.score);
    expect(latestAlpha?.hits).toBe(expectedA.hits);
    expect(latestAlpha?.misses).toBe(expectedA.misses);
  });

  it("does not depend on recall order", () => {
    const again = projectMemories(shuffle(dirty, 99));
    expect(again.sources.map((s) => [s.handle, s.score, s.hits, s.misses])).toEqual(
      projection.sources.map((s) => [s.handle, s.score, s.hits, s.misses]),
    );
    expect(again.claims.map((c) => [c.id, c.status, c.synthetic])).toEqual(
      projection.claims.map((c) => [c.id, c.status, c.synthetic]),
    );
  });
});

describe("tombstones", () => {
  it("hides a tombstoned claim and does not let its verdict move the score", () => {
    const source = { id: SOURCE_A, handle: "alpha", platform: "x" as const };
    const claimId = claimUuid(1);
    const quote = "gone";
    const before = computeScore(0, 0);
    const after = applyOutcome(0, 0, "true");
    const memories: GatheredMemory[] = [
      memory(NS.source, sourceMemory(source, { createdAt: WHEN }), "blob-s"),
      memory(
        NS.claim,
        claimMemory(
          { id: claimId, sourceHandle: "alpha", claimType: "balance_threshold", params, deadline: DEADLINE, confidence: 0.9 },
          { quote, claimType: "balance_threshold", params, deadline: DEADLINE, confidence: 0.9 },
          null,
        ),
        "blob-c",
      ),
      memory(
        NS.resolution,
        resolutionMemory(
          {
            claimId,
            sourceHandle: "alpha",
            claimType: "balance_threshold",
            quote,
            outcome: "true",
            reason: "checked",
            evidence: {},
          },
          { before, after },
        ),
        "blob-r",
      ),
      memory(
        NS.tombstone,
        tombstoneMemory({ refId: claimId, kind: "claim", reason: "removed" }),
        "blob-t",
      ),
    ];

    const projection = projectMemories(memories);
    expect(projection.claims).toHaveLength(0);
    expect(projection.resolutions).toHaveLength(0);
    expect(projection.sources[0]).toMatchObject({ hits: 0, misses: 0, score: 0 });
    expect(projection.memoryLog.some((m) => m.blobId === "blob-c")).toBe(true);
  });
});

describe("gatherMemories", () => {
  it("dedupes the same blob returned by different queries, in any order", async () => {
    const plan = recallPlan().filter((q) => q.namespace === NS.claim).slice(0, 3);
    const hits = [
      { blobId: "b2", text: "second", createdAt: WHEN },
      { blobId: "b1", text: "first", createdAt: WHEN },
    ];
    const recall = vi.fn(async (_q: RecallQuery) => hits);
    const gathered = await gatherMemories(recall, plan);

    expect(recall).toHaveBeenCalledTimes(plan.length);
    expect(gathered.rawHits).toBe(plan.length * hits.length);
    expect(gathered.memories.map((m) => m.blobId)).toEqual(["b1", "b2"]);
    expect(gathered.duplicatesDropped).toBe(gathered.rawHits - 2);
    expect(gathered.memories.every((m) => m.namespace === NS.claim)).toBe(true);
  });

  it("asks every namespace more than once, with both sort modes and a large limit", () => {
    const plan = recallPlan();
    for (const namespace of Object.values(NS)) {
      const mine = plan.filter((q) => q.namespace === namespace);
      expect(mine.length).toBeGreaterThanOrEqual(3);
      expect(new Set(mine.map((q) => q.query)).size).toBeGreaterThanOrEqual(2);
      expect(mine.some((q) => q.sort === "recent")).toBe(true);
      expect(mine.some((q) => q.sort === "relevance")).toBe(true);
      expect(mine.every((q) => q.limit >= 200)).toBe(true);
    }
  });
});

describe("decideTruncation", () => {
  it("refuses to wipe the projection when recall came back short, empty, or unverified", () => {
    expect(
      decideTruncation({
        unique: 2,
        recalledByNamespace: { [NS.claim]: 2 },
        reportedByNamespace: { [NS.claim]: 5 },
      }).truncate,
    ).toBe(false);

    expect(
      decideTruncation({
        unique: 0,
        recalledByNamespace: {},
        reportedByNamespace: {},
      }).truncate,
    ).toBe(false);

    expect(
      decideTruncation({
        unique: 3,
        recalledByNamespace: { [NS.claim]: 3 },
        reportedByNamespace: null,
      }).truncate,
    ).toBe(false);
  });

  it("truncates only when every namespace was covered and something came back", () => {
    const recalledByNamespace = Object.fromEntries(Object.values(NS).map((ns) => [ns, 1]));
    const decision = decideTruncation({
      unique: Object.values(NS).length,
      recalledByNamespace,
      reportedByNamespace: { ...recalledByNamespace, "walkback.smoke": 99 },
    });
    expect(decision.truncate).toBe(true);
    expect(decision.gaps).toEqual([]);
    expect(decision.excludedNamespaces).toContain("walkback.smoke");
    expect(decision.gaps.some((g) => g.namespace === "walkback.smoke")).toBe(false);
  });

  it("does not treat smoke or timing counts as missing product memories", () => {
    for (const name of EXCLUDED_NAMESPACES) {
      expect(Object.values(NS)).not.toContain(name);
    }
    const recalledByNamespace = Object.fromEntries(Object.values(NS).map((ns) => [ns, 2]));
    const reported: Record<string, number> = {
      ...recalledByNamespace,
      "walkback.smoke": 40,
      "walkback.timing": 12,
    };
    reported[NS.claim] = 9;
    const decision = decideTruncation({
      unique: 20,
      recalledByNamespace,
      reportedByNamespace: reported,
    });
    expect(decision.truncate).toBe(false);
    expect(decision.gaps.map((g) => g.namespace)).toEqual([NS.claim]);
    expect(decision.excludedNamespaces).toEqual(["walkback.smoke", "walkback.timing"]);
  });
});

describe("verify comparison", () => {
  it("reports matches, a mismatched quote, rows recall missed, and recomputed scores", () => {
    const world = buildWorld();
    const recalled = projectMemories(world.memories);
    const sources = recalled.sources.map((s) => ({
      id: s.id,
      handle: s.handle,
      score: s.score,
      hits: s.hits,
      misses: s.misses,
      walrusBlobId: s.walrusBlobId,
    }));
    const claims = recalled.claims.map((c) => ({
      id: c.id,
      quote: c.quote,
      status: c.status,
      synthetic: c.synthetic,
      walrusBlobId: c.walrusBlobId,
    }));
    const resolutions = recalled.resolutions.map((r) => ({
      claimId: r.claimId,
      outcome: r.outcome,
    }));

    const intact = compareWithStored({ recalled, sources, claims, resolutions });
    expect(intact.mismatched).toBe(0);
    expect(intact.missingFromRecall).toBe(0);
    expect(intact.scores.every((s) => s.agree)).toBe(true);
    expect(intact.scores.map((s) => s.recomputedScore)).toEqual(sources.map((s) => s.score));
    expect(intact.notes.join(" ")).toContain("does not mean Walrus lacks it");

    const hidden = claims[0]!;
    const missed = compareWithStored({
      recalled: { ...recalled, claims: recalled.claims.filter((c) => c.id !== hidden.id) },
      sources,
      claims,
      resolutions,
    });
    expect(missed.missingFromRecall).toBeGreaterThan(0);
    expect(missed.missing).toContainEqual({ kind: "claim", id: hidden.id });

    const tweaked = claims.map((c) => (c.id === hidden.id ? { ...c, quote: "a different quote" } : c));
    const mismatch = compareWithStored({ recalled, sources, claims: tweaked, resolutions });
    expect(mismatch.mismatched).toBe(1);
    expect(mismatch.mismatches[0]?.detail).toContain("quote");

    const drifted = sources.map((s) => ({ ...s, score: s.score + 0.25 }));
    const scores = compareWithStored({ recalled, sources: drifted, claims, resolutions });
    expect(scores.scores.every((s) => s.agree)).toBe(false);
    expect(scores.scores.every((s) => s.recomputedScore !== null)).toBe(true);
  });
});

describe("rebuildAllowed", () => {
  it("replaces the projection only after complete coverage and an explicit confirm", () => {
    expect(rebuildAllowed({ mode: "verify", confirm: true, coverageComplete: true }).truncate).toBe(false);
    expect(rebuildAllowed({ mode: "rebuild", confirm: true, coverageComplete: false }).truncate).toBe(false);
    expect(rebuildAllowed({ mode: "rebuild", confirm: false, coverageComplete: true }).truncate).toBe(false);
    expect(rebuildAllowed({ mode: "rebuild", confirm: true, coverageComplete: true }).truncate).toBe(true);
    expect(
      rebuildAllowed({
        mode: "rebuild",
        confirm: true,
        coverageComplete: true,
        enumeration: "recall-fallback",
      }).truncate,
    ).toBe(false);
  });
});
