import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const memwalMock = vi.hoisted(() => {
  const rememberAndWait = vi.fn();
  const created: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const create = vi.fn(() => {
    const destroy = vi.fn();
    const client = { rememberAndWait, destroy };
    created.push(client);
    return client;
  });
  return { rememberAndWait, created, create };
});

vi.mock("@mysten-incubation/memwal", () => ({
  MemWal: { create: memwalMock.create },
}));

import { destroyMemwal, writeMemory, type MemoryWrite } from "./memwal";

const write: MemoryWrite = {
  text: "hello",
  namespace: "walkback.claim",
  idempotencyKey: "claim:1",
};

const fast = {
  timeoutMs: 40,
  backoffMs: 0,
  sleep: async () => {},
};

afterEach(() => {
  destroyMemwal();
  memwalMock.rememberAndWait.mockReset();
  memwalMock.create.mockClear();
  memwalMock.created.length = 0;
  delete process.env.MEMWAL_ACCOUNT_ID;
  delete process.env.MEMWAL_PRIVATE_KEY;
  delete process.env.MEMWAL_SERVER_URL;
});

function allowClient(): void {
  process.env.MEMWAL_ACCOUNT_ID = `0x${"ab".repeat(32)}`;
  process.env.MEMWAL_PRIVATE_KEY = "c".repeat(64);
  process.env.MEMWAL_SERVER_URL = "https://relayer.memory.walrus.xyz";
}

describe("writeMemory", () => {
  it("times out a call that never settles, aborts its fetch, and retries on a new client with the same key", async () => {
    allowClient();
    const realFetch = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    memwalMock.rememberAndWait.mockImplementationOnce(() => fetch("https://relayer.memory.walrus.xyz/api/remember"));
    memwalMock.rememberAndWait.mockImplementationOnce(async () => ({
      id: "job-1",
      blob_id: "blob-1",
      owner: "owner",
      namespace: "walkback.claim",
    }));

    try {
      const result = await writeMemory(write, { ...fast, attempts: 2 });
      expect(result.blobId).toBe("blob-1");
      expect(signal?.aborted).toBe(true);
      expect(memwalMock.create).toHaveBeenCalledTimes(2);
      expect(memwalMock.created[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(memwalMock.rememberAndWait).toHaveBeenCalledTimes(2);
      for (const call of memwalMock.rememberAndWait.mock.calls) {
        expect(call[2]).toMatchObject({ idempotencyKey: "claim:1", timeoutMs: 180_000 });
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not retry a non-retryable relayer error", async () => {
    allowClient();
    memwalMock.rememberAndWait.mockRejectedValueOnce(Object.assign(new Error("bad text"), { status: 400 }));
    await expect(writeMemory(write, { ...fast, attempts: 3 })).rejects.toThrow(/bad text/);
    expect(memwalMock.rememberAndWait).toHaveBeenCalledTimes(1);
    expect(memwalMock.create).toHaveBeenCalledTimes(1);
    expect(memwalMock.created[0]?.destroy).not.toHaveBeenCalled();
  });
});
