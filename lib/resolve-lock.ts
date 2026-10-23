/**
 * One claim, one resolver. The seed's resolve phase and the worker's periodic
 * pass both call `resolveClaim`. Without this lock they adjudicate together
 * and send the same idempotency key with two bodies.
 *
 * The lock is session-level (`pg_try_advisory_lock`) on a reserved pool
 * connection, held across the Tatum read and the Walrus write. A transaction
 * lock would have to stay open for that whole time, and the seed's
 * `lock_timeout` would cancel a blocking wait. `try` returns immediately;
 * the loser skips the claim and the holder finishes it.
 *
 * A second lock, `walkback.memwal.write`, is the write turn: only one
 * `rememberAndWait` runs at a time across processes, so status polls do not
 * stack on the 60 weighted-request minute.
 */
import "server-only";

import { createHash } from "node:crypto";
import { getSql } from "./db";

export interface HeldLock {
  release(): Promise<void>;
}

/** Two int4 keys. The same name always maps to the same pair. */
export function advisoryLockKeys(name: string): [number, number] {
  const buf = createHash("sha256").update(name).digest();
  return [buf.readInt32BE(0), buf.readInt32BE(4)];
}

export function claimResolveLockName(claimId: string): string {
  return `walkback.resolve:${claimId}`;
}

export const MEMWAL_WRITE_LOCK_NAME = "walkback.memwal.write";

const noop: HeldLock = { async release() {} };

async function tryAdvisoryLock(name: string): Promise<HeldLock | null> {
  if (!process.env.DATABASE_URL) return noop;
  const reserved = await getSql().reserve();
  const [k1, k2] = advisoryLockKeys(name);
  let locked = false;
  try {
    const rows = await reserved.unsafe<{ locked: boolean }[]>(
      "select pg_try_advisory_lock($1::int, $2::int) as locked",
      [k1, k2],
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      reserved.release();
      return null;
    }
    return {
      async release() {
        try {
          await reserved.unsafe("select pg_advisory_unlock($1::int, $2::int)", [k1, k2]);
        } finally {
          reserved.release();
        }
      },
    };
  } catch (err) {
    if (locked) {
      try {
        await reserved.unsafe("select pg_advisory_unlock($1::int, $2::int)", [k1, k2]);
      } catch {
        // The connection is going back to the pool either way.
      }
    }
    reserved.release();
    throw err;
  }
}

/**
 * Run `run` while this process holds the claim. `onLocked` runs when the
 * other resolver already holds it. Tests pass `lock` so they do not need Postgres.
 */
export async function gateClaimResolve<T>(
  claimId: string,
  run: () => Promise<T>,
  onLocked: () => Promise<T>,
  lock: (claimId: string) => Promise<HeldLock | null> = tryClaimResolveLock,
): Promise<T> {
  const held = await lock(claimId);
  if (!held) return onLocked();
  try {
    return await run();
  } finally {
    await held.release();
  }
}

export function tryClaimResolveLock(claimId: string): Promise<HeldLock | null> {
  return tryAdvisoryLock(claimResolveLockName(claimId));
}

/** Wait until this process is the only one inside `rememberAndWait`. */
export async function withMemwalWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) return fn();
  let waited = 0;
  for (;;) {
    const held = await tryAdvisoryLock(MEMWAL_WRITE_LOCK_NAME);
    if (held) {
      try {
        return await fn();
      } finally {
        await held.release();
      }
    }
    waited += 1;
    if (waited === 1 || waited % 150 === 0) {
      console.log("[memwal] waiting for the shared write lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
