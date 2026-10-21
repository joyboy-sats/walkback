/**
 * The owner's admin token, kept in this tab only.
 *
 * Vercel has no copy of ADMIN_TOKEN. The ingest and rebuild buttons ask once,
 * store the answer in sessionStorage, and send it as `x-admin-token`. Closing
 * the tab drops it.
 */
const STORAGE_KEY = "walkback.adminToken";

export function getAdminToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  const value = sessionStorage.getItem(STORAGE_KEY);
  return value && value.length > 0 ? value : null;
}

export function clearAdminToken(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Prompt when this tab has no token yet. Throws if the owner dismisses it. */
export function askAdminToken(copy?: { prompt?: string; required?: string }): string {
  const existing = getAdminToken();
  if (existing) return existing;
  const entered = window.prompt(
    copy?.prompt ??
      "Admin token for writes. This is ADMIN_TOKEN on the Coolify backend. It stays in this tab only.",
  );
  const token = entered?.trim() ?? "";
  if (!token) {
    throw new Error(copy?.required ?? "Admin token is required to enqueue a write.");
  }
  sessionStorage.setItem(STORAGE_KEY, token);
  return token;
}
