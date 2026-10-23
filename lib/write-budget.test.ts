import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { decideWriteBudget } from "./write-budget";

const windowMs = 60_000;
const capacity = 60;

describe("shared write budget", () => {
  it("grants inside a fresh window and charges the cost", () => {
    const now = 1_000_000;
    const decision = decideWriteBudget({
      nowMs: now,
      windowStartedAtMs: now,
      used: 0,
      cost: 6,
      capacity,
      windowMs,
    });
    expect(decision).toEqual({ grant: true, used: 6, windowStartedAtMs: now, waitMs: 0 });
  });

  it("waits until the window rolls when the shared cap is full", () => {
    const started = 1_000_000;
    const now = started + 10_000;
    const decision = decideWriteBudget({
      nowMs: now,
      windowStartedAtMs: started,
      used: 60,
      cost: 6,
      capacity,
      windowMs,
    });
    expect(decision.grant).toBe(false);
    expect(decision.used).toBe(60);
    expect(decision.waitMs).toBe(50_000);
  });

  it("opens a new window after 60s so a second process does not keep the old spend", () => {
    const started = 1_000_000;
    const now = started + windowMs;
    const decision = decideWriteBudget({
      nowMs: now,
      windowStartedAtMs: started,
      used: 60,
      cost: 6,
      capacity,
      windowMs,
    });
    expect(decision).toEqual({ grant: true, used: 6, windowStartedAtMs: now, waitMs: 0 });
  });
});
