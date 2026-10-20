/**
 * Apply SQL migrations with the standard postgres.js driver.
 *
 * Runs on API and worker boot so a Coolify deploy does not need a separate
 * machine that can see the private database. Safe to run from both processes:
 * drizzle records applied migrations and takes a lock.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import postgres from "postgres";

export async function applyMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), "drizzle") });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
