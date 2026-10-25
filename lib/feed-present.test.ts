import { describe, expect, it } from "vitest";
import type { ClaimDetail } from "./claim-view";
import { displayDecimal, groupFeed, heroClaim, heroSource, pricePath, shownActual, timeFraction } from "./feed-present";
import type { LedgerSource } from "./ledger";

function source(partial: Partial<LedgerSource> & Pick<LedgerSource, "id" | "handle">): LedgerSource {
  return {
    score: 0,
    hits: 0,
    misses: 0,
    band: "unknown",
    muted: false,
    muteBasis: "forecast",
    overall: null,
    reporting: null,
    forecast: null,
    claimTypes: [],
    ...partial,
  };
}

function detail(partial: Partial<ClaimDetail> = {}): ClaimDetail {
  return {
    id: "c",
    quote: "q",
    claimType: "price_threshold",
    status: "resolved",
    publishedAt: null,
    windowStart: null,
    deadline: null,
    parsed: {
      symbol: "SUI",
      quote: "USD",
      direction: "gte",
      target: "1.29",
      window: null,
      evaluation: "touch",
      priceBasis: "high",
      deadlineBasis: null,
      address: null,
      asset: null,
      conditionIgnored: null,
    },
    expected: "1.29",
    actual: null,
    transactions: [],
    walrus: { blobId: null, claimBlobId: null, resolutionBlobId: null, url: null },
    tatum: null,
    outcome: "false",
    reason: null,
    ...partial,
  };
}

describe("hero example", () => {
  const sources = [
    source({
      id: "a",
      handle: "Sophia_WebX",
      muted: true,
      forecast: { hits: 0, misses: 4, n: 4, score: 0, band: "muted" },
    }),
    source({
      id: "b",
      handle: "Community_Sui",
      muted: true,
      forecast: { hits: 0, misses: 4, n: 4, score: 0, band: "muted" },
    }),
    source({
      id: "c",
      handle: "mrcamerontrader",
      muted: true,
      forecast: { hits: 2, misses: 1, n: 3, score: 0.2, band: "muted" },
    }),
    source({
      id: "d",
      handle: "_OnChainWatch",
      muted: false,
      muteBasis: "reporting",
      forecast: { hits: 0, misses: 0, n: 0, score: 0, band: "unknown" },
    }),
  ];

  it("picks the muted source with the most false forecasts, breaking ties by handle", () => {
    expect(heroSource(sources)?.handle).toBe("Community_Sui");
  });

  it("picks the false price claim with the most stored candles", () => {
    const thin = detail();
    const thick = detail({
      id: "thick",
      actual: {
        extreme: null,
        windowHigh: null,
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [
          { openTime: "2026-10-05T00:00:00.000Z", closeTime: "2026-10-06T00:00:00.000Z", high: "1.1", low: "1.0", role: "interior", usedAs: "establishes" },
          { openTime: "2026-10-06T00:00:00.000Z", closeTime: "2026-10-07T00:00:00.000Z", high: "1.2", low: "1.05", role: "interior", usedAs: "establishes" },
        ],
        unreadableDigests: [],
        granularity: "1d",
        net: null,
      },
    });
    const rows = [
      { claim: { id: "b", claimType: "price_threshold", resolution: { outcome: "false" }, detail: thin }, source: { id: "b", handle: "Community_Sui" } },
      { claim: { id: "a", claimType: "price_threshold", resolution: { outcome: "false" }, detail: thick }, source: { id: "b", handle: "Community_Sui" } },
      { claim: { id: "z", claimType: "price_threshold", resolution: { outcome: "true" }, detail: thick }, source: { id: "b", handle: "Community_Sui" } },
    ];
    expect(heroClaim(rows, "Community_Sui")?.claim.id).toBe("a");
  });
});

