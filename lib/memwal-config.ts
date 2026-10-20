/**
 * Credentials for a Walrus list or write client.
 *
 * The full `lib/env.ts` schema also checks Tatum and Postgres. A list script
 * must run when those are unset or not valid URLs. This parser reads only the
 * three MemWal fields and ignores everything else in the environment.
 */
import { z } from "zod";

const hex64 = /^0x[0-9a-fA-F]{64}$/;

const schema = z.object({
  MEMWAL_ACCOUNT_ID: z.string().regex(hex64, "must be 0x + 64 hex chars"),
  MEMWAL_PRIVATE_KEY: z
    .string()
    .min(32, "delegate private key looks truncated")
    .refine((v) => !v.includes("://"), "expected a key, not a URL"),
  MEMWAL_SERVER_URL: z
    .string()
    .url()
    .default("https://relayer.memory.walrus.xyz")
    .refine((v) => !v.includes("staging"), "staging relayer is not allowed"),
});

export interface MemwalConfig {
  accountId: string;
  privateKey: string;
  serverUrl: string;
}

/** Parse just the MemWal fields. Other keys on `source` are ignored. */
export function parseMemwalConfig(source: Record<string, string | undefined>): MemwalConfig {
  const parsed = schema.safeParse({
    MEMWAL_ACCOUNT_ID: source.MEMWAL_ACCOUNT_ID,
    MEMWAL_PRIVATE_KEY: source.MEMWAL_PRIVATE_KEY,
    MEMWAL_SERVER_URL: source.MEMWAL_SERVER_URL,
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`invalid MemWal configuration:\n${lines.join("\n")}`);
  }
  return {
    accountId: parsed.data.MEMWAL_ACCOUNT_ID,
    privateKey: parsed.data.MEMWAL_PRIVATE_KEY,
    serverUrl: parsed.data.MEMWAL_SERVER_URL,
  };
}

export function requireMemwalConfig(): MemwalConfig {
  return parseMemwalConfig(process.env);
}
