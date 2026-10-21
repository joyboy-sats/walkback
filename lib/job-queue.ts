/**
 * Job queue shared by the Vercel routes and the Coolify worker.
 *
 * Routes call `enqueueJob` and return. The worker calls `claimNextJob`.
 * The claim statement locks one pending row with `FOR UPDATE SKIP LOCKED`,
 * so two workers cannot take the same job. This module does not import the
 * Walrus client: a Vercel request must be able to enqueue without the
 * delegate key.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import {
  attemptsFromResolveJob,
  NOOP_RESOLVE_RETENTION_MS,
  RESOLVE_ATTEMPT_LOOKBACK,
  type ResolveAttemptRecord,
} from "./resolve-schedule";

export type JobKind = "ingest" | "rebuild" | "resolve" | "restore";
export type JobStatus = "pending" | "running" | "done" | "failed";

/** A claim counts as an attempt. The third failure is permanent. */
export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_MS = 2_000;
export const RETRY_CAP_MS = 60_000;
/** A running job with no heartbeat for this long is abandoned. */
export const STALE_RUNNING_MS = 20 * 60 * 1000;

export function isStale(
  job: { status: JobStatus; updatedAt: Date | null },
  now: Date,
  staleMs = STALE_RUNNING_MS,
): boolean {
  if (job.status !== "running") return false;
  if (!job.updatedAt) return true;
  return now.getTime() - job.updatedAt.getTime() >= staleMs;
}

/** A running job refreshes this so a long rebuild is not treated as abandoned. */
export const HEARTBEAT_MS = 30_000;

/**
 * One pending row, oldest first, skipping anything another worker already
 * locked and anything whose retry time has not arrived.
 */
export const CLAIM_NEXT_JOB_SQL = `
UPDATE ingest_jobs
SET status = 'running',
    started_at = now(),
    updated_at = now(),
    attempts = attempts + 1,
    next_attempt_at = NULL
WHERE id = (
  SELECT id FROM ingest_jobs
  WHERE status = 'pending'
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, payload, attempts
`;

export interface ClaimCandidate {
  id: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  locked: boolean;
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface FailurePlan {
  status: "pending" | "failed";
  nextAttemptAt: Date | null;
  error: string;
  finishedAt: Date | null;
  delayMs: number;
}

/** Delay before attempt `attempts` may be claimed again. Attempt 1 waits 2s, then 4s, then 8s. */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (n - 1));
}

/**
 * What to store after a run throws. `attempts` is the count already recorded
 * by the claim (it includes this run).
 */
export function planFailure(attempts: number, now: Date, error: string): FailurePlan {
  if (attempts >= MAX_ATTEMPTS) {
    return { status: "failed", nextAttemptAt: null, error, finishedAt: now, delayMs: 0 };
  }
  const delayMs = retryDelayMs(attempts);
  return {
    status: "pending",
    nextAttemptAt: new Date(now.getTime() + delayMs),
    error,
    finishedAt: null,
    delayMs,
  };
}

/**
 * Same predicate as `CLAIM_NEXT_JOB_SQL`: oldest unlocked pending row that is due.
 * `locked` stands in for a row held by `FOR UPDATE SKIP LOCKED`.
 */
export function pickClaim<T extends ClaimCandidate>(rows: readonly T[], now: Date): T | null {
  const due = rows
    .filter(
      (row) =>
        !row.locked &&
        row.status === "pending" &&
        (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now.getTime()),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return due[0] ?? null;
}

/** Apply a claim to an in-memory row. Returns null when nothing is due. */
export function claimOne<T extends ClaimCandidate>(rows: readonly T[], now: Date): T | null {
  const row = pickClaim(rows, now);
  if (!row) return null;
  row.locked = true;
  row.status = "running";
  row.attempts += 1;
  row.nextAttemptAt = null;
  return row;
}

export async function enqueueJob(kind: JobKind, payload: Record<string, unknown>): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.ingestJobs)
    .values({ kind, payload, status: "pending" })
    .returning({ id: schema.ingestJobs.id });
  if (!row) throw new Error("failed to enqueue job");
  return row.id;
}

export async function readJob(id: string) {
  const db = getDb();
  const [row] = await db.select().from(schema.ingestJobs).where(eq(schema.ingestJobs.id, id)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    result: row.result ?? null,
    error: row.error,
  };
}

