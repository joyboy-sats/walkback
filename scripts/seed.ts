/**
 * Seed the ledger from data/claims.json.
 *
 *   npm run seed
 *   npm run seed -- data/claims.json
 *
 * Run this in the Coolify worker container's terminal. That container already
 * has DATABASE_URL, the Walrus delegate key, and TATUM_API_KEY. Postgres is
 * on Coolify's internal network, so a laptop cannot open it. Migrations apply
 * when the worker and the API boot; this script does not migrate.
 *
 * The committed file is real posts. An entry with `synthetic: true` is a demo
 * fallback and is labelled as such. This script refuses to invent claims of
 * its own. Every post already has `claims`, and replay posts set
 * `snapshot: null`, so the model is not called. It does call Tatum, because
 * tx_replay claims whose deadlines have passed are resolved at the end.
 *
 * Progress goes to stdout (`post i/N`, each write, the resolve phase). A
 * timed-out write fails that post, leaves its marker unset, and the process
 * exits non-zero with a summary. Run it again to resume.
 */
import "dotenv/config";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
config({ path: ".env.local" });

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Run this in the Coolify worker container's terminal. That process already has DATABASE_URL.\n" +
      "The database is on Coolify's internal network, so a laptop cannot open it.\n" +
      "Do not copy .env.example onto Vercel. Vercel never receives DATABASE_URL.",
  );
  process.exit(1);
}

const { requireDelegateKey } = await import("../lib/env");
const { finishSeed, runSeed } = await import("../lib/seed-run");

requireDelegateKey();

const file = process.argv[2] ?? "data/claims.json";

let code = 0;
try {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = await runSeed(raw);
  console.log(result.summary);
  if (!result.ok) code = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  try {
    await finishSeed();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    code = 1;
  }
}

// `rememberAndWait` and the Sui client can leave a socket open after the
// deadline aborts it. Closing the pool is not enough for the event loop to
// drain. Exit so a timed-out seed does not sit in the container.
process.exit(code);
