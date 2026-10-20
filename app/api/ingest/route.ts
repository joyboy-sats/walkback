/**
 * POST /api/ingest
 *
 * Paste a post, get back the claims that were extracted and the memories that
 * were written.
 *
 * Takes ~1s for extraction plus ~6s per memory written, so this route sets
 * `maxDuration` well above the default and is not called from a page render.
 * On Vercel Hobby the cap is lower than this wants; if you hit it, move the
 * memory write into the background and return the claim ids first.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ingest } from "@/lib/ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

const body = z.object({
  handle: z.string().min(1).max(120),
  platform: z.enum(["x", "substack", "rss", "onchain", "other"]).default("x"),
  text: z.string().min(1).max(20_000),
  /** ISO timestamp the post was published; anchors relative deadlines. */
  publishedAt: z.string().datetime().optional(),
  suiAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{1,64}$/, "must be a Sui address")
    .optional(),
  displayName: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  try {
    const result = await ingest({
      handle: parsed.handle,
      platform: parsed.platform,
      text: parsed.text,
      publishedAt: parsed.publishedAt ?? new Date().toISOString(),
      ...(parsed.suiAddress ? { suiAddress: parsed.suiAddress } : {}),
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "ingest failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
