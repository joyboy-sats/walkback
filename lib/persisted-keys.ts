/**
 * Which memory writes are already durable.
 *
 * A key is persisted when `memory_log.idempotency_key` has it, or when the
 * domain row already carries a blob id (rows written before that column
 * existed, and rows stamped on the claim or source). Score keys include the
 * version, because several score memories share one source id.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findPersistedKeys(
  writes: readonly { idempotencyKey: string }[],
): Promise<Set<string>> {
  const keys = writes.map((w) => w.idempotencyKey);
  const found = new Set<string>();
  if (keys.length === 0) return found;

  const db = getDb();
  const logged = await db
    .select({ key: schema.memoryLog.idempotencyKey })
    .from(schema.memoryLog)
    .where(inArray(schema.memoryLog.idempotencyKey, keys));
  for (const row of logged) {
    if (row.key) found.add(row.key);
  }

  for (const key of keys) {
    if (found.has(key)) continue;
    if (await domainBlobExists(key)) found.add(key);
  }
  return found;
}

async function domainBlobExists(key: string): Promise<boolean> {
  const db = getDb();
  if (key.startsWith("claim:")) {
    const id = key.slice("claim:".length);
    if (!UUID.test(id)) return false;
    const [row] = await db
      .select({ blob: schema.claims.walrusBlobId })
      .from(schema.claims)
      .where(eq(schema.claims.id, id))
      .limit(1);
    return Boolean(row?.blob);
  }
  if (key.startsWith("source:")) {
    const id = key.slice("source:".length);
    if (!UUID.test(id)) return false;
    const [row] = await db
      .select({ blob: schema.sources.walrusBlobId })
      .from(schema.sources)
      .where(eq(schema.sources.id, id))
      .limit(1);
    if (row?.blob) return true;
    const [log] = await db
      .select({ id: schema.memoryLog.id })
      .from(schema.memoryLog)
      .where(and(eq(schema.memoryLog.kind, "source"), eq(schema.memoryLog.refId, id)))
      .limit(1);
    return Boolean(log);
  }
  if (key.startsWith("resolution:")) {
    const id = key.slice("resolution:".length);
    if (!UUID.test(id)) return false;
    const [row] = await db
      .select({ blob: schema.resolutions.walrusBlobId })
      .from(schema.resolutions)
      .where(eq(schema.resolutions.claimId, id))
      .limit(1);
    return Boolean(row?.blob);
  }
  const score = /^score:([0-9a-f-]{36}):v(\d+)$/i.exec(key);
  if (score) {
    const sourceId = score[1]!;
    const version = Number(score[2]);
    const [row] = await db
      .select({ blob: schema.scoreVersions.walrusBlobId })
      .from(schema.scoreVersions)
      .where(and(eq(schema.scoreVersions.sourceId, sourceId), eq(schema.scoreVersions.version, version)))
      .limit(1);
    return Boolean(row?.blob);
  }
  return false;
}
