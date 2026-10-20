/**
 * Walkback — environment smoke test.
 *
 * Verifies, in order:
 *   1. env is complete
 *   2. Walrus Memory relayer health (public, unauthenticated)
 *   3. delegate key authenticates; prints the delegate PUBLIC key from
 *      getPublicKeyHex(). That public value is MEMWAL_AGENT_ID.
 *   4. a real write to MAINNET returns a blob_id
 *   5. recall() can read that blob back
 *   6. Tatum Sui RPC answers suix_getBalance
 *
 * Run:  npm run smoke
 *
 * Nothing here is imported by the app. It exists to prove the credentials
 * work before any product code is written, and to hand you the two numbers
 * the submission form asks for.
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { MemWal } from "@mysten-incubation/memwal";

const NS = "walkback.smoke";
const MARK = `walkback-smoke-${Date.now()}`;

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`\n✗ missing env var: ${name}`);
    console.error(`  copy .env.example to .env.local and fill it in\n`);
    process.exit(1);
  }
  return v.trim();
}

function section(n: string) {
  console.log(`\n── ${n} ${"─".repeat(Math.max(0, 60 - n.length))}`);
}

async function main() {
  section("env");
  const accountId = req("MEMWAL_ACCOUNT_ID");
  const privateKey = req("MEMWAL_PRIVATE_KEY");
  const serverUrl = process.env.MEMWAL_SERVER_URL?.trim() || undefined;

  if (serverUrl?.includes("staging")) {
    console.error("✗ MEMWAL_SERVER_URL points at staging. The rules require mainnet.");
    process.exit(1);
  }
  console.log(`account_id     ${accountId}`);
  console.log(`server_url     ${serverUrl ?? "(sdk default: mainnet)"}`);
  console.log(`private_key    ${privateKey.slice(0, 6)}…${privateKey.slice(-4)} (${privateKey.length} chars)`);

  const memwal = MemWal.create({
    key: privateKey,
    accountId,
    ...(serverUrl ? { serverUrl } : {}),
    namespace: NS,
    requestTimeoutMs: 30_000,
  });

  try {
    section("1. relayer health");
    const health = await memwal.health();
    console.log(`status         ${health.status}`);
    console.log(`version        ${health.version}`);
    console.log(`mode           ${health.mode ?? "(not reported)"}`);
    console.log(`write_ready    ${health.write_ready ?? "(not reported)"}`);
    if (health.write_ready === false) {
      console.error("\n✗ relayer says writes are not ready — stop here.");
      process.exit(1);
    }

    section("2. delegate key");
    const pub = await memwal.getPublicKeyHex();
    console.log(`delegate_public_key`);
    console.log(`  ${pub}`);
    console.log(`\n  ↑ MEMWAL_AGENT_ID is this delegate public key (getPublicKeyHex()).`);
    console.log(`    It is a public config value, not a secret.`);

    section("3. namespaces already on this account");
    try {
      const ns = await memwal.listNamespaces({ limit: 50 });
      if (ns.namespaces.length === 0) {
        console.log("(none yet — this account is clean)");
      }
      for (const n of ns.namespaces) {
        console.log(
          `  ${n.name.padEnd(24)} memories=${String(n.memory_count).padEnd(6)} bytes=${n.storage_used}`,
        );
      }
    } catch (e) {
      console.log(`  (listNamespaces failed — non fatal: ${msg(e)})`);
    }

    section("4. write to mainnet");
    console.log(`namespace      ${NS}`);
    console.log(`text           ${MARK}`);
    const t0 = Date.now();
    const written = await memwal.rememberAndWait(
      `Walkback smoke test at ${new Date().toISOString()}. ` +
        `Marker ${MARK}. If you can read this back through recall, the ` +
        `delegate key, account id and mainnet relayer are all working.`,
      NS,
      { pollIntervalMs: 1000, timeoutMs: 120_000, idempotencyKey: MARK },
    );
    const writeMs = Date.now() - t0;
    console.log(`blob_id        ${written.blob_id}`);
    console.log(`owner          ${written.owner}`);
    console.log(`namespace      ${written.namespace}`);
    console.log(`id             ${written.id}`);
    console.log(`elapsed        ${(writeMs / 1000).toFixed(1)}s   ← note this for the seed-batch plan`);

    section("5. read it back");
    // The index is eventually consistent; poll instead of assuming.
    let hit = null as { text: string; distance: number; blob_id: string } | null;
    const r0 = Date.now();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await memwal.recall({ query: MARK, namespace: NS, limit: 5 });
      const found = res.results.find((r) => r.blob_id === written.blob_id || r.text.includes(MARK));
      if (found) {
        hit = found;
        console.log(`found on attempt ${attempt} after ${((Date.now() - r0) / 1000).toFixed(1)}s`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!hit) {
      console.error("\n✗ wrote successfully but recall never returned it.");
      console.error("  the write is on mainnet, so this is an index/visibility issue,");
      console.error("  not a credential issue. try raising the sleep or re-running.");
      process.exit(2);
    }
    console.log(`distance       ${hit.distance.toFixed(4)}`);
    console.log(`text           ${hit.text.slice(0, 80)}…`);

    section("6. tatum sui rpc");
    const tatumKey = process.env.TATUM_API_KEY?.trim();
    const rpcUrl = process.env.TATUM_SUI_RPC_URL?.trim() || "https://sui-mainnet.gateway.tatum.io";
    if (!tatumKey) {
      console.log("skip — TATUM_API_KEY not set");
    } else {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": tatumKey },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "suix_getBalance",
          // sui system state object — always exists, balance is nonzero
          params: ["0x0000000000000000000000000000000000000000000000000000000000000002"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await r.json();
      console.log(`http           ${r.status}`);
      if (body.error) {
        console.error(`✗ tatum error: ${JSON.stringify(body.error)}`);
        console.error(`  (a JSON-RPC error here means the key reached the gateway but`);
        console.error(`   the method/params were rejected — check the key is the Sui one)`);
      } else {
        console.log(`result         ${JSON.stringify(body.result).slice(0, 160)}`);
      }
    }

    section("done");
    console.log(`\nTwo values for the submission form:\n`);
    console.log(`  MEMWAL_AGENT_ID   ${pub}`);
    console.log(`  SUI address       (from memory.walrus.xyz account page)\n`);
    console.log(`Write cost: ${(writeMs / 1000).toFixed(1)}s for one memory.`);
    console.log(`Plan your seed batch against the 30 points/minute delegate limit.\n`);
  } finally {
    memwal.destroy();
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((e) => {
  console.error("\n✗ smoke failed\n");
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  console.error(
    "\nchecklist, in this order:\n" +
      "  1. private key is Ed25519 and registered onchain via addDelegateKey\n" +
      "  2. accountId matches the account that key was registered under\n" +
      "  3. serverUrl is relayer.memory.walrus.xyz, not relayer-staging\n" +
      "  4. node >= 20\n",
  );
  process.exit(1);
});
