/**
 * Proxy POST /api/rebuild to the Coolify API. The worker runs the rebuild.
 * This route returns `{ jobId }`.
 */
import { proxyWrite } from "@/lib/proxy-write";

export const runtime = "nodejs";

export function POST(req: Request) {
  return proxyWrite("/rebuild", req);
}
