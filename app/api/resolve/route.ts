/**
 * POST /api/resolve
 *
 * Adjudicate claims whose deadline has passed.
 *
 * Body:
 *   { claimId: string }   resolve one claim
 *   { due: true }         resolve every matured pending claim (capped)
 *
 * Each resolution costs ~6s per memory written and a resolved claim writes two
 * (resolution + score version), so a batch of 10 is over a minute. The route
 * caps the batch and reports partial progress instead of timing out silently.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveClaim, resolveDueClaims } from "@/lib/resolve";

export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.union([
  z.object({ claimId: z.string().uuid() }),
  z.object({ due: z.literal(true), limit: z.number().int().min(1).max(25).optional() }),
]);

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
    if ("claimId" in parsed) {
      return NextResponse.json(await resolveClaim(parsed.claimId));
    }
    const limit = parsed.limit ?? 10;
    return NextResponse.json(await resolveDueClaims(new Date(), limit));
  } catch (err) {
    return NextResponse.json(
      { error: "resolve failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
