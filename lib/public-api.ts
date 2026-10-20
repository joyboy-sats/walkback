/**
 * How the Vercel UI talks to the Coolify API.
 *
 * `NEXT_PUBLIC_API_URL` is the public origin of that API. It is not a
 * credential. Writes do not use this module: the browser posts to a same-origin
 * route, and that route attaches the shared secret server-side.
 */

export interface JobView {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
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

export function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) {
    throw new ApiError("NEXT_PUBLIC_API_URL is not set", 500);
  }
  return base.replace(/\/$/, "");
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new ApiError(body?.detail || body?.error || `request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Poll a job the worker is running. Calls `onStatus` for queued and running.
 * Stops when the caller flips `isCancelled`, so leaving the page ends the loop.
 */
export async function pollJob(
  jobId: string,
  onStatus: (status: string) => void,
  isCancelled: () => boolean,
): Promise<JobView> {
  for (;;) {
    if (isCancelled()) throw new ApiError("left the page", 499);
    const res = await fetch(`${apiBase()}/jobs/${jobId}`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (JobView & { detail?: string; error?: string }) | null;
    if (!res.ok || !body) {
      throw new ApiError(body?.detail || body?.error || `job status failed (${res.status})`, res.status);
    }
    if (body.status === "done" || body.status === "error") return body;
    onStatus(body.status);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
