import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERVAL_MS, parseTatumCandle, parseTatumCandles, type PriceCandle } from "./price-candle";
import {
  coverWindow,
  loadDeadlinePrice,
  loadTouchWindow,
  type PriceHistorySource,
} from "./price-history";

const START = Date.parse("2026-10-01T00:00:00.000Z");

function candle(
  openMs: number,
  interval: "1h" | "1d",
  high: number,
  low: number,
  symbol = "SUI",
): PriceCandle {
  const closeTimeMs = openMs + INTERVAL_MS[interval] - 1;
  const close = (high + low) / 2;
  return {
    symbol,
    openTimeMs: openMs,
    closeTimeMs,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(closeTimeMs).toISOString(),
    open: low,
    high,
    low,
    close,
  };
}

function hours(count: number, highAt: (i: number) => number, lowAt: (i: number) => number = () => 1): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => candle(START + i * INTERVAL_MS["1h"], "1h", highAt(i), lowAt(i)));
}

function sourceOf(pages: {
  "1m"?: PriceCandle[] | "400" | "unsupported";
  "1h"?: PriceCandle[] | "400" | "unsupported";
  "1d"?: PriceCandle[] | "400" | "unsupported";
  at?: Record<string, PriceCandle | null | "unsupported">;
}): PriceHistorySource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async page(query) {
      calls.push(`page ${query.interval} ${query.from}`);
      const spec = pages[query.interval];
      if (spec === "400") throw Object.assign(new Error("bad interval"), { code: 400 });
      if (spec === "unsupported" || spec === undefined) return undefined;
      const from = Date.parse(query.from);
      return spec.filter((c) => c.openTimeMs >= from).slice(0, query.limit);
    },
    async at(query) {
      calls.push(`at ${query.interval} ${query.at}`);
      const spec = pages.at?.[query.interval];
      if (spec === "unsupported") return undefined;
      return spec ?? null;
    },
  };
}

