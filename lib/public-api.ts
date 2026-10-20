/**
 * How the Vercel UI talks to the Coolify API.
 *
 * `NEXT_PUBLIC_API_URL` is the public origin of that API. It is not a
 * credential. Reads use `apiGet`. Writes send `x-admin-token` from
 * sessionStorage; the token is never built into the Vercel deployment.
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

export function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new ApiError("NEXT_PUBLIC_API_URL is not set", 500);
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

export async function apiPost(
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: { jobId?: string; error?: string; detail?: string } | null }> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json().catch(() => null)) as { jobId?: string; error?: string; detail?: string } | null;
  return { status: res.status, body: parsed };
}

/**
 * Poll a job the worker is running. Calls `onStatus` for pending and running.
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
    if (!res.ok || !body || !body.status) {
      throw new ApiError(body?.detail || body?.error || `job status failed (${res.status})`, res.status);
    }
    if (body.status === "done" || body.status === "failed") return body;
    onStatus(body.status);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
