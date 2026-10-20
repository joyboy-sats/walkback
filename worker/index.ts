/**
 * Coolify worker. Walrus writes run here, one job at a time.
 *
 *   npm run worker
 *   node --conditions=react-server --import tsx worker/index.ts
 *
 * SIGTERM finishes the job already in hand, then exits. It does not start
 * another. A job left `running` is retried by the stale sweep up to
 * MAX_ATTEMPTS; after that it is `failed`.
 */
import { closeDb } from "../lib/db";
import { requireDelegateKey } from "../lib/env";
import {
  claimNextJob,
  enqueueJob,
  hasOpenJob,
  markJobDone,
  MAX_ATTEMPTS,
  recordJobFailure,
  requeueStaleJobs,
} from "../lib/job-queue";
import { boot } from "../backend/boot";
import { dispatchJob } from "./dispatch";

const rawPoll = Number(process.env.WORKER_POLL_MS ?? "2000");
const pollMs = Number.isFinite(rawPoll) && rawPoll >= 200 ? rawPoll : 2000;
const rawResolve = Number(process.env.WORKER_RESOLVE_MS ?? "60000");
const resolveEveryMs = Number.isFinite(rawResolve) && rawResolve > 0 ? rawResolve : 0;

let stop = false;
let wake: (() => void) | null = null;

function requestStop(signal: string) {
  console.log(`[worker] ${signal} received, finishing the current job then exiting`);
  stop = true;
  wake?.();
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

function sleep(ms: number): Promise<void> {
  if (stop) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

async function maybeEnqueueResolve(): Promise<void> {
  if (resolveEveryMs === 0) return;
  if (await hasOpenJob("resolve")) {
    console.log("[worker] resolve pass already queued");
    return;
  }
  const id = await enqueueJob("resolve", { due: true, limit: 10 });
  console.log(`[worker] queued periodic resolve ${id}`);
}

await boot();
requireDelegateKey();
console.log(`[worker] ready poll=${pollMs}ms resolveEvery=${resolveEveryMs || "off"}`);

let lastResolve = 0;

while (!stop) {
  const stale = await requeueStaleJobs();
  if (stale > 0) console.log(`[worker] requeued ${stale} stale job${stale === 1 ? "" : "s"}`);

  const now = Date.now();
  if (resolveEveryMs > 0 && now - lastResolve >= resolveEveryMs) {
    lastResolve = now;
    await maybeEnqueueResolve();
  }

  const job = await claimNextJob();
  if (!job) {
    await sleep(pollMs);
    continue;
  }

  const started = Date.now();
  console.log(`[worker] claimed ${job.id} ${job.kind} attempt ${job.attempts}/${MAX_ATTEMPTS}`);
  try {
    const result = await dispatchJob(job);
    await markJobDone(job.id, result);
    console.log(`[worker] done ${job.id} ${job.kind} in ${Date.now() - started}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const plan = await recordJobFailure(job.id, job.attempts, message);
    if (plan.status === "failed") {
      console.error(`[worker] failed ${job.id} ${job.kind} after ${job.attempts} attempts: ${message}`);
    } else {
      console.warn(
        `[worker] retry ${job.id} ${job.kind} in ${plan.delayMs}ms (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${message}`,
      );
    }
  }
}

console.log("[worker] stopped");
await closeDb();
