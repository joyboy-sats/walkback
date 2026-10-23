import { describe, expect, it } from "vitest";
import { resolutionMemory } from "./memory-text";
import { computeScore } from "./score";

const claimId = "b3cfb240-691d-826f-72e1-1695f7e46335";

const verdict = {
  claimId,
  sourceHandle: "mrcamerontrader",
  claimType: "price_threshold" as const,
  quote: "SUI above 1.29",
  outcome: "false" as const,
  reason: "window high 1.07 never reached 1.29",
  evidence: { windowHigh: "1.07", strictWindow: true },
};

describe("resolutionMemory", () => {
  it("is the same bytes for the same verdict, whatever the clock or the live score", () => {
    const early = resolutionMemory(verdict, { before: computeScore(2, 0), after: computeScore(2, 1) }, {
      resolvedAt: "2026-10-23T12:00:00.000Z",
    });
    const later = resolutionMemory(verdict, { before: computeScore(11, 0), after: computeScore(11, 1) }, {
      resolvedAt: "2026-10-24T20:00:00.000Z",
    });
    expect(later).toEqual(early);
    expect(early.key).toBe(`resolution:${claimId}`);
    expect(early.text).not.toContain("2026-10-23");
    expect(early.text).not.toContain("score_before");
    expect(early.text).not.toContain("score_after");
    expect(early.text).toContain("VERDICT: FALSE");
    expect(early.text).toContain(verdict.reason);
  });
});
