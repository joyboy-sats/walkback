/** Proxy POST /api/restore. The worker rebuilds the relayer index. */
import { proxyWrite } from "@/lib/proxy-write";

export const runtime = "nodejs";

export function POST(req: Request) {
  return proxyWrite("/restore", req);
}
