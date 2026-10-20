import { describe, expect, it } from "vitest";
import { authorizeBearer, corsHeaders } from "./api-auth";

const SECRET = "test-secret-value";

describe("authorizeBearer", () => {
  it("accepts the exact bearer token", () => {
    expect(authorizeBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing header, a wrong token, and a different length", () => {
    expect(authorizeBearer(undefined, SECRET)).toBe(false);
    expect(authorizeBearer("Bearer wrong-secret-value", SECRET)).toBe(false);
    expect(authorizeBearer("Bearer short", SECRET)).toBe(false);
    expect(authorizeBearer(SECRET, SECRET)).toBe(false);
    expect(authorizeBearer(`Bearer ${SECRET}`, "")).toBe(false);
  });
});

describe("corsHeaders", () => {
  const allowed = ["https://walkback.vercel.app"];

  it("reflects only the configured origin", () => {
    const ok = corsHeaders("https://walkback.vercel.app", allowed);
    expect(ok["access-control-allow-origin"]).toBe("https://walkback.vercel.app");
    expect(ok["access-control-allow-methods"]).toContain("POST");

    const blocked = corsHeaders("https://evil.example", allowed);
    expect(blocked["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds no allow-origin when the caller is not a browser", () => {
    expect(corsHeaders(undefined, allowed)["access-control-allow-origin"]).toBeUndefined();
  });
});
