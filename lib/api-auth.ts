/**
 * Gate for the public Coolify API.
 *
 * Reads are open. Writes require a shared secret sent as
 * `Authorization: Bearer <API_SHARED_SECRET>`. The browser never sees that
 * value: the Vercel server attaches it when it proxies a write. Comparison
 * is timing-safe, and a length mismatch is a plain rejection so a short
 * guess cannot throw.
 */
import { timingSafeEqual } from "node:crypto";

export function authorizeBearer(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  const got = Buffer.from(token);
  const want = Buffer.from(secret);
  if (got.length !== want.length || got.length === 0) return false;
  return timingSafeEqual(got, want);
}

/**
 * CORS for the Vercel origin only. A request with no `Origin` (the worker,
 * curl, the Vercel server) is not a browser call and needs no allow header.
 * A browser call from anywhere else gets no allow header, so the browser
 * refuses to expose the response.
 */
export function corsHeaders(
  requestOrigin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (requestOrigin && allowed.includes(requestOrigin)) {
    headers["access-control-allow-origin"] = requestOrigin;
  }
  return headers;
}
