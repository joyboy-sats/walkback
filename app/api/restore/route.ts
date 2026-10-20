/**
 * Enqueue a relayer index restore. The worker calls Walrus; this route returns an id.
 */
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { enqueueJob } from "@/lib/job-queue";
import { NS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  namespace: z.enum([NS.source, NS.claim, NS.resolution, NS.score, NS.digest, NS.tombstone]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function POST(req: Request) {
  try {
    const raw = await req.json().catch(() => ({}));
    const parsed = body.parse(raw);
    const jobId = await enqueueJob("restore", parsed);
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
