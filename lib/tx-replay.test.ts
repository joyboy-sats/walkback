/**
 * Transaction replay against captured mainnet responses.
 *
 * The two voided @_OnChainWatch claims failed because
 * `suix_queryTransactionBlocks` with `showBalanceChanges` rejects the whole
 * page when the address index includes a digest the node cannot load
 * ("unable to derive balance/object changes because effect is empty").
 * The whale transfers themselves are on the same page and have effects.
 *
 * Fixtures are subsets of live responses from https://sui.api.onfinality.io/public.
 * Effect bodies are reduced to status; digests, timestamps, and balance
 * changes are as the node returned them. No test in this file calls the network.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  REPLAY_PAGE_OPTIONS,
  isPhantomTransaction,
  loadBalanceChanges,
  parseBalanceChanges,
  parseTransactionPage,
  sumBalanceChanges,
  type RawQueriedTransaction,
} from "./tatum";

const SUI = "0x2::sui::SUI";

function read(name: string): {
  data?: RawQueriedTransaction[];
  digest?: string;
  balanceChanges?: Parameters<typeof parseBalanceChanges>[0];
} {
  return JSON.parse(readFileSync(new URL(`../fixtures/sui/${name}`, import.meta.url), "utf8"));
}

function replay(input: {
  page: string;
  balances: string;
  address: string;
  since: string;
  until: string;
  amount: bigint;
}) {
  const page = read(input.page);
  const parsed = parseTransactionPage(page);
  const balances = read(input.balances);
  const changes = parseBalanceChanges(
    balances.balanceChanges as Parameters<typeof parseBalanceChanges>[0],
  );
  const blocks = parsed.blocks.map((block) =>
    block.digest === balances.digest ? { ...block, balanceChanges: changes } : block,
  );
  const summed = sumBalanceChanges(blocks, input.address, SUI, input.since, input.until);
  const magnitude = summed.net < 0n ? -summed.net : summed.net;
  return { parsed, magnitude, sampledBlocks: summed.sampledBlocks, digest: String(balances.digest) };
}

describe("REPLAY_PAGE_OPTIONS", () => {
  it("does not ask the page for balance changes", () => {
    expect(REPLAY_PAGE_OPTIONS).toEqual({ showEffects: true });
    expect(REPLAY_PAGE_OPTIONS).not.toHaveProperty("showBalanceChanges");
  });
});

describe("voided whale pages", () => {
  it("drops the effect-less digest and still sees the 5,350,853 SUI send", () => {
    const page = read("page-2112452984638444019.json");
    const rows = page.data as RawQueriedTransaction[];
    const phantom = rows.find((row) => row.digest === "n5E9cBinnBVwRTU4crMsckMsjPwnQtAXvhU3Fx5Hnuk");
    expect(phantom && isPhantomTransaction(phantom)).toBe(true);

    const result = replay({
      page: "page-2112452984638444019.json",
      balances: "balances-8sZHBfidLgz3WD9QGB3YLk2PhJNY6CiG8eHav1vPmuB4.json",
      address: "0x20e2c51ca852c8bc959eccf9e64c3083cba892dea64052c4d111247b9abae450",
      since: "2026-10-20T07:43:00.000Z",
      until: "2026-10-20T07:58:00.000Z",
      amount: 5350853000000000n,
    });

    expect(result.parsed.droppedPhantoms).toBe(1);
    expect(result.parsed.blocks.map((block) => block.digest)).not.toContain(
      "n5E9cBinnBVwRTU4crMsckMsjPwnQtAXvhU3Fx5Hnuk",
    );
    expect(result.parsed.blocks.map((block) => block.digest)).toContain(result.digest);
    expect(result.sampledBlocks).toBe(1);
    expect(result.magnitude).toBeGreaterThanOrEqual(5350853000000000n);
  });

  it("drops the effect-less digest and still sees the 1,965,693 SUI send", () => {
    const result = replay({
      page: "page-2112436525434622020.json",
      balances: "balances-4iUpYAtVSdHcPRRPJVVt3Gr5mZM3p3DHE2aPeWPg2eAJ.json",
      address: "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad",
      since: "2026-10-20T06:02:00.000Z",
      until: "2026-10-20T06:52:00.000Z",
      amount: 1965693000000000n,
    });

    expect(result.parsed.droppedPhantoms).toBe(1);
    expect(result.sampledBlocks).toBe(1);
    expect(result.magnitude).toBeGreaterThanOrEqual(1965693000000000n);
  });

  it("still counts the Bybit outflow that production resolved true", () => {
    const result = replay({
      page: "page-2109915055093399909.json",
      balances: "balances-4n92s4UZircMuvPVmD7tJXrP4fJTuySoLFF8kuWBcCUH.json",
      address: "0x376afef39c3016ed9459e149f3cda2dcb5d9a0d4ef189d84b9b70060c30471da",
      since: "2026-10-13T07:40:00.000Z",
      until: "2026-10-13T07:54:00.000Z",
      amount: 2344991000000000n,
    });

    expect(result.parsed.droppedPhantoms).toBe(0);
    expect(result.sampledBlocks).toBe(1);
    expect(result.magnitude).toBe(2344991222286060n);
  });
});

describe("loadBalanceChanges", () => {
  it("keeps the readable digest when a batch fails on an effect-less neighbour", async () => {
    const good = "8sZHBfidLgz3WD9QGB3YLk2PhJNY6CiG8eHav1vPmuB4";
    const phantom = "n5E9cBinnBVwRTU4crMsckMsjPwnQtAXvhU3Fx5Hnuk";
    const balances = read("balances-8sZHBfidLgz3WD9QGB3YLk2PhJNY6CiG8eHav1vPmuB4.json");

    const loaded = await loadBalanceChanges([good, phantom], async (digests) => {
      if (digests.includes(phantom)) {
        throw new Error(
          'ErrorObject { code: InvalidParams, message: "unable to derive balance/object changes because effect is empty", data: None }',
        );
      }
      return [balances as RawQueriedTransaction];
    });

    expect(loaded.unreadable).toEqual([phantom]);
    expect(loaded.changes.get(good)?.[0]?.amount).toBe("-5350853620088099");
  });
});
