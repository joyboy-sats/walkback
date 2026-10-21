/**
 * The balance wire shape.
 *
 * `suix_getBalance` returns FLAT fields — `totalBalance`, `coinType`,
 * `coinObjectCount` — not a nested `balance` object. An earlier version of
 * `getBalance` read `result.balance.balance`, which is `undefined` on every
 * real response, so every address parsed as holding zero and every balance
 * claim adjudicated `false`.
 *
 * The fixture below is the live response captured from
 * `https://sui-mainnet.gateway.tatum.io`, trimmed to the fields we read.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  TatumError,
  combineReplaySides,
  parseBalanceResponse,
  replayTruncated,
  type RawBalance,
  type TransactionBlock,
} from "./tatum";

/** Captured from the live gateway for a non-zero address. */
const LIVE_RESPONSE: RawBalance & Record<string, unknown> = {
  coinType: "0x2::sui::SUI",
  coinObjectCount: 8781,
  totalBalance: "2400568446767",
  lockedBalance: {},
  fundsInAddressBalance: "0",
};

describe("parseBalanceResponse", () => {
  it("reads totalBalance from the flat shape", () => {
    const parsed = parseBalanceResponse(LIVE_RESPONSE, "0x2::sui::SUI");
    expect(parsed.balance).toBe("2400568446767");
    expect(parsed.coinType).toBe("0x2::sui::SUI");
    expect(parsed.coinObjectCount).toBe(8781);
  });

  it("does not return zero for a funded address", () => {
    // The exact regression: a nested-shape reader returns "0" here.
    const parsed = parseBalanceResponse(LIVE_RESPONSE, "0x2::sui::SUI");
    expect(parsed.balance).not.toBe("0");
    expect(BigInt(parsed.balance)).toBeGreaterThan(0n);
  });

  it("keeps a genuine zero balance as zero, not an error", () => {
    const parsed = parseBalanceResponse(
      { coinType: "0x2::sui::SUI", coinObjectCount: 0, totalBalance: "0" },
      "0x2::sui::SUI",
    );
    expect(parsed.balance).toBe("0");
  });

  it("falls back to the requested coin type when the node omits it", () => {
    const parsed = parseBalanceResponse({ totalBalance: "5" }, "0xabc::tok::TOK");
    expect(parsed.coinType).toBe("0xabc::tok::TOK");
  });

  it("throws rather than guessing zero when the shape is unknown", () => {
    // A nested `{ balance: { balance } }` response — what the old code assumed.
    const nested = { balance: { balance: "123" } } as unknown as RawBalance;
    expect(() => parseBalanceResponse(nested, "0x2::sui::SUI")).toThrow(TatumError);
  });

  it("throws on an empty result", () => {
    expect(() => parseBalanceResponse(null, "0x2::sui::SUI")).toThrow(TatumError);
    expect(() => parseBalanceResponse(undefined, "0x2::sui::SUI")).toThrow(TatumError);
  });
});

function block(digest: string, timestamp: string): TransactionBlock {
  return { digest, timestamp, balanceChanges: [] };
}

describe("replayTruncated", () => {
  const since = "2026-10-20T10:00:00.000Z";

  it("treats a page that already walked past the window as complete", () => {
    expect(
      replayTruncated({
        hasNextPage: true,
        oldestTimestamp: "2026-10-20T09:00:00.000Z",
        sinceIso: since,
      }),
    ).toBe(false);
  });

  it("stays truncated when the page cap is still inside the window", () => {
    expect(
      replayTruncated({
        hasNextPage: true,
        oldestTimestamp: "2026-10-20T11:00:00.000Z",
        sinceIso: since,
      }),
    ).toBe(true);
    expect(replayTruncated({ hasNextPage: true, sinceIso: since })).toBe(true);
  });

  it("is complete when the node has no further page", () => {
    expect(
      replayTruncated({
        hasNextPage: false,
        oldestTimestamp: "2026-10-20T11:00:00.000Z",
        sinceIso: since,
      }),
    ).toBe(false);
  });
});

describe("combineReplaySides", () => {
  it("keeps one copy of a digest and truncates if either side is still inside the window", () => {
    const since = "2026-10-20T10:00:00.000Z";
    const shared = block("shared", "2026-10-20T12:00:00.000Z");
    const merged = combineReplaySides(
      [
        {
          blocks: [shared, block("out", "2026-10-20T09:00:00.000Z")],
          hasNextPage: true,
        },
        {
          blocks: [shared, block("in", "2026-10-20T12:30:00.000Z")],
          hasNextPage: true,
        },
      ],
      since,
    );
    expect(merged.blocks.map((b) => b.digest)).toEqual(["shared", "out", "in"]);
    expect(merged.truncated).toBe(true);
  });

  it("is complete when both sides have walked past the window", () => {
    const since = "2026-10-20T10:00:00.000Z";
    const merged = combineReplaySides(
      [
        { blocks: [block("out", "2026-10-20T09:00:00.000Z")], hasNextPage: true },
        { blocks: [block("in", "2026-10-20T08:00:00.000Z")], hasNextPage: true },
      ],
      since,
    );
    expect(merged.truncated).toBe(false);
  });
});
