/** Proxy POST /api/resolve. The worker adjudicates; this returns `{ jobId }`. */
import { proxyWrite } from "@/lib/proxy-write";

export const runtime = "nodejs";

export function POST(req: Request) {
  return proxyWrite("/resolve", req);
}
