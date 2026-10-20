/**
 * Job status for the ingest and rebuild pages. Read-only.
 */
import { NextResponse } from "next/server";
import { readJob } from "@/lib/job-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const job = await readJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "could not read job",
        detail: message.includes("DATABASE_URL") ? message : "database unavailable",
      },
      { status: 500 },
    );
  }
}
