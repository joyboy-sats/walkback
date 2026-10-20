/**
 * Gate for the public Coolify API.
 *
 * Reads are open. Writes require `x-admin-token` equal to `ADMIN_TOKEN`.
 * The browser sends that header after the owner types the token; Vercel never
 * stores it. Comparison is timing-safe, and a length mismatch is a plain
 * rejection so a short guess cannot throw.
 */
import { timingSafeEqual } from "node:crypto";

export function tokenMatches(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(secret);
  if (got.length !== want.length || got.length === 0) return false;
  return timingSafeEqual(got, want);
}

/**
 * CORS for the configured frontend origin only. A request with no `Origin`
 * (the Vercel server, curl, the health check) is not a browser call and needs
 * no allow header. Any other browser origin gets no allow header, so the
 * browser refuses to expose the response.
 */
export function corsHeaders(
  requestOrigin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-admin-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (requestOrigin && allowed.includes(requestOrigin)) {
    headers["access-control-allow-origin"] = requestOrigin;
  }
  return headers;
}

/**
 * Preflight from a browser origin that is not on the allow list is rejected.
 * A request with no Origin is not a browser preflight and stays 204.
 */
export function preflightStatus(
  requestOrigin: string | undefined,
  allowed: readonly string[],
): 204 | 403 {
  if (requestOrigin && !allowed.includes(requestOrigin)) return 403;
  return 204;
}
