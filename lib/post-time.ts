/**
 * Post time from `data/claims.json`. The seed file is the only source added
 * here. This module does not call X.
 *
 * `params.since` is the check window. For a price touch it was copied from
 * the post time; for `tx_replay` it is not. Callers that already stored
 * `claims.published_at` should prefer that column.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimExternalId } from "./ids";

interface SeedFile {
  posts?: Array<{
    id?: unknown;
    published_at?: unknown;
    source_url?: unknown;
    claims?: unknown;
  }>;
}

let cached: { byExternalId: Map<string, string>; bySourceUrl: Map<string, string> } | null = null;

function iso(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function load(): { byExternalId: Map<string, string>; bySourceUrl: Map<string, string> } {
  if (cached) return cached;
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "claims.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as SeedFile;
  const byExternalId = new Map<string, string>();
  const urlTimes = new Map<string, Set<string>>();
  for (const post of file.posts ?? []) {
    if (typeof post.id !== "string") continue;
    const published = iso(post.published_at);
    if (!published) continue;
    const claims = Array.isArray(post.claims) ? post.claims : [];
    claims.forEach((_, index) => {
      byExternalId.set(claimExternalId(post.id as string, index), published);
    });
    if (typeof post.source_url === "string" && post.source_url.trim()) {
      const set = urlTimes.get(post.source_url) ?? new Set<string>();
      set.add(published);
      urlTimes.set(post.source_url, set);
    }
  }
  const bySourceUrl = new Map<string, string>();
  for (const [url, times] of urlTimes) {
    if (times.size === 1) {
      const [only] = times;
      if (only) bySourceUrl.set(url, only);
    }
  }
  cached = { byExternalId, bySourceUrl };
  return cached;
}

/** ISO time from the seed file, or null when this claim is not in it. */
export function seedPublishedAt(
  externalId: string | null | undefined,
  sourceUrl: string | null | undefined,
): string | null {
  const maps = load();
  if (externalId) {
    const found = maps.byExternalId.get(externalId);
    if (found) return found;
  }
  if (sourceUrl) return maps.bySourceUrl.get(sourceUrl) ?? null;
  return null;
}