describe("loadTouchWindow", () => {
  const from = new Date(START).toISOString();
  const to = new Date(START + 3 * INTERVAL_MS["1h"]).toISOString();

  it("is true when the hourly high reaches an upside target, and false when it does not", async () => {
    const candles = hours(3, (i) => (i === 1 ? 1.4 : 1.1), () => 1);
    const hit = await loadTouchWindow(sourceOf({ "1h": candles }), {
      symbol: "SUI",
      from,
      to,
      direction: "gte",
      threshold: "1.28",
    });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.interval).toBe("1h");
    expect(hit.touched).toBe(true);
    expect(hit.extreme).toMatchObject({ value: 1.4, field: "high", at: candles[1]!.openTime });
    expect(hit.extreme.bound).toBeUndefined();
    expect(hit.decidingCandles[0]).toMatchObject({ role: "interior", usedAs: "establishes" });
    expect(hit.extreme.value >= 1.28).toBe(true);
    expect(hit.extreme.value >= 1.5).toBe(false);

    const miss = await loadTouchWindow(sourceOf({ "1h": hours(3, () => 1.1) }), {
      symbol: "SUI",
      from,
      to,
      direction: "gte",
      threshold: "1.28",
    });
    expect(miss.ok && miss.touched).toBe(false);
    expect(miss.ok && miss.extreme.value >= 1.28).toBe(false);
  });

  it("uses the hourly low for a downside touch", async () => {
    const candles = hours(3, () => 1.2, (i) => (i === 2 ? 0.8 : 1.05));
    const loaded = await loadTouchWindow(sourceOf({ "1h": candles }), {
      symbol: "SUI",
      from,
      to,
      direction: "lte",
      threshold: "0.9",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.touched).toBe(true);
    expect(loaded.extreme).toMatchObject({ value: 0.8, field: "low" });
    expect(loaded.minLow.value).toBe(0.8);
    expect(loaded.maxHigh.value).toBe(1.2);
  });

  it("does not change the extreme when the same candles are read later", async () => {
    const candles = hours(3, (i) => (i === 0 ? 2.2 : 1));
    const first = await loadTouchWindow(sourceOf({ "1h": candles }), {
      symbol: "SUI",
      from,
      to,
      direction: "gte",
      threshold: "2",
    });
    const later = await loadTouchWindow(sourceOf({ "1h": candles }), {
      symbol: "SUI",
      from,
      to,
      direction: "gte",
      threshold: "2",
    });
    expect(first.ok && later.ok && first.extreme).toEqual(later.ok ? later.extreme : null);
  });

  it("voids a hole in the hourly series instead of falling back to daily", async () => {
    const candles = hours(3, () => 5).filter((_, i) => i !== 1);
    const src = sourceOf({ "1h": candles, "1d": [candle(START, "1d", 9, 0.1)] });
    const loaded = await loadTouchWindow(src, { symbol: "SUI", from, to, direction: "gte", threshold: "1" });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.toLowerCase()).toContain("missing");
    expect(src.calls.some((call) => call.startsWith("page 1d"))).toBe(false);
  });

  it("allows the partial first hour the batch endpoint skips", () => {
    const candles = hours(3, () => 1.2).slice(1);
    const fromMs = START + 30 * 60 * 1000;
    const toMs = START + 3 * INTERVAL_MS["1h"];
    const covered = coverWindow(candles, fromMs, toMs, "1h");
    expect(covered.ok).toBe(true);
    if (!covered.ok) return;
    expect(covered.boundary.uncoveredStartMs).toBe(30 * 60 * 1000);
  });

  it("voids a daily high that only overlaps a short window when hourly candles are rejected", async () => {
    const daily = [candle(START, "1d", 3, 0.9)];
    const src = sourceOf({ "1h": "400", "1d": daily });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from,
      to,
      direction: "gte",
      threshold: "1",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.toLowerCase()).toMatch(/not checked|edge|window/);
    expect(src.calls.some((call) => call.startsWith("page 1d"))).toBe(true);
  });

  it("uses an interior daily candle when hourly is rejected and the day sits inside the window", async () => {
    const daily = [0, 1, 2].map((i) => candle(START + i * INTERVAL_MS["1d"], "1d", i === 1 ? 2.5 : 1.1, 0.9));
    const src = sourceOf({ "1h": "400", "1d": daily });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from,
      to: new Date(START + 3 * INTERVAL_MS["1d"]).toISOString(),
      direction: "gte",
      threshold: "2",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.interval).toBe("1d");
    expect(loaded.touched).toBe(true);
    expect(loaded.extreme.value).toBe(2.5);
    expect(loaded.decidingCandles[0]?.role).toBe("interior");
  });

  it("voids an unsupported symbol without trying daily candles", async () => {
    const src = sourceOf({ "1h": "unsupported", "1d": [candle(START, "1d", 1, 1)] });
    const loaded = await loadTouchWindow(src, { symbol: "SOL", from, to, direction: "gte", threshold: "1" });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.toLowerCase()).toMatch(/does not cover|unsupported/);
    expect(src.calls).toEqual([expect.stringMatching(/^page 1h/)]);
  });

  it("uses daily candles when the window is longer than the hourly budget", async () => {
    const span = 50 * INTERVAL_MS["1d"];
    const daily = Array.from({ length: 51 }, (_, i) => candle(START + i * INTERVAL_MS["1d"], "1d", 1.2, 0.9));
    const src = sourceOf({ "1d": daily });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: new Date(START).toISOString(),
      to: new Date(START + span).toISOString(),
      direction: "lte",
      threshold: "1",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.interval).toBe("1d");
    expect(loaded.touched).toBe(true);
    expect(src.calls.every((call) => call.startsWith("page 1d"))).toBe(true);
    expect(loaded.extreme.value).toBe(0.9);
  });
});

