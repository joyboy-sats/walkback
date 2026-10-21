import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candleCoversInstant,
  candleEndExclusiveMs,
  decidingExtreme,
  parseTatumCandle,
  parseTatumCandles,
  priceParamsFromRaw,
  spanMatchesInterval,
} from "./price-candle";

const documented = JSON.parse(readFileSync("fixtures/tatum/ohlcv-btc-documented.json", "utf8"));
const documentedBatch = JSON.parse(readFileSync("fixtures/tatum/ohlcv-batch-btc-documented.json", "utf8"));

describe("Tatum OHLCV fixture", () => {
  it("parses the published HistoricalPrice body", () => {
    const candle = parseTatumCandle(documented);
    expect(candle).not.toBeNull();
    expect(candle!.symbol).toBe("BTC");
    expect(candle!.open).toBe(69822.94);
    expect(candle!.high).toBe(69830.69);
    expect(candle!.low).toBe(69793.24);
    expect(candle!.close).toBe(69830.68);
    expect(candle!.openTimeMs).toBe(1771113600000);
    expect(candle!.closeTimeMs).toBe(1771113659999);
    expect(candle!.closeTimeMs - candle!.openTimeMs).toBe(59_999);
  });

  it("parses the batch endpoint's array of the same object", () => {
    const candles = parseTatumCandles(documentedBatch);
    expect(candles).toHaveLength(1);
    expect(candles![0]!.close).toBe(69830.68);
  });

  it("treats the published closeTime as the last millisecond inside a 1m bucket", () => {
    const candle = parseTatumCandle(documented)!;
    const asMinute = { ...candle };
    expect(spanMatchesInterval(asMinute, "1h")).toBe(false);
    expect(candle.closeTimeMs - candle.openTimeMs + 1).toBe(60_000);
    expect(candle.openTimeMs <= candle.openTimeMs && candle.openTimeMs <= candle.closeTimeMs).toBe(true);
    expect(candle.closeTimeMs + 1 > candle.closeTimeMs).toBe(true);
  });
});

describe("candle coverage", () => {
  const open = Date.parse("2026-10-01T00:00:00.000Z");

  function hour(high: number, low = high - 0.1) {
    const closeTimeMs = open + 3_600_000 - 1;
    return parseTatumCandle({
      symbol: "SUI",
      openTime: open,
      closeTime: closeTimeMs,
      open: String(low),
      high: String(high),
      low: String(low),
      close: String((high + low) / 2),
    })!;
  }

  it("covers the open and excludes the next bucket", () => {
    const candle = hour(1.5);
    expect(spanMatchesInterval(candle, "1h")).toBe(true);
    expect(candleEndExclusiveMs(candle, "1h")).toBe(open + 3_600_000);
    expect(candleCoversInstant(candle, open, "1h")).toBe(true);
    expect(candleCoversInstant(candle, open + 3_600_000 - 1, "1h")).toBe(true);
    expect(candleCoversInstant(candle, open + 3_600_000, "1h")).toBe(false);
  });

  it("picks the window high for an upside claim and the window low for a downside claim", () => {
    const first = hour(1.2, 1.0);
    const second = {
      ...hour(1.8, 0.7),
      openTimeMs: open + 3_600_000,
      closeTimeMs: open + 7_200_000 - 1,
      openTime: new Date(open + 3_600_000).toISOString(),
      closeTime: new Date(open + 7_200_000 - 1).toISOString(),
    };
    expect(decidingExtreme([first, second], "gte")!.value).toBe(1.8);
    expect(decidingExtreme([first, second], "lte")!.value).toBe(0.7);
    expect(decidingExtreme([first, second], "gte")!.at).toBe(second.openTime);
  });
});

describe("priceParamsFromRaw", () => {
  it("starts a touch window at the publish time", () => {
    const params = priceParamsFromRaw({
      symbol: "sol",
      quote: "usd",
      direction: "gte",
      amount: "200",
      evaluation: "touch",
      since: "2020-01-01T00:00:00.000Z",
      publishedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(params).toEqual({
      symbol: "SOL",
      quote: "USD",
      direction: "gte",
      amount: "200",
      evaluation: "touch",
      since: "2026-10-01T00:00:00.000Z",
    });
  });

  it("rejects an unknown evaluation and a touch with no start", () => {
    expect(
      priceParamsFromRaw({ symbol: "ETH", direction: "lte", amount: "1", evaluation: "hold" }),
    ).toBeNull();
    expect(
      priceParamsFromRaw({ symbol: "ETH", direction: "lte", amount: "1", evaluation: "touch" }),
    ).toBeNull();
  });

  it("leaves evaluation unset when the stored row predates the field", () => {
    const params = priceParamsFromRaw({ symbol: "BTC", direction: "gte", amount: "100" });
    expect(params?.evaluation).toBeUndefined();
    expect(params?.since).toBeUndefined();
  });
});
