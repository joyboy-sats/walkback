/**
 * Postgres client — the queryable projection.
 *
 * Uses the `postgres` package (postgres.js), a standard Postgres driver.
 * The database is Postgres on the Coolify private network. There is no Neon
 * driver and no Neon-only API. A normal `postgres://` URL works, including
 * one that is not reachable from the public internet.
 *
 * Lazy singleton: importing this module never opens a connection at build time.
 */
import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

let sql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (db) return db;
  const url = env().DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. The projection needs Postgres; Walrus Memory " +
        "holds the truth but cannot be queried by field.",
    );
  }
  sql = postgres(url, { max: 5, prepare: false });
  db = drizzle(sql, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = null;
  db = null;
}

export { schema };
export * from "./schema";
