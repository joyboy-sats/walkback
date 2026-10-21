/**
 * Walkback — write latency probe.
 *
 * Measures how long a single memory write actually takes on mainnet, and how
 * that compares to a bulk write. The answer determines how the seed batch has
 * to be scheduled: at ~32s per memory, 40 claims is 20+ minutes of wall clock.
 *
 * Run:  npx tsx scripts/timing.ts
 *
 * Writes to the throwaway namespace `walkback.timing`. Safe to re-run.
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { MemWal } from "@mysten-incubation/memwal";
import { finishScript } from "../lib/script-exit";

const NS = "walkback.timing";
const TAG = `timing-${Date.now()}`;

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: NS,
  requestTimeoutMs: 60_000,
});

async function main() {
  // Sequential singles — the first one pays the SEAL session build cost,
  // so the interesting number is #2 onward.
  for (let i = 1; i <= 4; i++) {
    const t = Date.now();
    const r = await memwal.rememberAndWait(`latency probe ${i} ${TAG}`, NS, {
      pollIntervalMs: 500,
      timeoutMs: 180_000,
      idempotencyKey: `${TAG}-single-${i}`,
    });
    console.log(
      `single #${i}   ${((Date.now() - t) / 1000).toFixed(1)}s   ${r.blob_id.slice(0, 16)}…`,
    );
  }

  // Bulk: 5 items in one request. Server parallelises embed/encrypt/upload.
  const t2 = Date.now();
  const bulk = await memwal.rememberBulkAndWait(
    Array.from({ length: 5 }, (_, i) => ({
      text: `latency bulk item ${i} ${TAG}`,
      namespace: NS,
    })),
    { pollIntervalMs: 500, timeoutMs: 300_000 },
  );
  const bulkMs = Date.now() - t2;
  console.log(
    `bulk   x5   ${(bulkMs / 1000).toFixed(1)}s   ok=${bulk.succeeded} fail=${bulk.failed}`,
  );
  console.log(
    `            ${(bulkMs / 1000 / Math.max(1, bulk.succeeded)).toFixed(1)}s per item`,
  );

  console.log(`\nnamespace ${NS} now holds these probes; list with listNamespaces().`);
}

main()
  .then(() => finishScript(0, { close: async () => { memwal.destroy(); } }))
  .catch((e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
    return finishScript(1, { close: async () => { memwal.destroy(); } });
  });
