/**
 * Apply SQL migrations with the standard postgres.js driver.
 *
 * API and worker can boot together. `pg_advisory_lock` makes one of them wait
 * until the other has finished the migrator, then both see the same schema.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import postgres from "postgres";

/** Stable lock id for this repo. Not derived from user input. */
export const MIGRATION_LOCK_KEY = 814_202_611;

export async function applyMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), "drizzle") });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
