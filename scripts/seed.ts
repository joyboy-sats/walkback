/**
 * Seed the ledger from data/claims.json.
 *
 *   npm run seed
 *   npm run seed -- data/claims.json
 *
 * The file is posts the owner collected. Real posts are the dataset; an entry
 * with `synthetic: true` is a demo fallback and is labelled as such. This
 * script refuses to invent claims of its own. Needs DATABASE_URL, the Walrus
 * delegate key, and — for posts that omit `claims` or `snapshot` — the model
 * key and Tatum.
 */
import "dotenv/config";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
config({ path: ".env.local" });

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Seed runs on the Coolify worker host, next to Postgres. Add DATABASE_URL to .env.local there.\n" +
      "Do not copy .env.example onto Vercel. Vercel never receives DATABASE_URL.",
  );
  process.exit(1);
}

const { requireDelegateKey } = await import("../lib/env");
const { finishSeed, runSeed } = await import("../lib/seed-run");

requireDelegateKey();

const file = process.argv[2] ?? "data/claims.json";

try {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const summary = await runSeed(raw);
  console.log(summary);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await finishSeed();
}
