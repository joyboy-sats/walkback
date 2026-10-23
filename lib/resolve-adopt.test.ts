import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLAIM_ID = "b3cfb240-691d-826f-72e1-1695f7e46335";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

const state = {
  resolutions: [] as Array<Record<string, unknown>>,
  blobs: [] as Array<{ blobId: string }>,
  versions: [] as Array<{ version: number; score: number }>,
};

const inserts: Array<{ values: Record<string, unknown> }> = [];
const updates: Array<Record<string, unknown>> = [];

function chain(rows: unknown) {
  const query: Record<string, unknown> = {};
  const self = () => query;
  query.from = self;
  query.innerJoin = self;
  query.where = self;
  query.orderBy = self;
  query.limit = self;
  query.for = self;
  query.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return query;
}

const dbState = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { schema: actual.schema, getDb: dbState.getDb };
});

const adjudicateMock = vi.hoisted(() => vi.fn());
vi.mock("./adjudicate", () => ({ adjudicate: adjudicateMock }));

const memwalMock = vi.hoisted(() => ({
  recallMemory: vi.fn(),
  writeMemoriesDurable: vi.fn(),
}));
vi.mock("./memwal", () => memwalMock);

const persistedMock = vi.hoisted(() => ({ findPersistedKeys: vi.fn(async () => new Set<string>()) }));
vi.mock("./persisted-keys", () => persistedMock);

const logMock = vi.hoisted(() => ({ logMemories: vi.fn(async () => {}) }));
vi.mock("./memory-log", () => logMock);

import { resolveClaim } from "./resolve";

function legacy(outcome: "false" | "void"): string {
  return (
    `[RESOLUTION] mrcamerontrader claimed "SUI above 1.29" (price_threshold, resolved 2026-10-23). ` +
    `VERDICT: ${outcome.toUpperCase()}. stored reason\n\n` +
    "```json\n" +
    JSON.stringify({
      kind: "resolution",
      claim_id: CLAIM_ID,
      outcome,
      reason: "stored reason",
      evidence: { windowHigh: "1.07" },
      resolved_at: "2026-10-23T12:00:00.000Z",
    }) +
    "\n```"
  );
}

function hit(outcome: "false" | "void", blobId = "blob-old") {
  return {
    blobId,
    text: legacy(outcome),
    distance: 0.01,
    createdAt: "2026-10-23T12:00:01.000Z",
  };
}

const claimRow = {
  claim: {
    id: CLAIM_ID,
    quote: "SUI above 1.29",
    claimType: "price_threshold",
    params: { symbol: "SUI", quote: "USD", direction: "gte", amount: "1.29", evaluation: "touch" },
    deadline: new Date("2026-10-12T11:58:25.000Z"),
    deadlineBasis: "benchmark convention: trade setup states no deadline; 7 days after publish",
    confidence: 0.85,
    snapshot: null,
    synthetic: false,
    externalId: "post:x-mrcamerontrader-2107077951863099625:0",
  },
  source: {
    id: SOURCE_ID,
    handle: "mrcamerontrader",
    hits: 2,
    misses: 0,
    score: 0.34,
  },
};

beforeEach(() => {
  state.resolutions = [];
  state.blobs = [];
  state.versions = [];
  inserts.length = 0;
  updates.length = 0;
  adjudicateMock.mockReset();
  memwalMock.recallMemory.mockReset();
  memwalMock.writeMemoriesDurable.mockReset();
  persistedMock.findPersistedKeys.mockReset();
  persistedMock.findPersistedKeys.mockResolvedValue(new Set());
  logMock.logMemories.mockClear();

  const select = (shape?: Record<string, unknown>) => {
    if (!shape) return chain(state.resolutions);
    const keys = Object.keys(shape);
    if (keys.includes("claim")) return chain([claimRow]);
    if (keys.includes("blobId")) return chain(state.blobs);
    if (keys.includes("version")) return chain(state.versions);
    return chain([{ id: CLAIM_ID }]);
  };

  dbState.getDb.mockReturnValue({
    select,
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        select,
        insert: () => ({
          values: async (values: Record<string, unknown>) => {
            inserts.push({ values });
          },
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              updates.push(values);
            },
          }),
        }),
      }),
  });
});

