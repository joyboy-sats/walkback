/**
 * Browser polling for a job the worker is running.
 *
 * The page posts to a same-origin route, gets `{ jobId }`, then polls
 * `GET /api/jobs/:id`. That route reads Postgres. It does not call Walrus.
 */

export interface JobView {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  result: unknown;
  error: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Poll until the job is done or failed. Calls `onStatus` for pending and running.
 * Stops when the caller flips `isCancelled`, so leaving the page ends the loop.
 */
export async function pollJob(
  jobId: string,
  onStatus: (status: string) => void,
  isCancelled: () => boolean,
): Promise<JobView> {
  for (;;) {
    if (isCancelled()) throw new ApiError("left the page", 499);
    const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (JobView & { detail?: string; error?: string }) | null;
    if (!res.ok || !body || !body.status) {
      throw new ApiError(body?.detail || body?.error || `job status failed (${res.status})`, res.status);
    }
    if (body.status === "done" || body.status === "failed") return body;
    onStatus(body.status);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
