import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dbState = vi.hoisted(() => ({
  configureDbPool: vi.fn(),
  closeDb: vi.fn(async () => {}),
  getDb: vi.fn(),
}));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    schema: actual.schema,
    getDb: dbState.getDb,
    closeDb: dbState.closeDb,
    configureDbPool: dbState.configureDbPool,
  };
});

const ingestMocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  persistIngestWrites: vi.fn(),
  markSeedPostApplied: vi.fn(),
}));

vi.mock("./ingest", () => ingestMocks);

const resolveMocks = vi.hoisted(() => ({
  resolveDueClaims: vi.fn(),
}));

vi.mock("./resolve", () => resolveMocks);

import { DeadlineError } from "./bounded";
import type { IngestResult } from "./ingest";
import type { MemoryWrite, WriteObserver } from "./memwal";
import { SEED_LOCK_TIMEOUT_MS, SEED_STATEMENT_TIMEOUT_MS, runSeed } from "./seed-run";

const applied = new Set<string>();

function post(id: string, handle: string) {
  return {
    id,
    handle,
    platform: "x" as const,
    published_at: "2026-10-20T12:00:00.000Z",
    text: "SUI will trade above 2 USD.",
    source_url: `https://x.com/${handle}/status/1`,
    snapshot: null,
    claims: [
      {
        quote: "SUI will trade above 2 USD.",
        claim_type: "price_threshold" as const,
        params: { symbol: "SUI", quote: "USD", direction: "gte" as const, amount: "2" },
        deadline: "2026-10-30T00:00:00.000Z",
        confidence: 0.8,
      },
    ],
  };
}

const file = { posts: [post("post-a", "alpha"), post("post-b", "beta")] };

function stored(partial: Partial<IngestResult>): IngestResult {
  return {
    sourceId: "source-1",
    claimIds: [],
    claims: [],
    rejected: [],
    snapshot: null,
    memoryBlobIds: [],
    ...partial,
  };
}

function pending(postId: string): MemoryWrite[] {
  return [{ text: "memory", namespace: "walkback.claim", idempotencyKey: `claim:${postId}` }];
}

beforeEach(() => {
  applied.clear();
  dbState.configureDbPool.mockReset();
  dbState.getDb.mockReset();
  ingestMocks.ingest.mockReset();
  ingestMocks.persistIngestWrites.mockReset();
  ingestMocks.markSeedPostApplied.mockReset();
  resolveMocks.resolveDueClaims.mockReset();

  dbState.getDb.mockReturnValue({
    select(shape: Record<string, unknown>) {
      const keys = Object.keys(shape);
      return {
        from() {
          if (keys.includes("namespace")) {
            return Promise.resolve([{ namespace: "walkback.claim", blobId: "blob-1" }]);
          }
          if (keys.includes("handle")) {
            return Promise.resolve([{ handle: "alpha", score: 0.5, hits: 1, misses: 0 }]);
          }
          return Promise.resolve([{ synthetic: false }]);
        },
      };
    },
  });

  ingestMocks.ingest.mockImplementation(async (input: { externalId?: string }) => {
    const id = input.externalId ?? "";
    if (applied.has(id)) {
      return stored({ sourceId: `source-${id}`, skipped: "post marker is set; memories were persisted on an earlier run" });
    }
    return stored({
      sourceId: `source-${id}`,
      pendingWrites: pending(id),
      needsMarker: true,
    });
  });

  ingestMocks.markSeedPostApplied.mockImplementation(async (id: string) => {
    applied.add(id);
  });

  resolveMocks.resolveDueClaims.mockImplementation(
    async (_now: Date, _limit: number, hooks?: { onList?: (ids: string[]) => void }) => {
      hooks?.onList?.([]);
      return { reports: [], errors: [] };
    },
  );
});

describe("runSeed", () => {
  it("leaves the marker unset when a write times out, and a rerun writes that post then the one it skipped", async () => {
    const lines: string[] = [];
    let failedOnce = false;
    ingestMocks.persistIngestWrites.mockImplementation(async (writes: MemoryWrite[], observer?: WriteObserver) => {
      const write = writes[0]!;
      observer?.onStart?.(write);
      if (write.idempotencyKey === "claim:post-a" && !failedOnce) {
        failedOnce = true;
        throw new DeadlineError(`MemWal remember ${write.idempotencyKey}`, 240_000);
      }
      observer?.onDone?.(write, { blobId: "blob-1", elapsedMs: 25 });
      return ["blob-1"];
    });

    const first = await runSeed(file, { log: (line) => lines.push(line) });

    expect(first.ok).toBe(false);
    expect(applied.has("post-a")).toBe(false);
    expect(applied.has("post-b")).toBe(false);
    expect(ingestMocks.markSeedPostApplied).not.toHaveBeenCalled();
    expect(ingestMocks.ingest).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDueClaims).not.toHaveBeenCalled();
    expect(first.summary).toContain("post-a");
    expect(first.summary).toContain("timed out");
    expect(first.summary).toContain("not attempted");
    expect(first.summary).toContain("post-b");
    expect(first.summary).toContain("status     incomplete");
    expect(lines.some((line) => line.includes("post 1/2 post-a"))).toBe(true);
    expect(lines.some((line) => line.includes("write start claim:post-a"))).toBe(true);
    expect(lines.some((line) => line.includes("not attempted"))).toBe(true);
    expect(dbState.configureDbPool).toHaveBeenCalledWith({
      statementTimeoutMs: SEED_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: SEED_LOCK_TIMEOUT_MS,
      connectTimeoutSeconds: 30,
    });

    lines.length = 0;
    const second = await runSeed(file, { log: (line) => lines.push(line) });

    expect(second.ok).toBe(true);
    expect(second.summary).toContain("status     ok");
    expect(applied.has("post-a")).toBe(true);
    expect(applied.has("post-b")).toBe(true);
    const keys = ingestMocks.persistIngestWrites.mock.calls.map((call) => (call[0] as MemoryWrite[])[0]?.idempotencyKey);
    expect(keys).toEqual(["claim:post-a", "claim:post-a", "claim:post-b"]);
    expect(lines.some((line) => line.includes("write done claim:post-a blob=blob-1 25ms"))).toBe(true);
    expect(lines.some((line) => line.includes("resolve phase: 0 due claim(s)"))).toBe(true);
    expect(lines.some((line) => line.includes("post 2/2 post-b"))).toBe(true);
  });

  it("continues to the next post when a failure is not a timeout, and still does not mark the failed post", async () => {
    ingestMocks.persistIngestWrites.mockImplementation(async (writes: MemoryWrite[]) => {
      if (writes[0]?.idempotencyKey === "claim:post-a") throw new Error("database down");
      return ["blob-b"];
    });

    const result = await runSeed(file, { log: () => {} });

    expect(result.ok).toBe(false);
    expect(applied.has("post-a")).toBe(false);
    expect(applied.has("post-b")).toBe(true);
    expect(result.summary).toContain("database down");
    expect(result.summary).not.toContain("not attempted");
    expect(resolveMocks.resolveDueClaims).toHaveBeenCalledTimes(1);
  });
});
