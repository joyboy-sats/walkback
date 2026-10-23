import { describe, expect, it } from "vitest";
import { claimMemory, resolutionMemory, scoreMemory, sourceMemory } from "./memory-text";
import { computeScore } from "./score";
import { formatMemoryIndexLine, indexMemoryText, wantsMemoryIndex } from "./memory-index";

const claimId = "b3cfb240-691d-826f-72e1-1695f7e46335";
const sourceId = "11111111-1111-4111-8111-111111111111";

describe("memory index", () => {
  it("derives kind, id, and idempotency key from product memories", () => {
    const claim = claimMemory(
      {
        id: claimId,
        sourceHandle: "mrcamerontrader",
        claimType: "price_threshold",
        params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "1.29", evaluation: "touch" },
        deadline: "2026-10-12T11:58:25.000Z",
        confidence: 0.85,
      },
      {
        quote: "SUI above 1.29",
        claimType: "price_threshold",
        params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "1.29", evaluation: "touch" },
        deadline: "2026-10-12T11:58:25.000Z",
        confidence: 0.85,
      },
      null,
    );
    const resolution = resolutionMemory(
      {
        claimId,
        sourceHandle: "mrcamerontrader",
        claimType: "price_threshold",
        quote: "SUI above 1.29",
        outcome: "false",
        reason: "daily high missed 1.29",
        evidence: { windowHigh: "1.2545" },
      },
      { before: computeScore(2, 0), after: computeScore(2, 1) },
    );
    const score = scoreMemory(
      {
        sourceId,
        sourceHandle: "mrcamerontrader",
        version: 27,
        triggeredByClaimId: claimId,
        reason: "claim resolved false",
      },
      computeScore(2, 1),
      0.34,
    );
    const source = sourceMemory(
      { id: sourceId, handle: "mrcamerontrader", platform: "x" },
      { createdAt: "2026-10-01T00:00:00.000Z" },
    );

    expect(formatMemoryIndexLine(indexMemoryText("walkback.claim", claim.text))).toBe(
      `claim ${claimId} claim:${claimId}`,
    );
    expect(formatMemoryIndexLine(indexMemoryText("walkback.resolution", resolution.text))).toBe(
      `resolution ${claimId} resolution:${claimId}`,
    );
    expect(formatMemoryIndexLine(indexMemoryText("walkback.score", score.text))).toBe(
      `score ${sourceId} score:${sourceId}:v27`,
    );
    expect(formatMemoryIndexLine(indexMemoryText("walkback.source", source.text))).toBe(
      `source ${sourceId} source:${sourceId}`,
    );
  });

  it("uses the revision suffix only after revision 1", () => {
    const text =
      "```json\n" +
      JSON.stringify({ kind: "resolution", claim_id: claimId, revision: 2, outcome: "false", reason: "x" }) +
      "\n```";
    expect(indexMemoryText("walkback.resolution", text).idempotencyKey).toBe(`resolution:${claimId}:r2`);
  });

  it("prints a dash key when the body cannot be read, and never the text", () => {
    const index = indexMemoryText("walkback.smoke", "delegate key material");
    const line = formatMemoryIndexLine(index);
    expect(line).toBe("smoke - -");
    expect(line).not.toContain("delegate");
    expect(indexMemoryText("walkback.resolution", undefined)).toEqual({
      kind: "resolution",
      refId: "-",
      idempotencyKey: "-",
    });
  });

  it("accepts --keys and --verbose", () => {
    expect(wantsMemoryIndex(["node", "list-memories.ts"])).toBe(false);
    expect(wantsMemoryIndex(["node", "list-memories.ts", "--keys"])).toBe(true);
    expect(wantsMemoryIndex(["node", "list-memories.ts", "--verbose"])).toBe(true);
  });
});
