/**
 * Historical candles. The fixture is the HistoricalPrice body Tatum publishes
 * for GET /v4/data/rate/symbol/OHLCV. A live capture was not available in this
 * environment (no TATUM_API_KEY; the docs demo key returns 402). Nothing here
 * calls the network.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "./env";
import { getOhlcvAt, getOhlcvPage, TatumError } from "./tatum";

vi.mock("server-only", () => ({}));

const realFetch = globalThis.fetch;
const candle = JSON.parse(readFileSync("fixtures/tatum/ohlcv-btc-documented.json", "utf8"));
const batch = JSON.parse(readFileSync("fixtures/tatum/ohlcv-batch-btc-documented.json", "utf8"));
const OPEN = "2026-02-15T00:00:00.000Z";

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
    expect(url).toContain("symbol=BTC");
    expect(url).toContain("interval=1h");
    expect(url).toContain(`time=${encodeURIComponent(at)}`);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
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
    expect(url).toContain("numberOfCandles=3");
    expect(url).toContain("interval=1d");
    expect(url).toContain("timeFrom=");
  });
});
