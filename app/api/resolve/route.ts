/**
 * Enqueue adjudication of due claims, or of one claim. The worker writes verdicts.
 */
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { enqueueJob } from "@/lib/job-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.union([
  z.object({ claimId: z.string().uuid() }),
  z.object({ due: z.literal(true), limit: z.number().int().min(1).max(25).optional() }),
]);

export async function POST(req: Request) {
  try {
    const raw = await req.json().catch(() => ({ due: true as const }));
    const parsed = body.parse(raw);
    const jobId = await enqueueJob("resolve", parsed);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: "invalid body", detail: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "could not enqueue",
        detail: message.includes("DATABASE_URL") ? message : "database unavailable",
      },
      { status: 500 },
    );
  }
}
