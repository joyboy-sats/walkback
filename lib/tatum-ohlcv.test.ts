/**
 * Historical candles. `ohlcv-btc-documented.json` is the HistoricalPrice body
 * Tatum publishes. `ohlcv-sui-1h-2025-10-09T08.json` is a live SUI 1h candle
 * from GET /v4/data/rate/symbol/OHLCV?symbol=SUI&interval=1h&time=2025-10-09T08:00:00Z.
 * Epoch ms on that parameter returns HTTP 400. Nothing here calls the network.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "./env";
import { getOhlcvAt, getOhlcvPage, ohlcvQueryTime, TatumError } from "./tatum";

vi.mock("server-only", () => ({}));

const realFetch = globalThis.fetch;
const candle = JSON.parse(readFileSync("fixtures/tatum/ohlcv-btc-documented.json", "utf8"));
const batch = JSON.parse(readFileSync("fixtures/tatum/ohlcv-batch-btc-documented.json", "utf8"));
const suiHour = JSON.parse(readFileSync("fixtures/tatum/ohlcv-sui-1h-2025-10-09T08.json", "utf8"));
const OPEN = "2026-02-15T00:00:00.000Z";
const SUI_AT = "2025-10-09T08:00:00Z";

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  resetEnvForTests();
});

function liveEnv(): void {
  vi.stubEnv("TATUM_API_KEY", "test-key");
  vi.stubEnv("DEMO_MODE", "live");
  resetEnvForTests();
}

describe("ohlcvQueryTime", () => {
  it("formats whole seconds like the live call and keeps a fractional second", () => {
    expect(ohlcvQueryTime(Date.parse(SUI_AT))).toBe("2025-10-09T08:00:00Z");
    expect(ohlcvQueryTime(Date.parse("2025-10-09T08:53:20.250Z"))).toBe("2025-10-09T08:53:20.250Z");
    expect(ohlcvQueryTime(1760000000000)).toBe("2025-10-09T08:53:20Z");
  });
});

describe("getOhlcvAt", () => {
  it("requests the documented endpoint and parses the published candle", async () => {
    liveEnv();
    const at = new Date(candle.openTime).toISOString();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(candle), { status: 200 })) as typeof fetch;

    const parsed = await getOhlcvAt("BTC", at, "1h");

    expect(parsed?.close).toBe(69830.68);
    expect(parsed?.symbol).toBe("BTC");
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(url).toContain("https://api.tatum.io/v4/data/rate/symbol/OHLCV?");
    const query = queryOf(url);
    expect(query.get("symbol")).toBe("BTC");
    expect(query.get("interval")).toBe("1h");
    expect(query.get("time")).toBe(ohlcvQueryTime(Date.parse(at)));
    expect(query.get("time")).toBe("2026-02-15T00:00:00Z");
    expect(query.get("time")).not.toMatch(/^\d+$/);
    expect(query.has("unix")).toBe(false);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
  });

  it("sends the live SUI hour as an ISO-8601 time and parses string prices", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(suiHour), { status: 200 })) as typeof fetch;

    const parsed = await getOhlcvAt("SUI", SUI_AT, "1h");

    expect(parsed).toMatchObject({
      symbol: "SUI",
      openTimeMs: 1759996800000,
      closeTimeMs: 1760000399999,
      open: 3.441,
      high: 3.446,
      low: 3.3747,
      close: 3.3813,
    });
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    const query = queryOf(url);
    expect(query.get("symbol")).toBe("SUI");
    expect(query.get("interval")).toBe("1h");
    expect(query.get("time")).toBe("2025-10-09T08:00:00Z");
    expect(url).not.toMatch(/[?&]time=\d+(?:&|$)/);
    expect(url).not.toContain("1760000000000");
    expect(query.has("unix")).toBe(false);
  });

  it("keeps the live SUI candle when the requested instant is inside the hour", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(suiHour), { status: 200 })) as typeof fetch;
    await expect(getOhlcvAt("SUI", "2025-10-09T08:53:20.000Z", "1h")).resolves.toMatchObject({
      openTimeMs: 1759996800000,
      closeTimeMs: 1760000399999,
    });
    expect(queryOf(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).get("time")).toBe(
      "2025-10-09T08:53:20Z",
    );
  });

  it("refuses an epoch-millisecond time before calling the network", async () => {
    liveEnv();
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(getOhlcvAt("SUI", "1760000000000", "1h")).rejects.toBeInstanceOf(TatumError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when the published candle does not contain the requested time", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(candle), { status: 200 })) as typeof fetch;
    await expect(getOhlcvAt("BTC", "2026-10-21T00:00:00.000Z", "1h")).resolves.toBeNull();
  });

  it("returns undefined on 404 and does not retry", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(getOhlcvAt("SUI", OPEN, "1h")).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a replay fixture and does not fetch", async () => {
    vi.stubEnv("DEMO_MODE", "replay");
    resetEnvForTests();
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(getOhlcvAt("BTC", OPEN, "1h")).rejects.toBeInstanceOf(TatumError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("getOhlcvPage", () => {
  it("requests the batch endpoint and parses the published candle list", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(batch), { status: 200 })) as typeof fetch;

    const candles = await getOhlcvPage("BTC", new Date(candle.openTime).toISOString(), "1d", 3);

    expect(candles).toHaveLength(1);
    expect(candles?.[0]?.high).toBe(69830.69);
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(url).toContain("https://api.tatum.io/v4/data/rate/symbol/OHLCV/batch?");
    const query = queryOf(url);
    expect(query.get("numberOfCandles")).toBe("3");
    expect(query.get("interval")).toBe("1d");
    expect(query.get("timeFrom")).toBe("2026-02-15T00:00:00Z");
    expect(query.get("timeFrom")).not.toMatch(/^\d+$/);
    expect(url).not.toMatch(/[?&]timeFrom=\d+(?:&|$)/);
    expect(query.has("unixFrom")).toBe(false);
  });

  it("sends timeFrom for the live SUI hour as an ISO-8601 string", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([suiHour]), { status: 200 })) as typeof fetch;

    const candles = await getOhlcvPage("SUI", SUI_AT, "1h", 1);

    expect(candles?.[0]?.high).toBe(3.446);
    expect(candles?.[0]?.openTimeMs).toBe(1759996800000);
    const query = queryOf(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]));
    expect(query.get("timeFrom")).toBe("2025-10-09T08:00:00Z");
    expect(query.get("symbol")).toBe("SUI");
    expect(query.get("interval")).toBe("1h");
    expect(query.has("unixFrom")).toBe(false);
  });
});
