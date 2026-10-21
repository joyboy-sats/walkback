/**
 * Append a new resolution for claims that were voided.
 *
 * Run this in the Coolify worker container, after the image with the replay
 * fix is deployed. The container already has DATABASE_URL, MEMWAL_PRIVATE_KEY,
 * and TATUM_API_KEY. Postgres is not reachable from a laptop.
 *
 *   npm run reresolve -- \
 *     --source-url https://x.com/_OnChainWatch/status/2112452984638444019 \
 *     --source-url https://x.com/_OnChainWatch/status/2112436525434622020
 *
 * Walrus is append-only. The previous void memory stays. This writes a new
 * resolution memory (`resolution:{claimId}:r2`) and, when a void becomes
 * true or false, a new score version. The projection row is updated to the
 * latest verdict. A claim that is already true or false is skipped unless
 * `--force` is passed. Re-running after a success does not add another hit.
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Run this in the Coolify worker container's terminal. That process already has DATABASE_URL.\n" +
      "The database is on Coolify's internal network, so a laptop cannot open it.",
  );
  process.exit(1);
}

const { requireDelegateKey } = await import("../lib/env");
const { claimsForSourceUrls } = await import("../lib/reads");
const { resolveClaimsById } = await import("../lib/resolve");

requireDelegateKey();

const args = process.argv.slice(2);
const urls: string[] = [];
let force = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--source-url") {
    const url = args[++i];
    if (!url || !url.startsWith("https://")) {
      console.error("--source-url needs an https URL");
      process.exit(1);
    }
    urls.push(url);
    continue;
  }
  console.error(`unknown argument: ${arg}`);
  process.exit(1);
}

if (urls.length === 0) {
  console.error(
    "Pass one or more --source-url values. Example:\n" +
      "  npm run reresolve -- --source-url https://x.com/_OnChainWatch/status/2112452984638444019",
  );
  process.exit(1);
}

const rows = await claimsForSourceUrls(urls);
const found = new Set(rows.map((row) => row.sourceUrl));
const missing = urls.filter((url) => !found.has(url));
if (missing.length > 0) {
  console.error("no claim for:");
  for (const url of missing) console.error(`  ${url}`);
  process.exit(1);
}

console.log(`re-resolving ${rows.length} claim(s); force=${force}`);
for (const row of rows) console.log(`  ${row.status}  ${row.id}  ${row.sourceUrl}`);

const { reports, errors } = await resolveClaimsById(
  rows.map((row) => row.id),
  new Date(),
  undefined,
  { supersede: true, force },
);

for (const report of reports) {
  console.log(
    `${report.claimId}  ${report.outcome}  score ${report.scoreBefore.toFixed(4)} -> ${report.scoreAfter.toFixed(4)}` +
      (report.skipped ? `  skipped: ${report.skipped}` : ""),
  );
  console.log(`  ${report.reason}`);
  if (report.blobs.resolution) console.log(`  resolution ${report.blobs.resolution}`);
  if (report.blobs.score) console.log(`  score ${report.blobs.score}`);
}
for (const error of errors) console.error(`FAILED ${error.claimId}  ${error.error}`);

if (errors.length > 0) process.exit(1);
