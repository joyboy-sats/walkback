/**
 * Retry-safe memory writes.
 *
 * `rememberBulkAndWait` in memwal 0.1.8 takes `{ text, namespace }` only.
 * There is no per-item `idempotencyKey`. `waitForRememberJobs` returns
 * partial blob ids when the wait times out, but a non-transient poll error
 * throws and drops the blob ids it had already collected. A process crash
 * during the wait drops them too. The jobs can still finish on the relayer,
 * so sending the same batch again appends a second copy.
 *
 * The durable path writes one item at a time with `rememberAndWait`, which
 * does take `idempotencyKey`, records the blob id before the next item, and
 * stops at the first failure. A retry sends only the items that were not
 * recorded.
 */

export interface DurableStepResult {
  blobId: string;
  id?: string;
}

export function pendingWrites<T extends { idempotencyKey: string }>(
  writes: readonly T[],
  persistedKeys: ReadonlySet<string>,
): T[] {
  return writes.filter((w) => !persistedKeys.has(w.idempotencyKey));
}

/**
 * Persist each success before the next write. Later items are not sent after
 * a failure, including a failure to record the blob id.
 */
export async function writeDurable<T>(
  items: readonly T[],
  writeOne: (item: T) => Promise<DurableStepResult>,
  onPersisted: (item: T, result: DurableStepResult) => Promise<void>,
): Promise<{ persisted: Array<{ item: T; result: DurableStepResult }>; error?: string }> {
  const persisted: Array<{ item: T; result: DurableStepResult }> = [];
  for (const item of items) {
    let result: DurableStepResult;
    try {
      result = await writeOne(item);
    } catch (err) {
      return { persisted, error: message(err) };
    }
    if (!result.blobId) {
      return { persisted, error: "write returned no blob id" };
    }
    try {
      await onPersisted(item, result);
    } catch (err) {
      return {
        persisted,
        error: `blob ${result.blobId} was written but not recorded: ${message(err)}`,
      };
    }
    persisted.push({ item, result });
  }
  return { persisted };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
