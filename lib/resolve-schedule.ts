/**
 * When the worker should enqueue a periodic resolve, and which claims it may
 * touch. Pure: the worker loads rows and applies this.
 *
 * A resolve job used to be inserted every minute even when nothing was due,
 * and a claim whose resolve threw stayed `pending`, so the next minute paid
 * for Tatum again. The periodic pass now skips an empty queue and waits
 * longer after each consecutive throw. A manual resolve is a different
 * payload and does not consult this backoff.
 */

export const RESOLVE_CLAIM_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const RESOLVE_CLAIM_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
/** Matches the previous periodic payload: at most 10 claims per pass. */
export const PERIODIC_RESOLVE_LIMIT = 10;
/** Oldest deadlines first. Enough to see past a run of claims that are waiting. */
export const DUE_CLAIM_SCAN_LIMIT = 200;
/** Done resolve jobs consulted to count consecutive throws. */
export const RESOLVE_ATTEMPT_LOOKBACK = 100;
/** Finished no-op resolve rows older than this are deleted. */
export const NOOP_RESOLVE_RETENTION_MS = 60 * 60 * 1000;

export interface ResolveAttemptRecord {
  claimId: string;
  finishedAt: Date;
  failed: boolean;
}

/**
 * Wait after `consecutiveFailures` throws. 5m, 10m, 20m, … capped at 6h.
 * Attempt 1 is the first failure.
 */
export function resolveClaimBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const shift = Math.min(n - 1, 20);
  return Math.min(RESOLVE_CLAIM_BACKOFF_CAP_MS, RESOLVE_CLAIM_BACKOFF_BASE_MS * 2 ** shift);
}

/**
 * Due claims whose latest streak of throws has aged out. Order is preserved
 * (callers pass oldest deadline first). A recorded success ends the streak.
 */
export function claimsReadyToResolve(
  dueIds: readonly string[],
  attempts: readonly ResolveAttemptRecord[],
  now: Date,
): string[] {
  const byClaim = new Map<string, ResolveAttemptRecord[]>();
  for (const attempt of attempts) {
    const list = byClaim.get(attempt.claimId);
    if (list) list.push(attempt);
    else byClaim.set(attempt.claimId, [attempt]);
  }
  for (const list of byClaim.values()) {
    list.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  }

  const ready: string[] = [];
  for (const id of dueIds) {
    const history = byClaim.get(id) ?? [];
    let failures = 0;
    let lastFailure: Date | null = null;
    for (const attempt of history) {
      if (!attempt.failed) break;
      failures += 1;
      if (!lastFailure) lastFailure = attempt.finishedAt;
    }
    if (failures === 0 || !lastFailure) {
      ready.push(id);
      continue;
    }
    if (now.getTime() - lastFailure.getTime() >= resolveClaimBackoffMs(failures)) ready.push(id);
  }
  return ready;
}

/** Read claim ids out of a finished resolve job's stored result. */
export function attemptsFromResolveJob(job: {
  finishedAt: Date | null;
  result: unknown;
}): ResolveAttemptRecord[] {
  if (!job.finishedAt || !job.result || typeof job.result !== "object") return [];
  const body = job.result as { reports?: unknown; errors?: unknown };
  const out: ResolveAttemptRecord[] = [];
  if (Array.isArray(body.reports)) {
    for (const report of body.reports) {
      const claimId = claimIdOf(report);
      if (claimId) out.push({ claimId, finishedAt: job.finishedAt, failed: false });
    }
  }
  if (Array.isArray(body.errors)) {
    for (const error of body.errors) {
      const claimId = claimIdOf(error);
      if (claimId) out.push({ claimId, finishedAt: job.finishedAt, failed: true });
    }
  }
  return out;
}

/**
 * A periodic pass that found nothing and threw nothing. Single-claim results
 * are a report object, not this shape, so they are kept.
 */
export function isNoopResolveResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const body = result as { reports?: unknown; errors?: unknown };
  if (!("reports" in body) || !("errors" in body)) return false;
  return Array.isArray(body.reports) && body.reports.length === 0 && Array.isArray(body.errors) && body.errors.length === 0;
}

export type ResolvePlan =
  | { type: "one"; claimId: string }
  | { type: "ids"; claimIds: string[] }
  | { type: "due"; limit: number };

/**
 * `claimId` is a manual single-claim resolve. `claimIds` is the periodic
 * pass (already filtered). Anything else is "whatever is due", which is the
 * manual resolve-all button and does not apply backoff.
 */
export function planResolveJob(payload: Record<string, unknown>): ResolvePlan {
  if (typeof payload.claimId === "string" && payload.claimId.length > 0) {
    return { type: "one", claimId: payload.claimId };
  }
  if (Array.isArray(payload.claimIds)) {
    const limit = positiveInt(payload.limit, PERIODIC_RESOLVE_LIMIT);
    const claimIds = payload.claimIds
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, limit);
    return { type: "ids", claimIds };
  }
  return { type: "due", limit: positiveInt(payload.limit, PERIODIC_RESOLVE_LIMIT) };
}

export type PeriodicResolveDecision =
  | { action: "skip"; reason: "disabled" | "open" | "idle" | "backoff" }
  | { action: "enqueue"; claimIds: string[] };

export function decidePeriodicResolve(input: {
  enabled: boolean;
  openJob: boolean;
  dueIds: readonly string[];
  attempts: readonly ResolveAttemptRecord[];
  now: Date;
  limit?: number;
}): PeriodicResolveDecision {
  if (!input.enabled) return { action: "skip", reason: "disabled" };
  if (input.openJob) return { action: "skip", reason: "open" };
  const ready = claimsReadyToResolve(input.dueIds, input.attempts, input.now);
  if (ready.length === 0) {
    return { action: "skip", reason: input.dueIds.length === 0 ? "idle" : "backoff" };
  }
  const limit = input.limit ?? PERIODIC_RESOLVE_LIMIT;
  return { action: "enqueue", claimIds: ready.slice(0, limit) };
}

function claimIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { claimId?: unknown }).claimId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
