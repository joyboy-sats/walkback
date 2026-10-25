import { describe, expect, it } from "vitest";
import { claimExternalId } from "./ids";
import { seedPublishedAt } from "./post-time";

describe("seedPublishedAt", () => {
  it("reads Wahei's post time from the seed file", () => {
    const id = claimExternalId("x-waheimagokoro-2112064956904710279", 0);
    expect(seedPublishedAt(id, null)).toBe("2026-10-19T06:15:00.000Z");
    expect(seedPublishedAt(null, "https://x.com/WaheiMagokoro/status/2112064956904710279")).toBe(
      "2026-10-19T06:15:00.000Z",
    );
  });

  it("returns null when the claim is not in the seed file", () => {
    expect(seedPublishedAt("post:missing:0", "https://x.com/missing/status/1")).toBeNull();
    expect(seedPublishedAt(null, null)).toBeNull();
  });
});
