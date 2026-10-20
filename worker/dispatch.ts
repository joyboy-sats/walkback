/**
 * Run one claimed job with the existing library code.
 *
 * Walrus writes go through `lib/memwal.ts`, which acquires `memwalWriteLimiter`
 * before every write. This file is imported by the worker only.
 */
import { ingest } from "../lib/ingest";
import type { IngestBody } from "../lib/ingest-body";
import type { ClaimedJob } from "../lib/job-queue";
import { restoreNamespace } from "../lib/memwal";
import { rebuildProjection } from "../lib/projection-rebuild";
import { resolveClaim, resolveDueClaims } from "../lib/resolve";
import { NS, type Namespace } from "../lib/types";

export async function dispatchJob(job: ClaimedJob): Promise<unknown> {
  switch (job.kind) {
    case "ingest": {
      const body = job.payload as unknown as IngestBody;
      return ingest({
        handle: body.handle,
        platform: body.platform,
        text: body.text,
        publishedAt: body.publishedAt ?? new Date().toISOString(),
        ...(body.suiAddress ? { suiAddress: body.suiAddress } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
    }
    case "rebuild":
      return rebuildProjection();
    case "resolve": {
      const payload = job.payload as { claimId?: string; due?: boolean; limit?: number };
      if (payload.claimId) return resolveClaim(payload.claimId);
      return resolveDueClaims(new Date(), payload.limit ?? 10);
    }
    case "restore": {
      const payload = job.payload as { namespace?: Namespace; limit?: number };
      const namespace = payload.namespace ?? NS.claim;
      const limit = payload.limit ?? 200;
      const rounds: Awaited<ReturnType<typeof restoreNamespace>>[] = [];
      let restoredTotal = 0;
      for (let i = 0; i < 5; i++) {
        const round = await restoreNamespace(namespace, limit);
        rounds.push(round);
        restoredTotal += round.restored;
        if (!round.truncated || round.restored === 0) break;
      }
      return { namespace, restoredTotal, rounds };
    }
    default:
      throw new Error(`unknown job kind: ${String(job.kind)}`);
  }
}
