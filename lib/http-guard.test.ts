import { describe, expect, it } from "vitest";
import { corsHeaders, tokenMatches } from "./http-guard";

const SECRET = "test-secret-value";

describe("tokenMatches", () => {
  it("accepts the exact admin token", () => {
    expect(tokenMatches(SECRET, SECRET)).toBe(true);
  });

  it("rejects a missing header, a wrong token, and a different length", () => {
    expect(tokenMatches(undefined, SECRET)).toBe(false);
    expect(tokenMatches("wrong-secret-value", SECRET)).toBe(false);
    expect(tokenMatches("short", SECRET)).toBe(false);
    expect(tokenMatches(`Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(tokenMatches(SECRET, "")).toBe(false);
  });
});

describe("corsHeaders", () => {
  const allowed = ["https://walkback.vercel.app"];

  it("reflects only the configured origin", () => {
    const ok = corsHeaders("https://walkback.vercel.app", allowed);
    expect(ok["access-control-allow-origin"]).toBe("https://walkback.vercel.app");
    expect(ok["access-control-allow-headers"]).toContain("x-admin-token");

    const blocked = corsHeaders("https://evil.example", allowed);
    expect(blocked["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds no allow-origin when the caller is not a browser", () => {
    expect(corsHeaders(undefined, allowed)["access-control-allow-origin"]).toBeUndefined();
  });
});
