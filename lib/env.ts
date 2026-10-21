/**
 * Validated environment. Server-only.
 *
 * Callers must have loaded `.env.local` before importing this module.
 * Scripts do that via the bootstrap at the top of each file:
 *
 *   import "dotenv/config";
 *   import { config } from "dotenv";
 *   config({ path: ".env.local" });
 *
 * The Next.js app gets env from Vercel, so it needs no bootstrap.
 */
import { z } from "zod";

// Hard guard: a delegate key must never reach a browser bundle. If this module
// is ever pulled into client code, fail loudly instead of shipping the key.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/env.ts was imported into client code. The Walrus Memory delegate key " +
      "must stay server-side. Move this call behind a route handler.",
  );
}

const hex64 = /^0x[0-9a-fA-F]{64}$/;

const delegateKey = z
  .string()
  .min(32, "delegate private key looks truncated")
  .refine((v) => !v.includes("://"), "expected a key, not a URL");

const schema = z.object({
  // Optional here so the Vercel process can read Postgres and enqueue jobs
  // without the delegate key. The worker calls requireDelegateKey() before
  // it writes.
  MEMWAL_ACCOUNT_ID: z.string().regex(hex64, "must be 0x + 64 hex chars").optional(),
  MEMWAL_PRIVATE_KEY: delegateKey.optional(),
  MEMWAL_SERVER_URL: z
    .string()
    .url()
    .default("https://relayer.memory.walrus.xyz")
    .refine((v) => !v.includes("staging"), "staging relayer is not allowed"),

  TATUM_API_KEY: z.string().min(1).optional(),
  TATUM_SUI_RPC_URL: z
    .string()
    .url()
    .default("https://sui-mainnet.gateway.tatum.io"),
  TATUM_RATE_URL: z
    .string()
    .url()
    .default("https://api.tatum.io/v4/data/rate/symbol"),

  DATABASE_URL: z.string().url().optional(),
  DEMO_MODE: z.enum(["live", "replay"]).default("live"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Drop the cached parse. Tests use this; production reads env once. */
export function resetEnvForTests(): void {
  cached = null;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`invalid environment:\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

/** For the replay-mode demo: proves no live call is attempted. */
export function isReplay(): boolean {
  return env().DEMO_MODE === "replay";
}

/**
 * The Walrus delegate key. Required on the worker and on seed. Absent on Vercel.
 */
export function requireDelegateKey(): { accountId: string; privateKey: string; serverUrl: string } {
  const e = env();
  if (!e.MEMWAL_ACCOUNT_ID || !e.MEMWAL_PRIVATE_KEY) {
    throw new Error(
      "MEMWAL_ACCOUNT_ID and MEMWAL_PRIVATE_KEY are required on the worker. Leave them unset on Vercel.",
    );
  }
  return {
    accountId: e.MEMWAL_ACCOUNT_ID,
    privateKey: e.MEMWAL_PRIVATE_KEY,
    serverUrl: e.MEMWAL_SERVER_URL,
  };
}
