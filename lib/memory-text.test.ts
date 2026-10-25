import { describe, expect, it } from "vitest";
import { foldVerdicts } from "./category-score";
import { resolutionMemory, scoreMemory } from "./memory-text";
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

describe("scoreMemory", () => {
  const meta = {
    sourceId: "11111111-1111-4111-8111-111111111111",
    sourceHandle: "mrcamerontrader",
    version: 3,
    triggeredByClaimId: claimId,
    reason: "claim resolved false",
  };

  it("keeps the original bytes when no category record is attached", () => {
    const text = scoreMemory(meta, computeScore(2, 1), 0.34).text;
    expect(text).not.toContain("schema_version");
    expect(text).not.toContain("mute_basis");
    expect(text).toContain("\"hits\": 2");
    expect(text).toContain("\"misses\": 1");
    expect(text).toContain(
      "This source is below the mute threshold and its claims no longer appear in the feed.",
    );
  });

  it("versions a new score memory without changing the overall hits the replay checks", () => {
    const folded = foldVerdicts([
      { claimType: "tx_replay", outcome: "true" },
      { claimType: "tx_replay", outcome: "true" },
      { claimType: "price_threshold", outcome: "false" },
    ]);
    const built = scoreMemory(meta, computeScore(2, 1), 0.34, {
      reporting: folded.reporting,
      forecast: folded.forecast,
      muteBasis: folded.muteBasis,
    });
    expect(built.key).toBe(`score:${meta.sourceId}:v3`);
    expect(built.text).toContain("\"schema_version\": 2");
    expect(built.text).toContain("\"mute_basis\": \"forecast\"");
    expect(built.text).toContain("\"hits\": 2");
    expect(built.text).toContain("\"misses\": 1");
    expect(built.text).toContain("The feed follows the forecast record.");
  });
});
