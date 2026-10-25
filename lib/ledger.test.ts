import { describe, expect, it } from "vitest";
import { buildLedger, includeMutedParam, sortClaimTypes, verifiedMemoryCount, visibleClaims } from "./ledger";
import { wilsonLowerBound } from "./score";

const trusted = wilsonLowerBound(11, 11);
const normal = wilsonLowerBound(3, 3);
const muted = wilsonLowerBound(2, 3);

function source(partial: {
  id: string;
  handle: string;
  hits: number;
  misses: number;
  storedMuted?: boolean;
}) {
  const adjudicated = partial.hits + partial.misses;
  return {
    id: partial.id,
    handle: partial.handle,
    hits: partial.hits,
    misses: partial.misses,
    score: wilsonLowerBound(partial.hits, adjudicated),
    storedMuted: partial.storedMuted ?? false,
  };
}

describe("buildLedger", () => {
  const sources = [
    source({ id: "sui", handle: "suintern_", hits: 0, misses: 2 }),
    source({ id: "watch", handle: "_OnChainWatch", hits: 11, misses: 0 }),
    source({ id: "gopal", handle: "cryptowithgopal", hits: 3, misses: 0 }),
    source({ id: "cam", handle: "mrcamerontrader", hits: 2, misses: 1, storedMuted: true }),
    source({ id: "empty", handle: "quiet", hits: 0, misses: 0 }),
  ];
  const claims = [
    { sourceId: "watch", claimType: "tx_replay", status: "resolved" as const },
    { sourceId: "watch", claimType: "tx_replay", status: "resolved" as const },
    { sourceId: "gopal", claimType: "price_threshold", status: "resolved" as const },
    { sourceId: "gopal", claimType: "price_threshold", status: "void" as const },
    { sourceId: "cam", claimType: "price_threshold", status: "resolved" as const },
    { sourceId: "sui", claimType: "price_threshold", status: "resolved" as const },
    { sourceId: "sui", claimType: "manual", status: "pending" as const },
    { sourceId: "sui", claimType: "price_threshold", status: "pending" as const },
  ];

  it("lists every source, with band, record, and claim types", () => {
    const view = buildLedger({
      sources,
      claims,
      memoryInventory: 48,
      latestVerifyResult: null,
    });
    expect(view.sources.map((row) => row.handle)).toEqual([
      "_OnChainWatch",
      "cryptowithgopal",
      "mrcamerontrader",
      "suintern_",
      "quiet",
    ]);
    expect(view.sources.map((row) => row.band)).toEqual([
      "trusted",
      "normal",
      "muted",
      "unknown",
      "unknown",
    ]);
    const watch = view.sources[0];
    expect(watch?.score).toBeCloseTo(trusted, 10);
    expect(watch?.hits).toBe(11);
    expect(watch?.misses).toBe(0);
    expect(watch?.claimTypes).toEqual(["tx_replay"]);
    expect(view.sources[1]?.score).toBeCloseTo(normal, 10);
    expect(view.sources[1]?.claimTypes).toEqual(["price_threshold"]);
    expect(view.sources[2]?.score).toBeCloseTo(muted, 10);
    expect(view.sources[2]?.muted).toBe(true);
    expect(view.sources[3]?.muted).toBe(false);
    expect(view.sources[3]?.claimTypes).toEqual(["price_threshold", "manual"]);
    expect(view.sources[4]?.claimTypes).toEqual([]);
    expect(view.sources[0]?.muteBasis).toBeNull();
    expect(view.sources[0]?.reporting).toBeNull();
  });

  it("shows the forecast record once a source has forecasts, and counts hidden misses", () => {
    const view = buildLedger({
      sources: [
        {
          ...source({ id: "watch", handle: "_OnChainWatch", hits: 11, misses: 3 }),
          reportingHits: 11,
          reportingMisses: 0,
          forecastHits: 0,
          forecastMisses: 3,
        },
        {
          ...source({ id: "pure", handle: "onlyReports", hits: 11, misses: 0 }),
          reportingHits: 11,
          reportingMisses: 0,
          forecastHits: 0,
          forecastMisses: 0,
        },
      ],
      claims: [
        { sourceId: "watch", claimType: "tx_replay", status: "resolved", outcome: "true" },
        { sourceId: "watch", claimType: "price_threshold", status: "resolved", outcome: "false" },
        { sourceId: "watch", claimType: "price_threshold", status: "resolved", outcome: "false" },
        { sourceId: "watch", claimType: "price_threshold", status: "resolved", outcome: "false" },
        { sourceId: "pure", claimType: "tx_replay", status: "resolved", outcome: "true" },
      ],
      memoryInventory: 0,
      latestVerifyResult: null,
    });
    const watch = view.sources.find((row) => row.handle === "_OnChainWatch");
    const pure = view.sources.find((row) => row.handle === "onlyReports");
    expect(watch?.muteBasis).toBe("forecast");
    expect(watch?.band).toBe("muted");
    expect(watch?.muted).toBe(true);
    expect(watch?.hits).toBe(0);
    expect(watch?.misses).toBe(3);
    expect(watch?.reporting).toMatchObject({ hits: 11, misses: 0, band: "trusted" });
    expect(watch?.overall?.band).toBe("normal");
    expect(pure?.muteBasis).toBe("reporting");
    expect(pure?.band).toBe("trusted");
    expect(pure?.muted).toBe(false);
    expect(view.totals.mutedSources).toBe(1);
    expect(view.totals.hiddenClaims).toBe(4);
    expect(view.totals.hiddenClaimsFalse).toBe(3);
    expect(view.totals.visible.claims).toBe(1);
    expect(view.totals.all.claims).toBe(5);
    expect(view.totals.allIncludesMuted).toBe(true);
    expect(view.totals.visibleIncludesMuted).toBe(false);
  });

  it("uses the forecast basis for two price misses and no reporting", () => {
    const view = buildLedger({
      sources: [
        {
          ...source({ id: "sui", handle: "suintern_", hits: 0, misses: 2 }),
          reportingHits: 0,
          reportingMisses: 0,
          forecastHits: 0,
          forecastMisses: 2,
        },
      ],
      claims: [
        { sourceId: "sui", claimType: "price_threshold", status: "resolved", outcome: "false" },
        { sourceId: "sui", claimType: "price_threshold", status: "resolved", outcome: "false" },
      ],
      memoryInventory: 0,
      latestVerifyResult: null,
    });
    const row = view.sources[0];
    expect(row?.muteBasis).toBe("forecast");
    expect(row?.band).toBe("unknown");
    expect(row?.muted).toBe(false);
    expect(row?.forecast).toMatchObject({ hits: 0, misses: 2, n: 2, band: "unknown" });
    expect(row?.reporting).toMatchObject({ hits: 0, misses: 0, n: 0, band: "unknown" });
  });

  it("keeps an under-sampled mute unrated and visible", () => {
    const view = buildLedger({
      sources: [source({ id: "sui", handle: "suintern_", hits: 0, misses: 2, storedMuted: true })],
      claims: [],
      memoryInventory: 0,
      latestVerifyResult: null,
    });
    expect(view.sources[0]?.band).toBe("unknown");
    expect(view.sources[0]?.muted).toBe(false);
  });

  it("counts the whole ledger, separate from any feed filter", () => {
    const view = buildLedger({
      sources,
      claims,
      memoryInventory: "48",
      latestVerifyResult: null,
    });
    expect(view.totals).toEqual({
      claims: 8,
      resolved: 5,
      pending: 2,
      void: 1,
      muteRule: "forecast-primary",
      allIncludesMuted: true,
      visibleIncludesMuted: false,
      all: { claims: 8, resolved: 5, pending: 2, void: 1 },
      visible: { claims: 7, resolved: 4, pending: 2, void: 1 },
      mutedSources: 1,
      hiddenClaims: 1,
      hiddenClaimsFalse: null,
      memories: { inventory: 48, verified: null },
    });
  });

  it("labels a completed list walk as verified and leaves a sample as inventory", () => {
    expect(
      verifiedMemoryCount({
        coverageComplete: true,
        enumeration: "list",
        coverage: { unique: 48, rawHits: 50 },
      }),
    ).toBe(48);
    expect(
      verifiedMemoryCount({
        coverageComplete: true,
        enumeration: "list",
        coverage: { unique: 0 },
      }),
    ).toBe(0);
    expect(
      verifiedMemoryCount({
        coverageComplete: false,
        enumeration: "list",
        coverage: { unique: 48 },
      }),
    ).toBeNull();
    expect(
      verifiedMemoryCount({
        coverageComplete: true,
        enumeration: "recall-fallback",
        coverage: { unique: 48 },
      }),
    ).toBeNull();
    expect(verifiedMemoryCount({ coverageComplete: true, enumeration: "list", coverage: { unique: 1.5 } })).toBeNull();
    expect(verifiedMemoryCount(null)).toBeNull();

    const verified = buildLedger({
      sources: [],
      claims: [],
      memoryInventory: 52,
      latestVerifyResult: {
        coverageComplete: true,
        enumeration: "list",
        coverage: { unique: 48 },
      },
    });
    expect(verified.totals.memories).toEqual({ inventory: 52, verified: 48 });
  });
});

describe("sortClaimTypes", () => {
  it("puts tx reporting before price predictions and drops duplicates", () => {
    expect(sortClaimTypes(["manual", "price_threshold", "tx_replay", "tx_replay", "custom"])).toEqual([
      "tx_replay",
      "price_threshold",
      "manual",
      "custom",
    ]);
  });
});

describe("visibleClaims", () => {
  const rows = [
    { id: "a", source: { muted: false } },
    { id: "b", source: { muted: true } },
    { id: "c", source: { muted: false } },
  ];

  it("hides muted claims until the feed asks for them", () => {
    expect(visibleClaims(rows, false)).toEqual({
      visible: [rows[0], rows[2]],
      hidden: 1,
    });
    expect(visibleClaims(rows, true)).toEqual({ visible: rows, hidden: 0 });
  });

  it("reads the include-muted query as the string 1", () => {
    expect(includeMutedParam("1")).toBe(true);
    expect(includeMutedParam(["1"])).toBe(true);
    expect(includeMutedParam("true")).toBe(false);
    expect(includeMutedParam(undefined)).toBe(false);
  });
});
