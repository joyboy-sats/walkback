/**
 * Shared startup for the API and the worker. Both run on Coolify, both need
 * the private Postgres URL, and both apply migrations before doing work.
 */
import { env } from "../lib/env";
import { applyMigrations } from "./migrate";

export async function boot(): Promise<void> {
  const e = env();
  if (!e.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. Point it at the Postgres service on the Coolify network, not a public host.",
    );
  }
  await applyMigrations(e.DATABASE_URL);
}
