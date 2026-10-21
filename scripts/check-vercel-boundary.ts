/**
 * Exit 1 when app/ can see Postgres or a server secret.
 *
 *   npm run check:vercel
 */
import { scanApp } from "../lib/vercel-boundary";
import { finishScript } from "../lib/script-exit";

const hits = scanApp(process.cwd());
if (hits.length > 0) {
  console.error("Vercel boundary failed. app/ must not reach lib/db or lib/env.");
  for (const hit of hits) console.error(`  ${hit}`);
  await finishScript(1);
} else {
  console.log("vercel boundary ok");
  await finishScript(0);
}
