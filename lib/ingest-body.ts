/**
 * Body of POST /ingest. Shared so the Coolify API validates the same shape
 * the UI sends. No server-only import: the frontend must be able to type
 * against this without pulling in the database client.
 */
import { z } from "zod";

export const ingestBody = z.object({
  handle: z.string().min(1).max(120),
  platform: z.enum(["x", "substack", "rss", "onchain", "other"]).default("x"),
  text: z.string().min(1).max(20_000),
  publishedAt: z.string().datetime().optional(),
  suiAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{1,64}$/, "must be a Sui address")
    .optional(),
  displayName: z.string().max(120).optional(),
});

export type IngestBody = z.infer<typeof ingestBody>;