describe("strict window touch", () => {
  const hour = JSON.parse(readFileSync("fixtures/tatum/ohlcv-boundary-hour.json", "utf8"));
  const minutesMiss = JSON.parse(readFileSync("fixtures/tatum/ohlcv-boundary-minutes-miss.json", "utf8"));
  const minutesHit = JSON.parse(readFileSync("fixtures/tatum/ohlcv-boundary-minutes-hit.json", "utf8"));
  const unroundedHit = JSON.parse(readFileSync("fixtures/tatum/ohlcv-unrounded-hit.json", "utf8"));
  const unroundedMiss = JSON.parse(readFileSync("fixtures/tatum/ohlcv-unrounded-miss.json", "utf8"));

  const published = "2026-08-06T06:35:06.000Z";
  const deadline = "2026-08-06T08:00:00.000Z";

  function parsed(raw: unknown): PriceCandle {
    const candle = parseTatumCandle(raw);
    if (!candle) throw new Error("fixture candle did not parse");
    return candle;
  }

  function parsedList(raw: unknown): PriceCandle[] {
    const candles = parseTatumCandles(raw);
    if (!candles) throw new Error("fixture candles did not parse");
    return candles;
  }

  it("does not let a boundary hour establish a touch when the in-window minutes miss", async () => {
    const hourly = [parsed(hour.leading), parsed(hour.interior)];
    const src = sourceOf({ "1h": hourly, "1m": parsedList(minutesMiss) });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: published,
      to: deadline,
      direction: "gte",
      threshold: "0.72",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.touched).toBe(false);
    expect(loaded.extreme.text).not.toBe("0.73000000");
    expect(Number(loaded.extreme.text)).toBeLessThan(0.72);
    expect(loaded.windowHigh?.text).not.toBe("0.73000000");
    expect(loaded.decidingCandles.some((candle) => candle.role === "refined")).toBe(true);
    expect(loaded.decidingCandles.every((candle) => candle.high !== "0.73000000")).toBe(true);
    expect(src.calls.some((call) => call.startsWith("page 1m"))).toBe(true);
  });

  it("accepts a touch once a minute inside the window prints it", async () => {
    const hourly = [parsed(hour.leading), parsed(hour.interior)];
    const src = sourceOf({ "1h": hourly, "1m": parsedList(minutesHit) });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: published,
      to: deadline,
      direction: "gte",
      threshold: "0.72",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.touched).toBe(true);
    expect(loaded.extreme.text).toBe("0.72500000");
    expect(loaded.extreme.bound).toBeUndefined();
    expect(loaded.decidingCandles[0]).toMatchObject({
      role: "refined",
      usedAs: "establishes",
      openTime: "2026-08-06T06:40:00.000Z",
      high: "0.72500000",
    });
    expect(loaded.windowHigh?.text).toBe("0.72500000");
  });

  it("refutes from the boundary hour itself when that hour's high misses, without minute candles", async () => {
    const leading = parsed(hour.leading);
    leading.high = 0.71;
    leading.highText = "0.71000000";
    const src = sourceOf({ "1h": [leading, parsed(hour.interior)], "1m": parsedList(minutesHit) });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: published,
      to: deadline,
      direction: "gte",
      threshold: "0.72",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.touched).toBe(false);
    expect(loaded.extreme).toMatchObject({ text: "0.71000000", bound: true });
    expect(src.calls.some((call) => call.startsWith("page 1m"))).toBe(false);
  });

  it("keeps an interior touch when an earlier boundary hour printed a higher high", async () => {
    const leading = parsed(hour.leading);
    leading.high = 9;
    leading.highText = "9.00000000";
    const interior = parsed(hour.interior);
    interior.high = 1.5;
    interior.highText = "1.50000000";
    const src = sourceOf({ "1h": [leading, interior], "1m": parsedList(minutesHit) });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: published,
      to: deadline,
      direction: "gte",
      threshold: "1.2",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.touched).toBe(true);
    expect(loaded.windowHigh?.text).toBe("1.50000000");
    expect(loaded.extreme.text).toBe("1.50000000");
    expect(src.calls.some((call) => call.startsWith("page 1m"))).toBe(false);
  });

  it("compares the fixture's unrounded high and does not treat 0.99999999 as 1", async () => {
    const hitCandle = parsed(unroundedHit);
    const missCandle = parsed(unroundedMiss);
    const fromMs = hitCandle.openTimeMs;
    const toMs = fromMs + INTERVAL_MS["1h"];
    const hit = await loadTouchWindow(sourceOf({ "1h": [hitCandle] }), {
      symbol: "SUI",
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      direction: "gte",
      threshold: "1",
    });
    const miss = await loadTouchWindow(sourceOf({ "1h": [missCandle] }), {
      symbol: "SUI",
      from: missCandle.openTime,
      to: new Date(missCandle.openTimeMs + INTERVAL_MS["1h"]).toISOString(),
      direction: "gte",
      threshold: "1",
    });
    expect(hit.ok && hit.touched).toBe(true);
    expect(hit.ok && hit.extreme.text).toBe("1.00000001");
    expect(miss.ok && miss.touched).toBe(false);
    expect(miss.ok && miss.extreme.text).toBe("0.99999999");
    expect(Number(miss.ok ? miss.extreme.text : "0").toFixed(2)).toBe("1.00");
  });

  it("voids when the finer candles still cannot place a boundary extreme inside the window", async () => {
    const hourly = [parsed(hour.leading), parsed(hour.interior)];
    const src = sourceOf({ "1h": hourly, "1m": "400" });
    const loaded = await loadTouchWindow(src, {
      symbol: "SUI",
      from: published,
      to: deadline,
      direction: "gte",
      threshold: "0.72",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.toLowerCase()).toMatch(/not checked|edge|window/);
    expect(loaded.evidence).toMatchObject({ timingAmbiguity: true, strictWindow: true });
  });
});

