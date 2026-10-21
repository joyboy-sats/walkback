import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resetEnvForTests } from "./env";
import { getRate } from "./tatum";

const realFetch = globalThis.fetch;

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

describe("getRate", () => {
  it("retries a 500 and returns the later price", async () => {
    liveEnv();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 500 });
      return new Response(JSON.stringify({ value: 1.5 }), { status: 200 });
    }) as typeof fetch;

    await expect(getRate("SUI", "USD")).resolves.toBe(1.5);
    expect(calls).toBe(2);
  });

  it("does not retry a 404 or a 400", async () => {
    liveEnv();
    globalThis.fetch = vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(getRate("SUI", "USD")).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 400 })) as typeof fetch;
    await expect(getRate("SUI", "USD")).rejects.toThrow(/rate http 400/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
