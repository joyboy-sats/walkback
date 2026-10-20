/**
 * Enqueue an ingest. Returns the job id immediately.
 *
 * The worker performs extraction, the Tatum snapshot, and the Walrus writes.
 * This route does not import the Walrus client.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ingestBody } from "@/lib/ingest-body";
import { enqueueJob } from "@/lib/job-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const parsed = ingestBody.parse(await req.json());
    const jobId = await enqueueJob("ingest", {
      ...parsed,
      publishedAt: parsed.publishedAt ?? new Date().toISOString(),
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
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
