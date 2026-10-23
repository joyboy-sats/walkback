import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { advisoryLockKeys, claimResolveLockName, gateClaimResolve, type HeldLock } from "./resolve-lock";

describe("resolve lock", () => {
  it("derives a stable int4 pair from the claim id", () => {
    const name = claimResolveLockName("b3cfb240-691d-826f-72e1-1695f7e46335");
    expect(advisoryLockKeys(name)).toEqual(advisoryLockKeys(name));
    expect(advisoryLockKeys(name)).not.toEqual(advisoryLockKeys(claimResolveLockName("other")));
    const [a, b] = advisoryLockKeys(name);
    expect(Number.isInteger(a)).toBe(true);
    expect(Number.isInteger(b)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(-2147483648);
    expect(a).toBeLessThanOrEqual(2147483647);
  });

  it("skips the claim when the other resolver holds the lock, and releases when it runs", async () => {
    const release = vi.fn(async () => {});
    const held: HeldLock = { release };
    const lock = vi.fn(async () => held);
    const run = vi.fn(async () => "ran");
    const onLocked = vi.fn(async () => "skipped");

    await expect(gateClaimResolve("claim", run, onLocked, async () => null)).resolves.toBe("skipped");
    expect(run).not.toHaveBeenCalled();

    await expect(gateClaimResolve("claim", run, onLocked, lock)).resolves.toBe("ran");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when resolve throws", async () => {
    const release = vi.fn(async () => {});
    await expect(
      gateClaimResolve(
        "claim",
        async () => {
          throw new Error("tatum down");
        },
        async () => "skipped",
        async () => ({ release }),
      ),
    ).rejects.toThrow(/tatum down/);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
