import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const budget = vi.hoisted(() => ({
  acquireSharedWriteBudget: vi.fn(async (_cost?: number) => {}),
}));
vi.mock("./write-budget", () => budget);

const memwalMock = vi.hoisted(() => {
  const recall = vi.fn();
  const create = vi.fn(() => ({ recall, destroy: vi.fn() }));
  return { recall, create };
});

vi.mock("@mysten-incubation/memwal", () => ({
  MemWal: { create: memwalMock.create },
}));

import { destroyMemwal, recallMemory } from "./memwal";
import { memwalWriteLimiter, RECALL_REQUEST_WEIGHT } from "./ratelimit";
import { NS } from "./types";

afterEach(() => {
  destroyMemwal();
  memwalWriteLimiter.fill();
  budget.acquireSharedWriteBudget.mockReset();
  memwalMock.recall.mockReset();
  delete process.env.MEMWAL_ACCOUNT_ID;
  delete process.env.MEMWAL_PRIVATE_KEY;
  delete process.env.MEMWAL_SERVER_URL;
});

function allowClient(): void {
  process.env.MEMWAL_ACCOUNT_ID = `0x${"ab".repeat(32)}`;
  process.env.MEMWAL_PRIVATE_KEY = "c".repeat(64);
  process.env.MEMWAL_SERVER_URL = "https://relayer.memory.walrus.xyz";
}

describe("recallMemory", () => {
  it("charges the shared budget before the recall and lets a 429 throw", async () => {
    allowClient();
    const order: string[] = [];
    budget.acquireSharedWriteBudget.mockImplementation(async (cost) => {
      order.push(`budget:${cost}`);
    });
    memwalMock.recall.mockImplementation(async () => {
      order.push("recall");
      return { results: [{ blob_id: "blob-1", text: "hello", distance: 0.1 }] };
    });

    const hits = await recallMemory({ query: "Walkback", namespace: NS.resolution, limit: 20 });
    expect(hits).toEqual([{ blobId: "blob-1", text: "hello", distance: 0.1 }]);
    expect(order).toEqual([`budget:${RECALL_REQUEST_WEIGHT}`, "recall"]);
    expect(RECALL_REQUEST_WEIGHT).toBe(1);

    memwalMock.recall.mockRejectedValueOnce(
      Object.assign(new Error("Walrus Memory server error (429): rate limited"), { status: 429 }),
    );
    await expect(recallMemory({ query: "Walkback", namespace: NS.resolution })).rejects.toThrow(/429/);
  });
});
