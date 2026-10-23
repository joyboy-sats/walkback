import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimExternalId, stableUuid } from "./ids";

const STUCK = "b3cfb240-691d-826f-72e1-1695f7e46335";

describe("candidate handle spellings", () => {
  const file = JSON.parse(readFileSync(new URL("../data/claims.json", import.meta.url), "utf8")) as {
    posts: Array<{ id: string; handle: string; source_url: string }>;
  };

  it("hashes the ingested mrcamerontrader post, not the extra-r spelling", () => {
    const post = file.posts.find((row) => row.id === "x-mrcamerontrader-2107077951863099625");
    expect(post?.handle).toBe("mrcamerontrader");
    expect(post?.source_url).toBe("https://x.com/mrcamerontrader/status/2107077951863099625");
    expect(stableUuid(claimExternalId("x-mrcamerontrader-2107077951863099625", 0))).toBe(STUCK);
    expect(stableUuid(claimExternalId("x-mrcameronrtrader-2107077951863099625", 0))).not.toBe(STUCK);
  });

  it("keeps WaheiMagokoro with a letter i", () => {
    const post = file.posts.find((row) => row.id === "x-waheimagokoro-2112064956904710279");
    expect(post?.handle).toBe("WaheiMagokoro");
    expect(post?.source_url).toBe("https://x.com/WaheiMagokoro/status/2112064956904710279");
    expect(file.posts.some((row) => row.handle === "Wahe1Magokoro" || row.handle === "mrcameronrtrader")).toBe(false);
  });
});
