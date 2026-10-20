/**
 * The five ways a check can fail, and the rule that none of them is a lie.
 *
 * `lib/tatum` is mocked. Nothing here touches the network. `now` is injected
 * so a deadline is either past or future for the whole file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("./tatum", () => {
  class TatumError extends Error {
    code?: number;
    method?: string;
    constructor(message: string, code?: number, method?: string) {
      super(message);
      this.name = "TatumError";
      this.code = code;
      this.method = method;
    }
  }
  return {
    TatumError,
    getBalance: vi.fn(),
    getRate: vi.fn(),
    netChangeInWindow: vi.fn(),
  };
});

import { adjudicate, type AdjudicationInput } from "./adjudicate";
import { applyOutcome, computeScore } from "./score";
import { getBalance, getRate, netChangeInWindow, TatumError } from "./tatum";
import type { Verdict } from "./types";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";

const ADDRESS = "0xabc";
const ASSET = "0x2::sui::SUI";

function expectVoidLeavesScore(verdict: Verdict) {
  expect(verdict.outcome).toBe("void");
  const before = computeScore(4, 1);
  const after = applyOutcome(before.hits, before.misses, verdict.outcome);
  expect(after).toEqual(before);
  expect(after.hits).toBe(before.hits);
  expect(after.misses).toBe(before.misses);
  expect(after.score).toBe(before.score);
}

describe("adjudicate voids", () => {
  beforeEach(() => {
    vi.mocked(getBalance).mockReset();
    vi.mocked(getRate).mockReset();
    vi.mocked(netChangeInWindow).mockReset();
  });

  it("voids a balance change that has no snapshot, and says the receipt is missing", async () => {
    const verdict = await adjudicate(
      input({
        claimType: "balance_change_since_ingest",
        params: { address: ADDRESS, asset: ASSET, direction: "gte", amount: "1000000000" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toContain("receipt");
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("voids a claim whose deadline is still in the future", async () => {
    const verdict = await adjudicate(
      input({
        claimType: "balance_threshold",
        params: { address: ADDRESS, asset: ASSET, direction: "gte", amount: "1" },
        snapshot: null,
        deadline: FUTURE,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toContain("deadline");
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("voids when Tatum throws, and does not record a miss", async () => {
    vi.mocked(getBalance).mockRejectedValue(new TatumError("gateway down"));

    const verdict = await adjudicate(
      input({
        claimType: "balance_threshold",
        params: { address: ADDRESS, asset: ASSET, direction: "gte", amount: "1" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason).toContain("gateway down");
    expect(verdict.outcome).not.toBe("false");
  });

  it("voids a price claim when the rate pair is unsupported", async () => {
    vi.mocked(getRate).mockResolvedValue(undefined);

    const verdict = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "3" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toMatch(/does not cover|unsupported/);
  });

  it("voids a truncated transaction replay, because a floor is not a verdict", async () => {
    vi.mocked(netChangeInWindow).mockResolvedValue({
      net: "100",
      sampledBlocks: 50,
      truncated: true,
    });

    const verdict = await adjudicate(
      input({
        claimType: "tx_replay",
        params: {
          address: ADDRESS,
          asset: ASSET,
          since: "2026-09-01T00:00:00.000Z",
          until: "2026-09-15T00:00:00.000Z",
          direction: "gte",
          amount: "1",
        },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toMatch(/unknown|no verdict/);
  });

  it("voids a placeholder address instead of trusting a zero balance", async () => {
    const placeholder = `0x${"1".repeat(64)}`;
    vi.mocked(getBalance).mockResolvedValue({ balance: "0", coinType: ASSET });

    const verdict = await adjudicate(
      input({
        claimType: "balance_threshold",
        params: { address: placeholder, asset: ASSET, direction: "gte", amount: "1" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toContain("placeholder");
    expect(verdict.outcome).not.toBe("false");
    expect(getBalance).not.toHaveBeenCalled();
  });
});

function input(partial: AdjudicationInput): AdjudicationInput {
  return partial;
}
