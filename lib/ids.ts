/**
 * Stable identifiers shared by ingest and the seed script.
 *
 * Postgres generates random uuids for posts pasted in the UI. Seeded posts
 * cannot: a second `npm run seed` has to find the same row and the same
 * memory key, or the ledger doubles. The id is a hash, not a lookup.
 */
import { createHash } from "node:crypto";

/** UUID-shaped hex derived from `key`. The same key always returns the same id. */
export function stableUuid(key: string): string {
  const h = createHash("sha256").update(`walkback.v1:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** External id stored on a seeded claim. Unique per post and claim index. */
export function claimExternalId(postId: string, index: number): string {
  return `post:${postId}:${index}`;
}

export function claimExternalPrefix(postId: string): string {
  return `post:${postId}:`;
}
