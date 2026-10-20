/**
 * Enqueue a projection rebuild. The worker recalls Walrus and rewrites Postgres.
 */
import { NextResponse } from "next/server";
import { enqueueJob } from "@/lib/job-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const jobId = await enqueueJob("rebuild", {});
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
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
