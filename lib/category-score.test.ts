import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldCategories, foldVerdicts, scoreCategory, tallyCategories } from "./category-score";
import { conditionWouldChange, scanConditionalClaims } from "./condition";
import { wilsonLowerBound } from "./score";

describe("score categories", () => {
  it("puts replays and balances in reporting, and price calls in forecast", () => {
    expect(scoreCategory("tx_replay")).toBe("reporting");
    expect(scoreCategory("balance_threshold")).toBe("reporting");
    expect(scoreCategory("balance_change_since_ingest")).toBe("reporting");
    expect(scoreCategory("price_threshold")).toBe("forecast");
    expect(scoreCategory("manual")).toBeNull();
  });

  it("keeps a perfect reporter trusted when they have no forecasts", () => {
    const folded = foldVerdicts(
      Array.from({ length: 11 }, () => ({ claimType: "tx_replay", outcome: "true" as const })),
    );
    expect(folded.muteBasis).toBe("reporting");
    expect(folded.reporting).toMatchObject({ hits: 11, misses: 0, n: 11, band: "trusted" });
    expect(folded.reporting.score).toBeCloseTo(wilsonLowerBound(11, 11), 10);
    expect(folded.forecast.n).toBe(0);
    expect(folded.forecast.band).toBe("unknown");
    expect(folded.muted).toBe(false);
    expect(folded.basis).toEqual(folded.reporting);
  });

  it("mutes on the forecast record once a source has forecasts, and ignores a reporting streak", () => {
    const rows = [
      ...Array.from({ length: 11 }, () => ({ claimType: "tx_replay", outcome: "true" as const })),
      ...Array.from({ length: 3 }, () => ({ claimType: "price_threshold", outcome: "false" as const })),
    ];
    const folded = foldVerdicts(rows);
    expect(folded.overall.band).toBe("normal");
    expect(folded.muteBasis).toBe("forecast");
    expect(folded.forecast.band).toBe("muted");
    expect(folded.muted).toBe(true);
    expect(folded.basis.score).toBeCloseTo(wilsonLowerBound(0, 3), 10);
  });

  it("does not mute a good forecaster for a reporting miss", () => {
    const folded = foldCategories(
      { reportingHits: 0, reportingMisses: 3, forecastHits: 8, forecastMisses: 0 },
      8,
      3,
    );
    expect(folded.reporting.band).toBe("muted");
    expect(folded.forecast.band).toBe("trusted");
    expect(folded.muteBasis).toBe("forecast");
    expect(folded.muted).toBe(false);
  });

  it("leaves a short forecast record unrated instead of muted", () => {
    const folded = foldVerdicts([
      { claimType: "tx_replay", outcome: "true" },
      { claimType: "tx_replay", outcome: "true" },
      { claimType: "tx_replay", outcome: "true" },
      { claimType: "price_threshold", outcome: "false" },
      { claimType: "price_threshold", outcome: "false" },
    ]);
    expect(folded.muteBasis).toBe("forecast");
    expect(folded.forecast.n).toBe(2);
    expect(folded.forecast.band).toBe("unknown");
    expect(folded.muted).toBe(false);
  });

  it("voids and manual verdicts do not move a category", () => {
    const folded = foldVerdicts([
      { claimType: "price_threshold", outcome: "void" },
      { claimType: "manual", outcome: "false" },
      { claimType: "tx_replay", outcome: "true" },
    ]);
    expect(folded.forecast.n).toBe(0);
    expect(folded.reporting).toMatchObject({ hits: 1, misses: 0, n: 1 });
    expect(folded.overall).toMatchObject({ hits: 1, misses: 1, n: 2 });
    expect(folded.muteBasis).toBe("reporting");
  });

  it("rejects a placeholder row and keeps the latest verdict per claim", () => {
    expect(tallyCategories([{ id: "x" }])).toBeNull();
    const counts = tallyCategories([
      { claimId: "c1", claimType: "price_threshold", outcome: "true", resolvedAt: "2026-10-01T00:00:00.000Z" },
      { claimId: "c1", claimType: "price_threshold", outcome: "false", resolvedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    expect(counts).toEqual({ reportingHits: 0, reportingMisses: 0, forecastHits: 0, forecastMisses: 1 });
  });

  it("folds a verdict that is not in the table yet", () => {
    const counts = tallyCategories([], {
      claimId: "c1",
      claimType: "price_threshold",
      outcome: "false",
    });
    expect(counts).toEqual({ reportingHits: 0, reportingMisses: 0, forecastHits: 0, forecastMisses: 1 });
  });
});

describe("conditional claims in the seed file", () => {
  const file = JSON.parse(readFileSync("data/claims.json", "utf8")) as { posts: Parameters<typeof scanConditionalClaims>[0] };
  const posts = file.posts;
  const flagged = scanConditionalClaims(posts);

  it("flags the hedged targets and does not treat the stored amount as the precondition", () => {
    expect(flagged.map((row) => `${row.handle}:${row.amount}:${row.wouldChange}`)).toEqual([
      "cryptowithgopal:1.28:false",
      "cryptowithgopal:1.05:false",
      "cryptowithgopal:0.72:false",
      "cryptowithgopal:1.0:false",
    ]);
    expect(flagged.every((row) => row.wouldChange === false)).toBe(true);
    expect(flagged[0]?.condition).toContain("could trigger");
    expect(flagged[0]?.condition).toContain("1.08");
  });

  it("would change only a row whose stored amount is the precondition", () => {
    const quote =
      "A breakout above $1.08–$1.10 could trigger a bullish reversal, with the chart pointing toward a potential $1.28 target";
    expect(conditionWouldChange(quote, "1.28")).toBe(false);
    expect(conditionWouldChange(quote, "1.08")).toBe(true);
    expect(conditionWouldChange("SUI to $2 by July", "2")).toBe(false);
  });
});
