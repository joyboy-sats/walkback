/**
 * Postgres client — the queryable projection.
 *
 * Uses the `postgres` package (postgres.js), a standard Postgres driver.
 * The database is Postgres on the Coolify internal network. There is no Neon
 * driver. Only the Coolify API and the worker open this URL. Vercel does not.
 *
 * Lazy singleton: importing this module never opens a connection at build time.
 */
import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withDeadline } from "../bounded";
import { env } from "../env";
import * as schema from "./schema";

let sql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Session limits applied to the next pool this process opens.
 *
 * The worker leaves these unset: a rebuild can legitimately run longer than
 * a seed statement. The seed sets them so a lock wait cannot sit forever.
 * postgres.js sends `connection` entries as startup parameters, which is how
 * `statement_timeout` and `lock_timeout` reach the session.
 */
let poolConfig: {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  connectTimeoutSeconds?: number;
} | null = null;

export function configureDbPool(config: {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  connectTimeoutSeconds?: number;
}): void {
  if (sql) throw new Error("configureDbPool must run before the pool opens");
  poolConfig = config;
}

export function getDb() {
  if (db) return db;
  const url = env().DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. The projection needs Postgres; Walrus Memory " +
        "holds the truth but cannot be queried by field.",
    );
  }
  sql = postgres(url, {
    max: 5,
    prepare: false,
    ...(poolConfig?.connectTimeoutSeconds ? { connect_timeout: poolConfig.connectTimeoutSeconds } : {}),
    ...(poolConfig
      ? {
          connection: {
            ...(poolConfig.statementTimeoutMs ? { statement_timeout: poolConfig.statementTimeoutMs } : {}),
            ...(poolConfig.lockTimeoutMs ? { lock_timeout: poolConfig.lockTimeoutMs } : {}),
          },
        }
      : {}),
  });
  db = drizzle(sql, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  const closing = sql;
  sql = null;
  db = null;
  if (!closing) return;
  // `end({ timeout: 5 })` is supposed to give up after 5s. Bound the await
  // as well, so a driver that does not honour that option cannot hold the
  // seed process open. A late settlement is ignored by `withDeadline`.
  await withDeadline(closing.end({ timeout: 5 }), 8_000, "close database pool");
}

export { schema };
export * from "./schema";
