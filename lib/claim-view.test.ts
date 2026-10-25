import { describe, expect, it } from "vitest";
import { presentClaim, SUISCAN_TX_PREFIX } from "./claim-view";

const digest = "5Tm6UqP1h1mYk8nQ2vQw8s1nQ2vQw8s1nQ2vQw8s1nQ2";

describe("presentClaim", () => {
  it("reads a touch forecast from the stored params and candle", () => {
    const view = presentClaim({
      id: "c1",
      quote: "A breakout above $1.08–$1.10 could trigger a move toward $1.28",
      claimType: "price_threshold",
      status: "resolved",
      params: {
        symbol: "SUI",
        quote: "USD",
        direction: "gte",
        amount: "1.28",
        evaluation: "touch",
        since: "2026-10-17T10:59:35.000Z",
      },
      deadline: "2026-11-08T00:00:00.000Z",
      deadlineBasis: "seed author; technical analysis, post states no date",
      claimBlobId: "claim-blob",
      resolution: {
        outcome: "false",
        reason: "window high missed 1.28",
        blobId: "resolution-blob",
        evidence: {
          symbol: "SUI",
          quote: "USD",
          source: "tatum:/v4/data/rate/symbol/OHLCV",
          interval: "1d",
          window: { from: "2026-10-17T10:59:35.000Z", to: "2026-11-08T00:00:00.000Z" },
          requests: 2,
          extreme: { value: 1.07, text: "1.07000000", at: "2026-10-20T00:00:00.000Z", field: "high", bound: false },
          windowHigh: { value: 1.07, text: "1.07000000", at: "2026-10-20T00:00:00.000Z", field: "high" },
          windowLow: { value: 0.98, text: "0.98000000", at: "2026-10-18T00:00:00.000Z", field: "low" },
          apiKey: "do-not-copy",
        },
      },
    });

    expect(view.publishedAt).toBe("2026-10-17T10:59:35.000Z");
    expect(view.parsed.conditionIgnored?.text).toContain("1.08");
    expect(view.parsed.conditionIgnored?.text).not.toContain("1.28");
    expect(view.parsed).toMatchObject({
      symbol: "SUI",
      quote: "USD",
      direction: "gte",
      target: "1.28",
      evaluation: "touch",
      priceBasis: "high",
      deadlineBasis: "seed author; technical analysis, post states no date",
    });
    expect(view.parsed.window).toEqual({
      since: "2026-10-17T10:59:35.000Z",
      deadline: "2026-11-08T00:00:00.000Z",
    });
    expect(view.expected).toBe("1.28");
    expect(view.actual?.extreme).toMatchObject({
      value: "1.07000000",
      candleOpen: "2026-10-20T00:00:00.000Z",
      field: "high",
    });
    expect(view.actual?.granularity).toBe("1d");
    expect(view.actual?.windowLow?.value).toBe("0.98000000");
    expect(view.tatum).toEqual({
      endpoint: "GET /v4/data/rate/symbol/OHLCV",
      params: {
        symbol: "SUI",
        interval: "1d",
        timeFrom: "2026-10-17T10:59:35.000Z",
        timeTo: "2026-11-08T00:00:00.000Z",
        requests: 2,
      },
    });
    expect(JSON.stringify(view)).not.toContain("do-not-copy");
    expect(view.walrus).toEqual({
      blobId: "resolution-blob",
      claimBlobId: "claim-blob",
      resolutionBlobId: "resolution-blob",
      url: null,
    });
    expect(view.transactions).toEqual([]);
  });

  it("leaves fields null when the stored evidence does not have them", () => {
    const view = presentClaim({
      id: "c2",
      quote: "SUI to $2",
      claimType: "price_threshold",
      status: "void",
      params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "2" },
      deadline: "2026-07-31T00:00:00.000Z",
      deadlineBasis: null,
      claimBlobId: null,
      resolution: { outcome: "void", reason: "could not check", evidence: {}, blobId: null },
    });
    expect(view.publishedAt).toBeNull();
    expect(view.parsed.evaluation).toBeNull();
    expect(view.parsed.priceBasis).toBeNull();
    expect(view.parsed.conditionIgnored).toBeNull();
    expect(view.actual?.extreme).toBeNull();
    expect(view.tatum).toBeNull();
    expect(view.walrus.url).toBeNull();
    expect(view.walrus.blobId).toBeNull();
  });

  it("links a stored tx digest and does not invent a url for a short id", () => {
    const view = presentClaim({
      id: "c3",
      quote: "received 10 SUI",
      claimType: "tx_replay",
      status: "resolved",
      params: { address: "0xabc", asset: "0x2::sui::SUI", direction: "gte", amount: "10", since: "2026-10-01T00:00:00.000Z" },
      deadline: "2026-10-02T00:00:00.000Z",
      deadlineBasis: null,
      claimBlobId: "blob-claim",
      resolution: {
        outcome: "true",
        reason: "net matched",
        blobId: null,
        evidence: { net: "12", digests: [digest, "nope"] },
      },
    });
    expect(view.transactions).toEqual([
      { digest, url: `${SUISCAN_TX_PREFIX}${digest}` },
      { digest: "nope", url: null },
    ]);
    expect(view.actual?.net).toBe("12");
    expect(view.walrus.blobId).toBe("blob-claim");
    expect(view.publishedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
