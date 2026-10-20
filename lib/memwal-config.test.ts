import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMemwalConfig, requireMemwalConfig } from "./memwal-config";

const ACCOUNT = `0x${"ab".repeat(32)}`;
const KEY = "c".repeat(64);
const SERVER = "https://relayer.memory.walrus.xyz";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseMemwalConfig", () => {
  it("accepts only the three MemWal vars when Tatum is empty and DATABASE_URL is not a url", () => {
    const config = parseMemwalConfig({
      MEMWAL_ACCOUNT_ID: ACCOUNT,
      MEMWAL_PRIVATE_KEY: KEY,
      MEMWAL_SERVER_URL: SERVER,
      TATUM_API_KEY: "",
      DATABASE_URL: "postgres://user:p@ss word@internal/walkback",
      DEMO_MODE: "live",
    });
    expect(config).toEqual({ accountId: ACCOUNT, privateKey: KEY, serverUrl: SERVER });
  });

  it("defaults the mainnet relayer when the server url is omitted", () => {
    const config = parseMemwalConfig({
      MEMWAL_ACCOUNT_ID: ACCOUNT,
      MEMWAL_PRIVATE_KEY: KEY,
    });
    expect(config.serverUrl).toBe(SERVER);
  });

  it("rejects a staging relayer and does not echo the private key", () => {
    expect(() =>
      parseMemwalConfig({
        MEMWAL_ACCOUNT_ID: ACCOUNT,
        MEMWAL_PRIVATE_KEY: KEY,
        MEMWAL_SERVER_URL: "https://relayer-staging.memory.walrus.xyz",
      }),
    ).toThrow(/staging/);
    try {
      parseMemwalConfig({ MEMWAL_PRIVATE_KEY: KEY });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).not.toContain("TATUM");
      expect((err as Error).message).not.toContain("DATABASE_URL");
    }
  });
});

describe("requireMemwalConfig", () => {
  it("runs from process.env with only the three MemWal vars", () => {
    vi.stubEnv("MEMWAL_ACCOUNT_ID", ACCOUNT);
    vi.stubEnv("MEMWAL_PRIVATE_KEY", KEY);
    vi.stubEnv("MEMWAL_SERVER_URL", SERVER);
    vi.stubEnv("TATUM_API_KEY", "");
    vi.stubEnv("DATABASE_URL", "not-a-url");
    expect(requireMemwalConfig()).toEqual({
      accountId: ACCOUNT,
      privateKey: KEY,
      serverUrl: SERVER,
    });
  });
});
