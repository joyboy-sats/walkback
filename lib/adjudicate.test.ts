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
    getOhlcvAt: vi.fn(),
    getOhlcvPage: vi.fn(),
    netChangeInWindow: vi.fn(),
  };
});

import { adjudicate, type AdjudicationInput } from "./adjudicate";
import { INTERVAL_MS, type PriceCandle } from "./price-candle";
import { applyOutcome, computeScore } from "./score";
import { getBalance, getOhlcvAt, getOhlcvPage, netChangeInWindow, TatumError } from "./tatum";
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
    vi.mocked(getOhlcvAt).mockReset();
    vi.mocked(getOhlcvPage).mockReset();
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
    vi.mocked(getOhlcvAt).mockResolvedValue(undefined);

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
    expect(getOhlcvAt).toHaveBeenCalledWith("SUI", PAST, "1h");
    expect(getOhlcvPage).not.toHaveBeenCalled();
  });

  it("judges a past deadline against that deadline, not against when the worker runs", async () => {
    const open = Date.parse("2024-06-01T00:00:00.000Z");
    vi.mocked(getOhlcvAt).mockResolvedValue(hourCandle(open, 1.4, 1.1, 1.25, "SOL"));

    const first = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "SOL", quote: "USD", direction: "gte", amount: "1.2", evaluation: "at_deadline" },
        snapshot: null,
        deadline: "2024-06-01T00:00:00.000Z",
        deadlineBasis: "stated in post",
      }),
      NOW,
    );
    const later = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "SOL", quote: "USD", direction: "gte", amount: "1.2", evaluation: "at_deadline" },
        snapshot: null,
        deadline: "2024-06-01T00:00:00.000Z",
      }),
      new Date("2027-01-01T00:00:00.000Z"),
    );

    expect(first.outcome).toBe("true");
    expect(later.outcome).toBe("true");
    expect(first.reason).toBe(later.reason);
    expect(first.reason).toContain("Tatum SOL/USD 1h open was 1.25");
    expect(first.reason).toContain("2024-06-01T00:00:00.000Z");
    expect(first.evidence).toMatchObject({
      source: "tatum:/v4/data/rate/symbol/OHLCV",
      interval: "1h",
      deadlineBasis: "stated in post",
      extreme: { value: 1.25, field: "open", at: "2024-06-01T00:00:00.000Z" },
    });
    for (const call of vi.mocked(getOhlcvAt).mock.calls) {
      expect(call[1]).toBe("2024-06-01T00:00:00.000Z");
    }
  });

  it("treats a stored price claim with no evaluation as the deadline print", async () => {
    const open = Date.parse(PAST);
    vi.mocked(getOhlcvAt).mockResolvedValue(hourCandle(open, 2, 1, 1.5, "BTC"));

    const verdict = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "BTC", quote: "USD", direction: "lte", amount: "1.4" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expect(verdict.outcome).toBe("false");
    expect(verdict.reason.toLowerCase()).toContain("no evaluation was stored");
    expect(verdict.evidence).toMatchObject({ evaluation: "at_deadline", evaluationDefaulted: true });
    expect(getOhlcvPage).not.toHaveBeenCalled();
  });

  it("checks a touch against the window high and ignores the clock", async () => {
    const since = "2026-09-01T00:00:00.000Z";
    const deadline = "2026-09-04T00:00:00.000Z";
    vi.mocked(getOhlcvPage).mockImplementation(async (_symbol, from, interval) => {
      expect(interval).toBe("1d");
      const start = Date.parse(from);
      return [0, 1, 2]
        .map((i) => dayCandle(Date.parse(since) + i * INTERVAL_MS["1d"], i === 1 ? 2.4 : 1.2, 1, "ETH"))
        .filter((item) => item.openTimeMs >= start);
    });

    const params = {
      symbol: "ETH",
      quote: "USD",
      direction: "gte" as const,
      amount: "2",
      evaluation: "touch" as const,
      since,
    };
    const early = await adjudicate(
      input({ claimType: "price_threshold", params, snapshot: null, deadline }),
      new Date("2026-09-05T00:00:00.000Z"),
    );
    const late = await adjudicate(
      input({ claimType: "price_threshold", params, snapshot: null, deadline }),
      new Date("2027-04-01T00:00:00.000Z"),
    );

    expect(early.outcome).toBe("true");
    expect(late.outcome).toBe(early.outcome);
    expect(late.reason).toBe(early.reason);
    expect(early.reason).toContain("1d high was 2.4");
    expect(early.reason).toContain(since);
    expect(early.evidence).toMatchObject({
      interval: "1d",
      window: { from: since, to: deadline },
      extreme: { field: "high", value: 2.4 },
    });
    expect(getOhlcvAt).not.toHaveBeenCalled();
  });

  it("voids a touch that has no publish time, and a price quote other than USD", async () => {
    const missingStart = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "2", evaluation: "touch" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );
    expectVoidLeavesScore(missingStart);
    expect(missingStart.reason.toLowerCase()).toContain("published");
    expect(getOhlcvPage).not.toHaveBeenCalled();

    const eur = await adjudicate(
      input({
        claimType: "price_threshold",
        params: { symbol: "SUI", quote: "EUR", direction: "gte", amount: "2", evaluation: "at_deadline" },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );
    expectVoidLeavesScore(eur);
    expect(eur.reason).toContain("USD");
    expect(getOhlcvAt).not.toHaveBeenCalled();
  });

  it("voids a truncated transaction replay, because a floor is not a verdict", async () => {
    vi.mocked(netChangeInWindow).mockResolvedValue({
      net: "100",
      sampledBlocks: 50,
      truncated: true,
      unreadableDigests: [],
      droppedPhantoms: 0,
      digests: [],
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

  it("voids an empty-effect RPC error in plain language, and does not call it a lie", async () => {
    vi.mocked(netChangeInWindow).mockRejectedValue(
      new TatumError(
        'ErrorObject { code: InvalidParams, message: "unable to derive balance/object changes because effect is empty", data: None }',
      ),
    );

    const verdict = await adjudicate(
      input({
        claimType: "tx_replay",
        params: {
          address: ADDRESS,
          asset: ASSET,
          since: "2026-10-20T07:43:00.000Z",
          until: "2026-10-20T07:58:00.000Z",
          direction: "gte",
          amount: "5350853000000000",
        },
        snapshot: null,
        deadline: PAST,
      }),
      NOW,
    );

    expectVoidLeavesScore(verdict);
    expect(verdict.reason.toLowerCase()).toContain("no effects");
    expect(verdict.reason.toLowerCase()).not.toMatch(/lied|false/);
    expect(verdict.reason).not.toContain("ErrorObject");
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

function dayCandle(openMs: number, high: number, low: number, symbol = "SUI"): PriceCandle {
  const closeTimeMs = openMs + INTERVAL_MS["1d"] - 1;
  return {
    symbol,
    openTimeMs: openMs,
    closeTimeMs,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(closeTimeMs).toISOString(),
    open: low,
    high,
    low,
    close: (high + low) / 2,
  };
}

function hourCandle(openMs: number, high: number, low: number, open = low, symbol = "SUI"): PriceCandle {
  const closeTimeMs = openMs + INTERVAL_MS["1h"] - 1;
  return {
    symbol,
    openTimeMs: openMs,
    closeTimeMs,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(closeTimeMs).toISOString(),
    open,
    high,
    low,
    close: (high + low) / 2,
  };
}