export async function claimNextJob(): Promise<ClaimedJob | null> {
  const db = getDb();
  const rows = await db.execute(sql.raw(CLAIM_NEXT_JOB_SQL));
  const row = rows[0] as
    | { id: string; kind: JobKind; payload: Record<string, unknown> | null; attempts: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload ?? {},
    attempts: Number(row.attempts),
  };
}

export async function markJobDone(id: string, result: unknown): Promise<void> {
  const db = getDb();
  await db
    .update(schema.ingestJobs)
    .set({
      status: "done",
      result: (result ?? {}) as Record<string, unknown>,
      error: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
      nextAttemptAt: null,
    })
    .where(eq(schema.ingestJobs.id, id));
}

export async function recordJobFailure(id: string, attempts: number, error: string, now = new Date()): Promise<FailurePlan> {
  const plan = planFailure(attempts, now, error);
  const db = getDb();
  await db
    .update(schema.ingestJobs)
    .set({
      status: plan.status,
      error: plan.error,
      nextAttemptAt: plan.nextAttemptAt,
      finishedAt: plan.finishedAt,
      updatedAt: now,
    })
    .where(eq(schema.ingestJobs.id, id));
  return plan;
}

/** A resolve job is already waiting or running, so the periodic pass should not add another. */
export async function hasOpenJob(kind: JobKind): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: schema.ingestJobs.id })
    .from(schema.ingestJobs)
    .where(and(eq(schema.ingestJobs.kind, kind), inArray(schema.ingestJobs.status, ["pending", "running"])))
    .limit(1);
  return Boolean(row);
}

/**
 * A worker that died left the row `running`. Staleness is the last heartbeat
 * (`updated_at`), not `started_at`: a rebuild can run longer than 20 minutes
 * while the worker keeps touching the row.
 */
export async function requeueStaleJobs(now = new Date(), staleMs = STALE_RUNNING_MS): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - staleMs);
  const rows = await db
    .select({ id: schema.ingestJobs.id, attempts: schema.ingestJobs.attempts })
    .from(schema.ingestJobs)
    .where(and(eq(schema.ingestJobs.status, "running"), lt(schema.ingestJobs.updatedAt, cutoff)));

  for (const row of rows) {
    await recordJobFailure(row.id, row.attempts, "worker stopped before the job finished", now);
  }
  return rows.length;
}

/**
 * Delete finished periodic resolve jobs that checked nothing and threw
 * nothing, once they are older than an hour. The predicate matches
 * `isNoopResolveResult`: both `reports` and `errors` are empty arrays.
 * Jobs that resolved a claim, or that recorded a throw, stay. The throw
 * rows are the backoff history.
 */
export async function pruneNoopResolveJobs(
  now = new Date(),
  retentionMs = NOOP_RESOLVE_RETENTION_MS,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - retentionMs);
  const rows = await db
    .delete(schema.ingestJobs)
    .where(
      and(
        eq(schema.ingestJobs.kind, "resolve"),
        eq(schema.ingestJobs.status, "done"),
        lt(schema.ingestJobs.finishedAt, cutoff),
        sql`jsonb_typeof(${schema.ingestJobs.result}->'reports') = 'array'
          AND jsonb_array_length(${schema.ingestJobs.result}->'reports') = 0
          AND jsonb_typeof(${schema.ingestJobs.result}->'errors') = 'array'
          AND jsonb_array_length(${schema.ingestJobs.result}->'errors') = 0`,
      ),
    )
    .returning({ id: schema.ingestJobs.id });
  return rows.length;
}

/** Recent finished resolve jobs, newest first, flattened to per-claim attempts. */
export async function recentResolveAttempts(limit = RESOLVE_ATTEMPT_LOOKBACK): Promise<ResolveAttemptRecord[]> {
  const db = getDb();
  const rows = await db
    .select({
      finishedAt: schema.ingestJobs.finishedAt,
      result: schema.ingestJobs.result,
    })
    .from(schema.ingestJobs)
    .where(and(eq(schema.ingestJobs.kind, "resolve"), eq(schema.ingestJobs.status, "done")))
    .orderBy(desc(schema.ingestJobs.finishedAt))
    .limit(limit);
  return rows.flatMap((row) => attemptsFromResolveJob(row));
}

export async function touchJob(id: string, now = new Date()): Promise<void> {
  const db = getDb();
  await db
    .update(schema.ingestJobs)
    .set({ updatedAt: now })
    .where(and(eq(schema.ingestJobs.id, id), eq(schema.ingestJobs.status, "running")));
}
