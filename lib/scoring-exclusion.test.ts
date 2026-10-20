import { describe, expect, it } from "vitest";
import { applyOutcome, computeScore } from "./score";
import { exclusionVerdict, isPlaceholderAddress } from "./scoring-exclusion";

const PLACEHOLDER = `0x${"1".repeat(64)}`;
const REAL = "0x" + "ab".repeat(32);

describe("placeholder addresses", () => {
  it("recognises a repeated-nibble address and accepts a mixed one", () => {
    expect(isPlaceholderAddress(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderAddress(`0x${"2".repeat(64)}`)).toBe(true);
    expect(isPlaceholderAddress(`0x${"a".repeat(8)}`)).toBe(true);
    expect(isPlaceholderAddress(REAL)).toBe(false);
    expect(isPlaceholderAddress("0xabc")).toBe(false);
    expect(isPlaceholderAddress("not an address")).toBe(false);
  });
});

describe("exclusion from the trust score", () => {
  const before = computeScore(4, 1);

  it("keeps a synthetic claim from moving hits or misses", () => {
    const verdict = exclusionVerdict({
      synthetic: true,
      params: { address: PLACEHOLDER },
    });
    expect(verdict?.outcome).toBe("void");
    expect(verdict?.reason.toLowerCase()).toContain("synthetic");
    expect(verdict?.reason.toLowerCase()).toContain("excluded");
    const after = applyOutcome(before.hits, before.misses, verdict!.outcome);
    expect(after).toEqual(before);
  });

  it("keeps a placeholder address from becoming a miss", () => {
    const verdict = exclusionVerdict({
      synthetic: false,
      params: { address: PLACEHOLDER, direction: "gte", amount: "1" },
    });
    expect(verdict?.outcome).toBe("void");
    expect(verdict?.reason.toLowerCase()).toContain("placeholder");
    const after = applyOutcome(before.hits, before.misses, verdict!.outcome);
    expect(after.hits).toBe(before.hits);
    expect(after.misses).toBe(before.misses);
    expect(after.score).toBe(before.score);
  });

  it("leaves a real claim eligible to be checked", () => {
    expect(exclusionVerdict({ synthetic: false, params: { address: REAL } })).toBeNull();
  });
});
