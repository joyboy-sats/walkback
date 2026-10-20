import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  CLAIM_NEXT_JOB_SQL,
  MAX_ATTEMPTS,
  STALE_RUNNING_MS,
  claimOne,
  isStale,
  pickClaim,
  planFailure,
  retryDelayMs,
  type ClaimCandidate,
} from "./job-queue";

function row(partial: Partial<ClaimCandidate> & Pick<ClaimCandidate, "id">): ClaimCandidate {
  return {
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"),
    locked: false,
    ...partial,
  };
}

const NOW = new Date("2026-10-20T12:00:00.000Z");

describe("claim predicate", () => {
  it("selects the oldest due pending row and skips a locked one", () => {
    const older = row({ id: "a", createdAt: new Date("2026-10-20T00:00:00.000Z") });
    const newer = row({ id: "b", createdAt: new Date("2026-10-20T01:00:00.000Z") });
    const rows = [newer, older];

    const first = claimOne(rows, NOW);
    const second = claimOne(rows, NOW);
    const third = claimOne(rows, NOW);

    expect(first?.id).toBe("a");
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(first?.locked).toBe(true);
    expect(second?.id).toBe("b");
    expect(second?.attempts).toBe(1);
    expect(third).toBeNull();
    expect(pickClaim(rows, NOW)).toBeNull();
  });

  it("skips rows that are not pending or whose retry time is still ahead", () => {
    const future = row({
      id: "later",
      nextAttemptAt: new Date("2026-10-20T13:00:00.000Z"),
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    const failed = row({
      id: "failed",
      status: "failed",
      createdAt: new Date("2026-10-19T00:00:00.000Z"),
    });
    const running = row({
      id: "running",
      status: "running",
      locked: true,
      createdAt: new Date("2026-10-19T00:00:00.000Z"),
    });
    const due = row({
      id: "due",
      nextAttemptAt: new Date("2026-10-20T11:00:00.000Z"),
      createdAt: new Date("2026-10-20T02:00:00.000Z"),
    });

    expect(pickClaim([future, failed, running, due], NOW)?.id).toBe("due");
  });

  it("claims with FOR UPDATE SKIP LOCKED and only pending rows that are due", () => {
    expect(CLAIM_NEXT_JOB_SQL).toContain("FOR UPDATE SKIP LOCKED");
    expect(CLAIM_NEXT_JOB_SQL).toContain("status = 'pending'");
    expect(CLAIM_NEXT_JOB_SQL).toContain("next_attempt_at");
    expect(CLAIM_NEXT_JOB_SQL).toContain("ORDER BY created_at");
    expect(CLAIM_NEXT_JOB_SQL).toContain("attempts = attempts + 1");
  });
});

describe("retries", () => {
  it("backs off and then fails permanently", () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(8_000);

    const first = planFailure(1, NOW, "relayer timeout");
    expect(first.status).toBe("pending");
    expect(first.delayMs).toBe(2_000);
    expect(first.nextAttemptAt?.toISOString()).toBe("2026-10-20T12:00:02.000Z");
    expect(first.finishedAt).toBeNull();

    const last = planFailure(MAX_ATTEMPTS, NOW, "relayer timeout");
    expect(last.status).toBe("failed");
    expect(last.nextAttemptAt).toBeNull();
    expect(last.finishedAt).toEqual(NOW);
  });
});

describe("heartbeat staleness", () => {
  const staleMs = STALE_RUNNING_MS;

  it("keeps a long-running job that is still heartbeating", () => {
    const startedLongAgo = new Date(NOW.getTime() - 40 * 60 * 1000);
    const recentBeat = new Date(NOW.getTime() - 60 * 1000);
    expect(
      isStale({ status: "running", updatedAt: recentBeat, startedAt: startedLongAgo } as {
        status: "running";
        updatedAt: Date;
      }, NOW, staleMs),
    ).toBe(false);
  });

  it("requeues a running job whose last heartbeat is older than the window", () => {
    const old = new Date(NOW.getTime() - staleMs - 1);
    expect(isStale({ status: "running", updatedAt: old }, NOW, staleMs)).toBe(true);
    expect(isStale({ status: "running", updatedAt: null }, NOW, staleMs)).toBe(true);
    expect(isStale({ status: "pending", updatedAt: old }, NOW, staleMs)).toBe(false);
  });
});