describe("stored price path", () => {
  it("returns null for a single deciding candle", () => {
    const view = detail({
      actual: {
        extreme: { value: "1.2545", at: "2026-10-05T00:00:00.000Z", candleOpen: "2026-10-05T00:00:00.000Z", field: "high", bound: false },
        windowHigh: { value: "1.2545", at: "2026-10-05T00:00:00.000Z", candleOpen: "2026-10-05T00:00:00.000Z", field: "high", bound: false },
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [
          { openTime: "2026-10-05T00:00:00.000Z", closeTime: "2026-10-06T00:00:00.000Z", high: "1.2545", low: "1.20", role: "interior", usedAs: "establishes" },
        ],
        unreadableDigests: [],
        granularity: "1d",
        net: null,
      },
    });
    expect(pricePath(view)).toBeNull();
  });

  it("uses stored candle highs for a rise and does not add the target as a point", () => {
    const view = detail({
      actual: {
        extreme: null,
        windowHigh: null,
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [
          { openTime: "2026-10-05T00:00:00.000Z", closeTime: "2026-10-06T00:00:00.000Z", high: "1.10", low: "1.00", role: "interior", usedAs: "establishes" },
          { openTime: "2026-10-06T00:00:00.000Z", closeTime: "2026-10-07T00:00:00.000Z", high: "1.20", low: "1.05", role: "interior", usedAs: "establishes" },
        ],
        unreadableDigests: [],
        granularity: "1d",
        net: null,
      },
    });
    expect(pricePath(view)).toEqual({
      points: [
        { at: "2026-10-05T00:00:00.000Z", value: 1.1 },
        { at: "2026-10-06T00:00:00.000Z", value: 1.2 },
      ],
      target: 1.29,
    });
  });

  it("keeps a boundary-day cap separate from the in-window high", () => {
    const view = detail({
      actual: {
        extreme: { value: "0.95400000", at: "2026-08-22T00:00:00.000Z", candleOpen: "2026-08-22T00:00:00.000Z", field: "high", bound: true },
        windowHigh: { value: "0.85750000", at: "2026-08-23T00:00:00.000Z", candleOpen: "2026-08-23T00:00:00.000Z", field: "high", bound: false },
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [],
        unreadableDigests: [],
        granularity: "1d",
        net: null,
      },
    });
    expect(shownActual(view)).toEqual({
      field: "high",
      reached: null,
      bound: { value: "0.95400000", at: "2026-08-22T00:00:00.000Z" },
      inWindow: { value: "0.85750000", at: "2026-08-23T00:00:00.000Z" },
    });
  });

  it("states an in-window high as reached when the extreme is not a bound", () => {
    const view = detail({
      actual: {
        extreme: { value: "0.77960000", at: "2026-07-22T00:00:00.000Z", candleOpen: "2026-07-22T00:00:00.000Z", field: "high", bound: false },
        windowHigh: { value: "0.77960000", at: "2026-07-22T00:00:00.000Z", candleOpen: "2026-07-22T00:00:00.000Z", field: "high", bound: false },
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [],
        unreadableDigests: [],
        granularity: "1d",
        net: null,
      },
    });
    expect(shownActual(view)?.reached).toEqual({ value: "0.77960000", at: "2026-07-22T00:00:00.000Z" });
    expect(shownActual(view)?.bound).toBeNull();
  });

  it("does not connect a daily candle to hourly candles", () => {
    const view = detail({
      actual: {
        extreme: null,
        windowHigh: null,
        windowLow: null,
        maxHigh: null,
        minLow: null,
        highAtMost: null,
        lowAtLeast: null,
        decidingCandles: [
          { openTime: "2026-10-05T00:00:00.000Z", closeTime: "2026-10-06T00:00:00.000Z", high: "1.10", low: "1.00", role: "interior", usedAs: "establishes" },
          { openTime: "2026-10-06T00:00:00.000Z", closeTime: "2026-10-06T01:00:00.000Z", high: "1.11", low: "1.08", role: "refined", usedAs: "establishes" },
          { openTime: "2026-10-06T03:00:00.000Z", closeTime: "2026-10-06T04:00:00.000Z", high: "1.20", low: "1.12", role: "refined", usedAs: "establishes" },
        ],
        unreadableDigests: [],
        granularity: "1h",
        net: null,
      },
    });
    expect(pricePath(view)?.points).toEqual([
      { at: "2026-10-06T00:00:00.000Z", value: 1.11 },
      { at: "2026-10-06T03:00:00.000Z", value: 1.2 },
    ]);
  });
});

describe("timeFraction", () => {
  it("places a point by elapsed time, not by its index", () => {
    const points = [
      { at: "2026-10-05T00:00:00.000Z" },
      { at: "2026-10-06T00:00:00.000Z" },
      { at: "2026-10-08T00:00:00.000Z" },
    ];
    expect(timeFraction(points[1]!.at, points)).toBeCloseTo(1 / 3);
    expect(timeFraction(points[0]!.at, points)).toBe(0);
    expect(timeFraction(points[2]!.at, points)).toBe(1);
  });
});

describe("displayDecimal", () => {
  it("trims padded evidence and leaves a short target alone", () => {
    expect(displayDecimal("0.85750000")).toBe("0.8575");
    expect(displayDecimal("1.25450000")).toBe("1.2545");
    expect(displayDecimal("1.0")).toBe("1.0");
    expect(displayDecimal("1.29")).toBe("1.29");
  });
});

describe("groupFeed", () => {
  it("hides muted sources until the toggle is on, and keeps source order", () => {
    const rows = [
      { id: "1", source: { id: "w", muted: false } },
      { id: "2", source: { id: "c", muted: true } },
      { id: "3", source: { id: "w", muted: false } },
    ];
    expect(groupFeed(rows, false).map((group) => group.rows.map((row) => row.id))).toEqual([["1", "3"]]);
    expect(groupFeed(rows, true).map((group) => group.source.id)).toEqual(["w", "c"]);
  });
});
