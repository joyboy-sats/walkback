/**
 * Coolify worker. One job at a time, so Walrus writes stay inside the
 * delegate rate limit. Start command is this file; the API is a different
 * process using the same image.
 */
import { closeDb } from "../lib/db";
import { boot } from "./boot";
import { claimNextJob, executeJob, failStaleJobs } from "./jobs";

const rawPoll = Number(process.env.WORKER_POLL_MS ?? "2000");
const pollMs = Number.isFinite(rawPoll) && rawPoll >= 200 ? rawPoll : 2000;

let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});

await boot();
console.log("worker ready");

while (!stop) {
  await failStaleJobs();
  const job = await claimNextJob();
  if (!job) {
    await new Promise((r) => setTimeout(r, pollMs));
    continue;
  }
  console.log(`job ${job.id} ${job.kind} started`);
  await executeJob(job);
  console.log(`job ${job.id} ${job.kind} finished`);
}

await closeDb();