describe("resolveClaim adoption", () => {
  it("skips a claim that already has a resolution and does not adjudicate it", async () => {
    state.resolutions = [
      {
        outcome: "true",
        reason: "already checked",
        evidence: { revision: 1 },
        walrusBlobId: "blob-old",
        resolvedAt: new Date("2026-10-23T12:19:45.000Z"),
      },
    ];
    const report = await resolveClaim(CLAIM_ID);
    expect(report.skipped).toBe("already resolved");
    expect(report.handle).toBe("mrcamerontrader");
    expect(report.outcome).toBe("true");
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(memwalMock.recallMemory).not.toHaveBeenCalled();
    expect(memwalMock.writeMemoriesDurable).not.toHaveBeenCalled();
  });

  it("adopts a stored resolution without calling Tatum or writing another resolution", async () => {
    memwalMock.recallMemory.mockImplementation(async (args: { namespace: string }) =>
      args.namespace === "walkback.resolution" ? [hit("false")] : [],
    );
    memwalMock.writeMemoriesDurable.mockImplementation(
      async (
        items: Array<{ idempotencyKey: string }>,
        onPersisted: (item: { idempotencyKey: string }, result: { blobId: string; id: string }) => Promise<void>,
      ) => {
        const item = items[0]!;
        await onPersisted(item, { blobId: "blob-score", id: "job-score" });
        return {};
      },
    );
    const report = await resolveClaim(CLAIM_ID);
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(report.skipped).toBe("adopted stored resolution");
    expect(report.outcome).toBe("false");
    expect(report.reason).toBe("stored reason");
    expect(report.handle).toBe("mrcamerontrader");
    expect(report.externalId).toBe("post:x-mrcamerontrader-2107077951863099625:0");
    const resolutionWrites = memwalMock.writeMemoriesDurable.mock.calls.filter((call) =>
      (call[0] as Array<{ idempotencyKey: string }>).some((write) => write.idempotencyKey.startsWith("resolution:")),
    );
    expect(resolutionWrites).toHaveLength(0);
    const resolutionInsert = inserts.find((row) => row.values.claimId === CLAIM_ID);
    expect(resolutionInsert?.values.outcome).toBe("false");
    expect(resolutionInsert?.values.walrusBlobId).toBe("blob-old");
  });

  it("leaves the claim pending when the logged blob cannot be read", async () => {
    state.blobs = [{ blobId: "blob-logged" }];
    memwalMock.recallMemory.mockResolvedValue([]);
    await expect(resolveClaim(CLAIM_ID)).rejects.toThrow(/left pending/);
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(memwalMock.writeMemoriesDurable).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("on a 409 adopts the stored verdict and does not send a second resolution body", async () => {
    let resolutionReads = 0;
    memwalMock.recallMemory.mockImplementation(async (args: { namespace: string }) => {
      if (args.namespace !== "walkback.resolution") return [];
      resolutionReads += 1;
      return resolutionReads === 1 ? [] : [hit("false")];
    });
    adjudicateMock.mockResolvedValue({ outcome: "true", reason: "fresh read", evidence: { fresh: true } });
    const conflict = Object.assign(
      new Error(
        'Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}',
      ),
      { status: 409 },
    );
    let attempts = 0;
    memwalMock.writeMemoriesDurable.mockImplementation(async (items: Array<{ idempotencyKey: string }>, onPersisted: (item: { idempotencyKey: string }, result: { blobId: string; id: string }) => Promise<void>) => {
      attempts += 1;
      if (attempts === 1) return { error: conflict.message, cause: conflict };
      const item = items[0]!;
      await onPersisted(item, { blobId: "blob-score", id: "job-score" });
      return {};
    });
    const report = await resolveClaim(CLAIM_ID);
    expect(adjudicateMock).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe("false");
    expect(report.reason).toBe("stored reason");
    expect(report.skipped).toBe("adopted stored resolution");
    const keys = memwalMock.writeMemoriesDurable.mock.calls.flatMap((call) =>
      (call[0] as Array<{ idempotencyKey: string }>).map((write) => write.idempotencyKey),
    );
    expect(keys.filter((key) => key.startsWith("resolution:"))).toEqual([`resolution:${CLAIM_ID}`]);
    expect(keys.filter((key) => key.startsWith("score:")).length).toBeGreaterThan(0);
  });

  const recorded = {
    outcome: "false" as const,
    reason:
      "From 2026-10-05T11:58:25.000Z to 2026-10-12T11:58:25.000Z, Tatum SUI/USD 1d high was at most 1.25450000, not at least the 1.29 claimed.",
    evidence: { revision: 1, resolvedAt: "2026-10-23T12:19:45.000Z", windowHigh: "1.2545" },
    walrusBlobId: null,
    resolvedAt: new Date("2026-10-23T12:19:45.000Z"),
  };

  it("repairs a recorded verdict that has no Walrus memory without calling Tatum", async () => {
    state.resolutions = [{ ...recorded }];
    memwalMock.recallMemory.mockResolvedValue([]);
    memwalMock.writeMemoriesDurable.mockImplementation(
      async (
        items: Array<{ idempotencyKey: string; text: string }>,
        onPersisted: (item: { idempotencyKey: string }, result: { blobId: string; id: string }) => Promise<void>,
      ) => {
        const item = items[0]!;
        await onPersisted(item, { blobId: item.idempotencyKey.startsWith("score:") ? "blob-score" : "blob-res", id: "job" });
        return {};
      },
    );
    const report = await resolveClaim(CLAIM_ID);
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(report.skipped).toBe("repaired resolution memory");
    expect(report.outcome).toBe("false");
    expect(report.reason).toBe(recorded.reason);
    const resolutionWrite = memwalMock.writeMemoriesDurable.mock.calls
      .flatMap((call) => call[0] as Array<{ idempotencyKey: string; text: string }>)
      .find((write) => write.idempotencyKey === `resolution:${CLAIM_ID}`);
    expect(resolutionWrite?.text).toContain(recorded.reason);
    expect(resolutionWrite?.text).toContain("1.2545");
    expect(resolutionWrite?.text).not.toContain("resolved_at");
    expect(resolutionWrite?.text).not.toContain("resolved 2026");
    state.resolutions[0]!.walrusBlobId = "blob-res";
    memwalMock.writeMemoriesDurable.mockClear();
    const again = await resolveClaim(CLAIM_ID);
    expect(again.skipped).toBe("already resolved");
    expect(memwalMock.writeMemoriesDurable).not.toHaveBeenCalled();
    expect(adjudicateMock).not.toHaveBeenCalled();
  });

  it("adopts the Walrus memory for a recorded verdict and does not write a second resolution", async () => {
    state.resolutions = [{ ...recorded, reason: "db reason that must not win" }];
    memwalMock.recallMemory.mockImplementation(async (args: { namespace: string }) =>
      args.namespace === "walkback.resolution" ? [hit("false")] : [],
    );
    memwalMock.writeMemoriesDurable.mockImplementation(
      async (
        items: Array<{ idempotencyKey: string }>,
        onPersisted: (item: { idempotencyKey: string }, result: { blobId: string; id: string }) => Promise<void>,
      ) => {
        const item = items[0]!;
        await onPersisted(item, { blobId: "blob-score", id: "job-score" });
        return {};
      },
    );
    const report = await resolveClaim(CLAIM_ID, new Date(), { reconcile: true });
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(report.skipped).toBe("adopted stored resolution");
    expect(report.outcome).toBe("false");
    expect(report.reason).toBe("stored reason");
    const keys = memwalMock.writeMemoriesDurable.mock.calls.flatMap((call) =>
      (call[0] as Array<{ idempotencyKey: string }>).map((write) => write.idempotencyKey),
    );
    expect(keys.filter((key) => key.startsWith("resolution:"))).toEqual([]);
    expect(updates.some((values) => values.walrusBlobId === "blob-old" && values.reason === "stored reason")).toBe(true);
  });

  it("on a 409 while repairing, adopts the stored memory instead of retrying", async () => {
    state.resolutions = [{ ...recorded }];
    let resolutionReads = 0;
    memwalMock.recallMemory.mockImplementation(async (args: { namespace: string }) => {
      if (args.namespace !== "walkback.resolution") return [];
      resolutionReads += 1;
      return resolutionReads === 1 ? [] : [hit("false")];
    });
    const conflict = Object.assign(
      new Error(
        'Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}',
      ),
      { status: 409 },
    );
    let attempts = 0;
    memwalMock.writeMemoriesDurable.mockImplementation(
      async (
        items: Array<{ idempotencyKey: string }>,
        onPersisted: (item: { idempotencyKey: string }, result: { blobId: string; id: string }) => Promise<void>,
      ) => {
        attempts += 1;
        if (attempts === 1) return { error: conflict.message, cause: conflict };
        const item = items[0]!;
        await onPersisted(item, { blobId: "blob-score", id: "job-score" });
        return {};
      },
    );
    const report = await resolveClaim(CLAIM_ID);
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(report.outcome).toBe("false");
    expect(report.reason).toBe("stored reason");
    expect(report.skipped).toBe("adopted stored resolution");
    const resolutionKeys = memwalMock.writeMemoriesDurable.mock.calls.flatMap((call) =>
      (call[0] as Array<{ idempotencyKey: string }>)
        .map((write) => write.idempotencyKey)
        .filter((key) => key.startsWith("resolution:")),
    );
    expect(resolutionKeys).toEqual([`resolution:${CLAIM_ID}`]);
  });

  it("parks a repair 409 that recall cannot read", async () => {
    state.resolutions = [{ ...recorded }];
    memwalMock.recallMemory.mockResolvedValue([]);
    const conflict = Object.assign(
      new Error(
        'Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}',
      ),
      { status: 409 },
    );
    memwalMock.writeMemoriesDurable.mockResolvedValue({ error: conflict.message, cause: conflict });
    await expect(resolveClaim(CLAIM_ID)).rejects.toThrow(/already used with different content/);
    expect(adjudicateMock).not.toHaveBeenCalled();
    expect(memwalMock.writeMemoriesDurable).toHaveBeenCalledTimes(1);
  });
});
