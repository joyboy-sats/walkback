/**
 * Projection writes for the memory log.
 *
 * `memory_log` is the join between the two layers: one row per memory ever
 * written to Walrus, carrying its blob id. The Memory Explorer renders it, and
 * `restore` uses it to know what it should be able to read back.
 *
 * Kept separate from `lib/memwal.ts` so the memory client has no dependency on
 * Postgres — that module is about talking to the relayer, nothing else.
 */
import "server-only";

import { getDb, schema } from "./db";
import type { BulkItemOutcome, MemoryWrite } from "./memwal";

export type MemoryKind = (typeof schema.memoryKindEnum.enumValues)[number];

/** Derive the log kind from the idempotency key's prefix. */
function kindOf(key: string): MemoryKind {
  const prefix = key.split(":")[0];
  switch (prefix) {
    case "source":
    case "claim":
    case "resolution":
    case "score":
    case "digest":
    case "tombstone":
      return prefix;
    default:
      return "claim";
  }
}

/** The domain row this memory describes, if the key encodes one. */
function refIdOf(key: string): string | null {
  const parts = key.split(":");
  const candidate = parts[1];
  if (!candidate) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

/**
 * Record successful writes in the projection. Call with the same aligned
 * `results` array that `writeMemoriesBulk` returned and the `writes` it was
 * given; failed items are skipped, not logged as if they existed.
 */
export async function logMemories(
  writes: MemoryWrite[],
  results: BulkItemOutcome[],
): Promise<void> {
  const rows = results
    .map((r, i) => {
      const w = writes[i];
      if (!w || !r.blobId) return null;
      return {
        kind: kindOf(w.idempotencyKey),
        refId: refIdOf(w.idempotencyKey),
        namespace: r.namespace || w.namespace,
        blobId: r.blobId,
        serverId: r.id ?? null,
        textPreview: w.text.replace(/\s+/g, " ").slice(0, 180),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return;
  await getDb().insert(schema.memoryLog).values(rows);
}
