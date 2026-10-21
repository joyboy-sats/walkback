/**
 * Count memories the relayer lists for this delegate.
 *
 *   npm run list:memories
 *
 * Reads `.env.local` on the machine that has the delegate key (the Coolify
 * worker, or a laptop). Only `MEMWAL_ACCOUNT_ID`, `MEMWAL_PRIVATE_KEY`, and
 * `MEMWAL_SERVER_URL` are required. Tatum and Postgres are not. Prints counts
 * only: no memory text, no blob ids, no keys. `MEMWAL_AGENT_ID` is the
 * delegate public key from `getPublicKeyHex()`; this script does not read or
 * print it.
 *
 * Run this before trusting Replace. A thrown error here means the live
 * `GET /v1/owners/:owner/memories` route or the signing path still needs a look.
 */
import "dotenv/config";
import { config } from "dotenv";
import { finishScript } from "../lib/script-exit";

config({ path: ".env.local" });

const { destroyMemwal, listAllMemories } = await import("../lib/memwal");

let code = 0;
try {
  const walk = await listAllMemories();
  const deletedIds = new Set(walk.deleted.map((row) => row.memoryId));
  const byNamespace = new Map<string, number>();
  let live = 0;
  for (const memory of walk.memories) {
    if (deletedIds.has(memory.memoryId)) continue;
    live += 1;
    byNamespace.set(memory.namespaceId, (byNamespace.get(memory.namespaceId) ?? 0) + 1);
  }
  console.log(`live ${live}`);
  console.log(`deleted ${walk.deleted.length}`);
  console.log(`pages ${walk.pages}`);
  console.log(`resyncs ${walk.resyncs}`);
  for (const name of [...byNamespace.keys()].sort()) {
    console.log(`${name} ${byNamespace.get(name)}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  destroyMemwal();
}

await finishScript(code);
