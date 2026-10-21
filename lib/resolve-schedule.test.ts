import { describe, expect, it } from "vitest";
import {
  PERIODIC_RESOLVE_LIMIT,
  RESOLVE_CLAIM_BACKOFF_BASE_MS,
  RESOLVE_CLAIM_BACKOFF_CAP_MS,
  attemptsFromResolveJob,
  claimsReadyToResolve,
  decidePeriodicResolve,
  isNoopResolveResult,
  planResolveJob,
  resolveClaimBackoffMs,
} from "./resolve-schedule";

const NOW = new Date("2026-10-21T12:00:00.000Z");

describe("resolve claim backoff", () => {
  it("doubles from five minutes and caps at six hours", () => {
    expect(resolveClaimBackoffMs(1)).toBe(RESOLVE_CLAIM_BACKOFF_BASE_MS);
    expect(resolveClaimBackoffMs(2)).toBe(10 * 60 * 1000);
    expect(resolveClaimBackoffMs(3)).toBe(20 * 60 * 1000);
    expect(resolveClaimBackoffMs(20)).toBe(RESOLVE_CLAIM_BACKOFF_CAP_MS);
    expect(resolveClaimBackoffMs(40)).toBe(RESOLVE_CLAIM_BACKOFF_CAP_MS);
  });

  it("skips a claim whose last throw is still inside the window", () => {
    const failedAt = new Date(NOW.getTime() - 4 * 60 * 1000);
    const ready = claimsReadyToResolve(
      ["due", "cooling"],
      [
        { claimId: "cooling", finishedAt: failedAt, failed: true },
        { claimId: "cooling", finishedAt: new Date(failedAt.getTime() - 60_000), failed: true },
      ],
      NOW,
    );
    expect(ready).toEqual(["due"]);
  });

  it("retries after the window and forgets throws that a success ended", () => {
    const oneAgo = new Date(NOW.getTime() - RESOLVE_CLAIM_BACKOFF_BASE_MS - 1);
    const ready = claimsReadyToResolve(
      ["aged", "reset"],
      [
        { claimId: "aged", finishedAt: oneAgo, failed: true },
        { claimId: "reset", finishedAt: new Date(NOW.getTime() - 1000), failed: false },
        { claimId: "reset", finishedAt: new Date(NOW.getTime() - 10 * 60 * 1000), failed: true },
      ],
      NOW,
    );
    expect(ready).toEqual(["aged", "reset"]);
  });

  it("reads reports and errors from a finished job", () => {
    const finishedAt = new Date("2026-10-21T11:00:00.000Z");
    expect(
      attemptsFromResolveJob({
        finishedAt,
        result: {
          reports: [{ claimId: "ok", outcome: "void" }],
          errors: [{ claimId: "bad", error: "relayer timeout" }],
        },
      }),
    ).toEqual([
      { claimId: "ok", finishedAt, failed: false },
      { claimId: "bad", finishedAt, failed: true },
    ]);
    expect(attemptsFromResolveJob({ finishedAt: null, result: { reports: [], errors: [] } })).toEqual([]);
  });
});

describe("no-op resolve results", () => {
  it("matches an empty periodic result and ignores a real report", () => {
    expect(isNoopResolveResult({ reports: [], errors: [] })).toBe(true);
    expect(isNoopResolveResult({ reports: [{ claimId: "c" }], errors: [] })).toBe(false);
    expect(isNoopResolveResult({ reports: [], errors: [{ claimId: "c", error: "x" }] })).toBe(false);
    expect(isNoopResolveResult({ claimId: "c", outcome: "true" })).toBe(false);
    expect(isNoopResolveResult(null)).toBe(false);
  });
});

describe("periodic resolve decision", () => {
  it("does not enqueue when nothing is due or a pass is already open", () => {
    const idle = decidePeriodicResolve({ enabled: true, openJob: false, dueIds: [], attempts: [], now: NOW });
    const open = decidePeriodicResolve({ enabled: true, openJob: true, dueIds: ["c"], attempts: [], now: NOW });
    const disabled = decidePeriodicResolve({ enabled: false, openJob: false, dueIds: ["c"], attempts: [], now: NOW });
    expect(idle).toEqual({ action: "skip", reason: "idle" });
    expect(open).toEqual({ action: "skip", reason: "open" });
    expect(disabled).toEqual({ action: "skip", reason: "disabled" });
  });

  it("enqueues only the claims that are out of backoff, oldest first, capped", () => {
    const dueIds = ["cooling", "ready", ...Array.from({ length: 12 }, (_, i) => `more-${i}`)];
    const decision = decidePeriodicResolve({
      enabled: true,
      openJob: false,
      dueIds,
      attempts: [{ claimId: "cooling", finishedAt: new Date(NOW.getTime() - 1000), failed: true }],
      now: NOW,
      limit: PERIODIC_RESOLVE_LIMIT,
    });
    expect(decision.action).toBe("enqueue");
    if (decision.action !== "enqueue") return;
    expect(decision.claimIds).toHaveLength(PERIODIC_RESOLVE_LIMIT);
    expect(decision.claimIds[0]).toBe("ready");
    expect(decision.claimIds).not.toContain("cooling");
  });

  it("reports backoff when every due claim is still waiting", () => {
    const decision = decidePeriodicResolve({
      enabled: true,
      openJob: false,
      dueIds: ["cooling"],
      attempts: [{ claimId: "cooling", finishedAt: NOW, failed: true }],
      now: NOW,
    });
    expect(decision).toEqual({ action: "skip", reason: "backoff" });
  });
});

describe("resolve job payload", () => {
  it("keeps a manual claim id, a filtered id list, and a due pass distinct", () => {
    expect(planResolveJob({ claimId: "one", claimIds: ["ignored"] })).toEqual({ type: "one", claimId: "one" });
    expect(planResolveJob({ due: true, limit: 2, claimIds: ["a", "", "b", "c"] })).toEqual({
      type: "ids",
      claimIds: ["a", "b"],
    });
    expect(planResolveJob({ due: true, limit: 4 })).toEqual({ type: "due", limit: 4 });
    expect(planResolveJob({})).toEqual({ type: "due", limit: PERIODIC_RESOLVE_LIMIT });
  });
});
