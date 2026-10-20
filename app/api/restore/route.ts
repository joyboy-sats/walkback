/**
 * POST /api/restore
 *
 * Rebuild the relayer's index from Walrus for one namespace, then report what
 * came back. This is the proof that memory is the system of record: the
 * projection can be dropped and the data still exists on mainnet.
 *
 * `restore` has no pagination cursor and costs seconds per blob, so this loops
 * while the relayer reports `truncated` and makes progress, with a hard cap so
 * a request cannot run forever.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { restoreNamespace } from "@/lib/memwal";
import { NS } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({
  namespace: z.enum([NS.source, NS.claim, NS.resolution, NS.score, NS.digest]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const namespace = parsed.namespace ?? NS.claim;
  const limit = parsed.limit ?? 200;

  try {
    const rounds: Awaited<ReturnType<typeof restoreNamespace>>[] = [];
    let restoredTotal = 0;

    // Single-shot per call; loop only while the relayer says it truncated and
    // is still finding things, otherwise this spins on a permanent failure.
    for (let i = 0; i < 5; i++) {
      const r = await restoreNamespace(namespace, limit);
      rounds.push(r);
      restoredTotal += r.restored;
      if (!r.truncated || r.restored === 0) break;
    }

    return NextResponse.json({
      namespace,
      restoredTotal,
      rounds,
      note:
        "restore rebuilds the relayer's vector index. The Postgres projection is " +
        "rebuilt separately by replaying the recalled text.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "restore failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
