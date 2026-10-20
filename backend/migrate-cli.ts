/**
 * Apply migrations from a Coolify one-off or `npm run db:migrate`.
 *
 * Does not load `lib/env.ts`, so it only needs `DATABASE_URL`. The API and
 * the worker call the same `applyMigrations` on boot.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { applyMigrations } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

await applyMigrations(url);
console.log("migrations applied");