describe("loadDeadlinePrice", () => {
  it("uses the hourly open when the deadline is the candle open", async () => {
    const bucket = candle(START, "1h", 1.5, 1.1);
    bucket.open = 1.25;
    bucket.close = 1.4;
    const loaded = await loadDeadlinePrice(
      sourceOf({ at: { "1h": bucket } }),
      { symbol: "SUI", at: new Date(START).toISOString() },
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.field).toBe("open");
    expect(loaded.value).toBe(1.25);
    expect(loaded.at).toBe(bucket.openTime);
    expect(loaded.interval).toBe("1h");
  });

  it("uses the hourly close when the deadline falls inside the candle", async () => {
    const bucket = candle(START, "1h", 1.5, 1.1);
    bucket.close = 1.33;
    const at = new Date(START + 15 * 60 * 1000).toISOString();
    const loaded = await loadDeadlinePrice(sourceOf({ at: { "1h": bucket } }), { symbol: "SUI", at });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.field).toBe("close");
    expect(loaded.value).toBe(1.33);
    expect(loaded.at).toBe(bucket.closeTime);
  });

  it("voids a snapped candle that does not cover the deadline", async () => {
    const old = candle(START, "1h", 9, 8);
    const at = new Date(START + 10 * INTERVAL_MS["1d"]).toISOString();
    const loaded = await loadDeadlinePrice(sourceOf({ at: { "1h": old, "1d": old } }), {
      symbol: "SUI",
      at,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.toLowerCase()).toContain("cover");
    expect(loaded.evidence.covered).toBe(false);
  });

  it("asks for the deadline timestamp, including one years earlier", async () => {
    const at = "2024-06-01T00:00:00.000Z";
    const bucket = candle(Date.parse(at), "1h", 1.2, 1, "SOL");
    const src = sourceOf({ at: { "1h": bucket } });
    const loaded = await loadDeadlinePrice(src, { symbol: "SOL", at });
    expect(loaded.ok).toBe(true);
    expect(src.calls[0]).toContain("2024-06-01T00:00:00.000Z");
    expect(src.calls[0]).not.toContain("2026");
  });
});
