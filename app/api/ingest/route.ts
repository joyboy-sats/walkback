/**
 * Proxy POST /api/ingest to the Coolify API.
 *
 * The browser calls this same-origin route. The shared secret is attached
 * here and never reaches the client. The Coolify API enqueues a job; this
 * route returns `{ jobId }` and does not wait on Walrus.
 */
import { proxyWrite } from "@/lib/proxy-write";

export const runtime = "nodejs";

export function POST(req: Request) {
  return proxyWrite("/ingest", req);
}
