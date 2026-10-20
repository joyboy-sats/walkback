/**
 * Queue between the API and the worker.
 *
 * The API inserts a row and returns its id. The worker claims one row at a
 * time with SKIP LOCKED, so two workers cannot run the same job, and a request
 * never waits on a Walrus write. A job left `running` for 20 minutes is marked
 * failed rather than retried: a retry after a crash could write the memory twice.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { ingest } from "../lib/ingest";
import type { IngestBody } from "../lib/ingest-body";
import { restoreNamespace } from "../lib/memwal";
import { rebuildProjection } from "../lib/projection-rebuild";
import { resolveClaim, resolveDueClaims } from "../lib/resolve";
import { NS, type Namespace } from "../lib/types";

export type JobKind = "ingest" | "rebuild" | "resolve" | "restore";

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
}

export async function enqueueJob(kind: JobKind, payload: Record<string, unknown>): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.jobs)
    .values({ kind, payload, status: "queued" })
    .returning({ id: schema.jobs.id });
  if (!row) throw new Error("failed to enqueue job");
  return row.id;
}

export async function readJob(id: string) {
  const db = getDb();
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    result: row.result ?? null,
    error: row.error,
  };
}

/** Mark jobs whose worker disappeared. Does not requeue them. */
export async function failStaleJobs(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE jobs
    SET status = 'error',
        error = 'worker stopped before the job finished',
        finished_at = now()
    WHERE status = 'running'
      AND started_at < now() - interval '20 minutes'
  `);
}

export async function claimNextJob(): Promise<ClaimedJob | null> {
  const db = getDb();
  const rows = await db.execute<{ id: string; kind: JobKind; payload: Record<string, unknown> }>(sql`
    UPDATE jobs
    SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, payload
  `);

  const row = rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, payload: row.payload ?? {} };
}

export async function executeJob(job: ClaimedJob): Promise<void> {
  const db = getDb();
  try {
    const result = await dispatch(job);
    await db
      .update(schema.jobs)
      .set({
        status: "done",
        result: result as Record<string, unknown>,
        finishedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
  } catch (err) {
    await db
      .update(schema.jobs)
      .set({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
  }
}

async function dispatch(job: ClaimedJob): Promise<unknown> {
  switch (job.kind) {
    case "ingest": {
      const body = job.payload as unknown as IngestBody;
      return ingest({
        handle: body.handle,
        platform: body.platform,
        text: body.text,
        publishedAt: body.publishedAt ?? new Date().toISOString(),
        ...(body.suiAddress ? { suiAddress: body.suiAddress } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
    }
    case "rebuild":
      return rebuildProjection();
    case "resolve": {
      const payload = job.payload as { claimId?: string; due?: boolean; limit?: number };
      if (payload.claimId) return resolveClaim(payload.claimId);
      return resolveDueClaims(new Date(), payload.limit ?? 10);
    }
    case "restore": {
      const payload = job.payload as { namespace?: Namespace; limit?: number };
      const namespace = payload.namespace ?? NS.claim;
      const limit = payload.limit ?? 200;
      const rounds: Awaited<ReturnType<typeof restoreNamespace>>[] = [];
      let restoredTotal = 0;
      for (let i = 0; i < 5; i++) {
        const round = await restoreNamespace(namespace, limit);
        rounds.push(round);
        restoredTotal += round.restored;
        if (!round.truncated || round.restored === 0) break;
      }
      return { namespace, restoredTotal, rounds };
    }
    default:
      throw new Error(`unknown job kind: ${String(job.kind)}`);
  }
}
