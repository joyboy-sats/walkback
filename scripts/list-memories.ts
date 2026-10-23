/**
 * Count memories the relayer lists for this delegate.
 *
 *   npm run list:memories
 *   npm run list:memories -- --keys
 *
 * Reads `.env.local` on the machine that has the delegate key (the Coolify
 * worker, or a laptop). Only `MEMWAL_ACCOUNT_ID`, `MEMWAL_PRIVATE_KEY`, and
 * `MEMWAL_SERVER_URL` are required. Tatum and Postgres are not. The default
 * print is counts only: no memory text, no blob ids, no keys.
 *
 * `--keys` (alias `--verbose`) is still read-only. It recalls each namespace
 * and prints one line per live memory: `kind refId idempotencyKey`. The key
 * is derived from the fenced JSON (the key this product sends). A memory
 * whose text did not come back is `kind - -`. The delegate key, memory text,
 * and blob ids are not printed. `MEMWAL_AGENT_ID` is the delegate public key
 * from `getPublicKeyHex()`; this script does not read or print it.
 *
 * Run this before trusting Replace. A thrown error here means the live
 * `GET /v1/owners/:owner/memories` route or the signing path still needs a look.
 */
import "dotenv/config";
import { config } from "dotenv";
import { finishScript } from "../lib/script-exit";
import type { ListedMemory } from "../lib/memory-list";
import type { Namespace } from "../lib/types";

config({ path: ".env.local" });

const { destroyMemwal, listAllMemories, recallMemory } = await import("../lib/memwal");
const { formatRelayerListLines } = await import("../lib/stored-resolution");
const { formatMemoryIndexLine, indexMemoryText, wantsMemoryIndex } = await import("../lib/memory-index");
const { RECALL_PLAINTEXT_CAP } = await import("../lib/memory-list");

const showKeys = wantsMemoryIndex(process.argv);

let code = 0;
try {
  const walk = await listAllMemories();
  const deletedIds = new Set(walk.deleted.map((row) => row.memoryId));
  const byNamespace = new Map<string, number>();
  const live: ListedMemory[] = [];
  for (const memory of walk.memories) {
    if (deletedIds.has(memory.memoryId)) continue;
    live.push(memory);
    byNamespace.set(memory.namespaceId, (byNamespace.get(memory.namespaceId) ?? 0) + 1);
  }
  const counts: Record<string, number> = {};
  for (const [name, count] of byNamespace) counts[name] = count;
  for (const line of formatRelayerListLines(live.length, counts)) console.log(line);
  console.log(`live ${live.length}`);
  console.log(`deleted ${walk.deleted.length}`);
  console.log(`pages ${walk.pages}`);
  console.log(`resyncs ${walk.resyncs}`);
  for (const name of [...byNamespace.keys()].sort()) {
    console.log(`${name} ${byNamespace.get(name)}`);
  }

  if (showKeys) {
    const textByBlob = new Map<string, string>();
    for (const memory of live) {
      if (memory.text && memory.blobId) textByBlob.set(`${memory.namespaceId}\0${memory.blobId}`, memory.text);
    }
    for (const namespace of [...byNamespace.keys()].sort()) {
      const count = byNamespace.get(namespace) ?? 0;
      if (count === 0) continue;
      try {
        const hits = await recallMemory({
          query: "Walkback",
          namespace: namespace as Namespace,
          limit: Math.min(RECALL_PLAINTEXT_CAP, count),
          sort: "relevance",
        });
        for (const hit of hits) {
          if (hit.blobId && hit.text) textByBlob.set(`${namespace}\0${hit.blobId}`, hit.text);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`recall ${namespace} failed: ${message}`);
      }
    }
    const lines = live
      .map((memory) =>
        formatMemoryIndexLine(
          indexMemoryText(memory.namespaceId, memory.blobId ? textByBlob.get(`${memory.namespaceId}\0${memory.blobId}`) : undefined),
        ),
      )
      .sort();
    console.log("keys");
    for (const line of lines) console.log(line);
    const unread = lines.filter((line) => line.endsWith(" - -")).length;
    console.log(`indexed ${lines.length - unread}`);
    console.log(`unread ${unread}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  destroyMemwal();
}

await finishScript(code);
