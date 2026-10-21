import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLE,
  TRUST_MUTED,
  TRUST_TRUSTED,
  applyOutcome,
  computeScore,
  hitRate,
  replaceOutcome,
  trustBand,
  wilsonLowerBound,
} from "./score";

describe("wilsonLowerBound", () => {
  it("returns 0 with no observations", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("punishes a single lucky hit", () => {
    // The product thesis: one correct guess must not earn trust.
    const one = wilsonLowerBound(1, 1);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(0.25);
    expect(one).toBeLessThan(TRUST_MUTED);
  });

  it("rises with a consistent record", () => {
    const a = wilsonLowerBound(1, 1);
    const b = wilsonLowerBound(8, 10);
    const c = wilsonLowerBound(16, 20);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("is not the raw ratio", () => {
    // 8/10 has a raw ratio of 0.8 but a lower bound near 0.49.
    const bound = wilsonLowerBound(8, 10);
    expect(bound).toBeLessThan(0.6);
    expect(bound).toBeGreaterThan(0.4);
  });

  it("never leaves [0,1]", () => {
    for (let n = 0; n <= 40; n++) {
      for (let h = 0; h <= n; h++) {
        const v = wilsonLowerBound(h, n);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is monotonic in hits for a fixed n", () => {
    for (const n of [3, 10, 25]) {
      let prev = -1;
      for (let h = 0; h <= n; h++) {
        const v = wilsonLowerBound(h, n);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonLowerBound(5, 3)).toThrow();
    expect(() => wilsonLowerBound(-1, 3)).toThrow();
  });
});

describe("hitRate", () => {
  it("is the plain ratio, kept next to the bound for sample-size honesty", () => {
    expect(hitRate(8, 10)).toBeCloseTo(0.8);
    expect(hitRate(0, 0)).toBe(0);
  });
});

describe("trustBand", () => {
  it("withholds a badge below the minimum sample", () => {
    expect(trustBand(0.9, MIN_SAMPLE - 1)).toBe("unknown");
  });

  it("mutes a source that has been wrong often", () => {
    expect(trustBand(0.1, 10)).toBe("muted");
  });

  it("promotes a source with a strong record", () => {
    expect(trustBand(0.7, 20)).toBe("trusted");
  });

  it("leaves middling sources normal", () => {
    expect(trustBand(0.45, 10)).toBe("normal");
  });

  it("keeps band boundaries consistent with the exported thresholds", () => {
    expect(trustBand(TRUST_MUTED - 0.01, 10)).toBe("muted");
    expect(trustBand(TRUST_TRUSTED, 10)).toBe("trusted");
  });
});

describe("computeScore", () => {
  it("ignores voids by construction — it only sees hits and misses", () => {
    const s = computeScore(4, 4);
    expect(s.adjudicated).toBe(8);
    expect(s.hits).toBe(4);
    expect(s.misses).toBe(4);
  });

  it("reports an unknown band for a tiny sample even with a perfect record", () => {
    const s = computeScore(2, 0);
    expect(s.band).toBe("unknown");
    expect(s.hitRate).toBe(1);
  });
});

describe("applyOutcome", () => {
  it("leaves the score untouched on a void", () => {
    const before = computeScore(4, 1);
    expect(applyOutcome(before.hits, before.misses, "void")).toEqual(before);
  });

  it("counts a hit and a miss, and nothing else", () => {
    expect(applyOutcome(4, 1, "true")).toEqual(computeScore(5, 1));
    expect(applyOutcome(4, 1, "false")).toEqual(computeScore(4, 2));
  });
});

describe("replaceOutcome", () => {
  it("turns a void into one hit and does not count the void", () => {
    expect(replaceOutcome(9, 0, "void", "true")).toEqual(computeScore(10, 0));
  });

  it("leaves the score in place when a true claim is checked again", () => {
    expect(replaceOutcome(9, 0, "true", "true")).toEqual(computeScore(9, 0));
  });

  it("swaps a hit for a miss when the latest verdict is false", () => {
    expect(replaceOutcome(9, 0, "true", "false")).toEqual(computeScore(8, 1));
  });

  it("treats a first resolution the same as applyOutcome", () => {
    expect(replaceOutcome(0, 0, null, "true")).toEqual(applyOutcome(0, 0, "true"));
    expect(replaceOutcome(0, 0, null, "void")).toEqual(applyOutcome(0, 0, "void"));
  });
});
