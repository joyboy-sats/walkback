/**
 * The MemWal write budget both processes can see.
 *
 * `memwalWriteLimiter` lives in memory. The seed and the worker each had a
 * full bucket, so together they passed 60 weighted requests per minute and
 * the relayer answered 429. This row is one fixed window for every process
 * that shares `DATABASE_URL`.
 */
import "server-only";

import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { MEMWAL_WEIGHTED_LIMIT_PER_MIN } from "./ratelimit";

export const WRITE_BUDGET_WINDOW_MS = 60_000;
export const WRITE_BUDGET_ID = "write";

export interface WriteBudgetDecision {
  grant: boolean;
  used: number;
  windowStartedAtMs: number;
  /** How long to sleep before asking again. 0 when `grant` is true. */
  waitMs: number;
}

/** Fixed window. A new window starts when the previous one is at least `windowMs` old. */
export function decideWriteBudget(input: {
  nowMs: number;
  windowStartedAtMs: number;
  used: number;
  cost: number;
  capacity: number;
  windowMs: number;
}): WriteBudgetDecision {
  let used = input.used;
  let windowStartedAtMs = input.windowStartedAtMs;
  if (input.nowMs - windowStartedAtMs >= input.windowMs) {
    used = 0;
    windowStartedAtMs = input.nowMs;
  }
  if (used + input.cost <= input.capacity) {
    return { grant: true, used: used + input.cost, windowStartedAtMs, waitMs: 0 };
  }
  const waitMs = Math.max(50, windowStartedAtMs + input.windowMs - input.nowMs);
  return { grant: false, used, windowStartedAtMs, waitMs };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingBudgetTable(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code === "42P01") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /memwal_write_budget/.test(message) && /does not exist/i.test(message);
}

let warnedMissing = false;

/**
 * Take `cost` weighted requests from the shared window. No-ops when this
 * process has no database. If the migration has not been applied yet, warns
 * once and returns so a write is not stuck behind a missing table.
 */
export async function acquireSharedWriteBudget(
  cost: number,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await takeBudget(cost, sleep);
  } catch (err) {
    if (!missingBudgetTable(err)) throw err;
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[memwal] memwal_write_budget is missing; this process is using its local limiter only. Apply migrations.",
      );
    }
  }
}

async function takeBudget(cost: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const db = getDb();
  for (;;) {
    const waitMs = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.memwalWriteBudget)
        .where(eq(schema.memwalWriteBudget.id, WRITE_BUDGET_ID))
        .for("update");
      const now = Date.now();
      const decision = decideWriteBudget({
        nowMs: now,
        windowStartedAtMs: row ? row.windowStartedAt.getTime() : now,
        used: row?.used ?? 0,
        cost,
        capacity: MEMWAL_WEIGHTED_LIMIT_PER_MIN,
        windowMs: WRITE_BUDGET_WINDOW_MS,
      });
      const next = {
        used: decision.grant ? decision.used : decision.used,
        windowStartedAt: new Date(decision.windowStartedAtMs),
      };
      if (!row) {
        await tx.insert(schema.memwalWriteBudget).values({ id: WRITE_BUDGET_ID, ...next, used: decision.grant ? decision.used : 0 });
      } else if (decision.grant) {
        await tx.update(schema.memwalWriteBudget).set(next).where(eq(schema.memwalWriteBudget.id, WRITE_BUDGET_ID));
      }
      return decision.waitMs;
    });
    if (waitMs === 0) return;
    await sleep(waitMs);
  }
}
