"use client";

import { useEffect, useRef, useState } from "react";
import { pollJob } from "@/lib/public-api";

/**
 * Drop the projection and rebuild it from Walrus.
 *
 * The button reports row counts. If recall cannot show it saw every indexed
 * memory, the server leaves the tables alone and the warning says so.
 */

interface RebuildResponse {
  truncated?: boolean;
  warning?: string | null;
  limitation?: string;
  notes?: string[];
  duplicatesDropped?: number;
  skipped?: Array<{ blobId: string; reason: string }>;
  counts?: {
    sources: number;
    claims: number;
    resolutions: number;
    scoreVersions: number;
    memoryLog: number;
  };
  coverage?: {
    rawHits: number;
    unique: number;
    gaps: Array<{ namespace: string; recalled: number; reported: number }>;
  };
  error?: string;
  detail?: string;
}

export default function RebuildButton() {
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [result, setResult] = useState<RebuildResponse | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    cancel.current = false;
    return () => {
      cancel.current = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== "working") return;
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  async function rebuild() {
    setPhase("working");
    setElapsed(0);
    setJobStatus(null);
    setResult(null);
    try {
      const res = await fetch("/api/rebuild", { method: "POST" });
      const queued = (await res.json().catch(() => null)) as
        | { jobId?: string; error?: string; detail?: string }
        | null;
      if (!res.ok || !queued?.jobId) {
        setPhase("error");
        setResult({
          error: "rebuild failed",
          detail: queued?.detail || queued?.error || `request failed (${res.status})`,
        });
        return;
      }
      const job = await pollJob(queued.jobId, setJobStatus, () => cancel.current);
      if (cancel.current) return;
      if (job.status === "failed") {
        setPhase("error");
        setResult({ error: "rebuild failed", detail: job.error || "rebuild failed" });
        return;
      }
      setResult(job.result as RebuildResponse);
      setPhase("done");
    } catch (err) {
      if (cancel.current) return;
      setPhase("error");
      setResult({ error: "rebuild failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const counts = result?.counts;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={rebuild}
        disabled={phase === "working"}
        className="border border-[var(--line)] rounded px-4 py-2 text-sm hover:border-[var(--dim)] disabled:opacity-50"
      >
        {phase === "working" ? "Rebuilding…" : "Rebuild projection from Walrus"}
      </button>

      {phase === "working" && (
        <div className="mt-4" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-sm text-[var(--dim)]">
            {jobStatus === "pending" ? "Queued for the worker." : "Recalling memories and rebuilding the projection."}{" "}
            Elapsed {elapsed}s.
          </p>
        </div>
      )}

      {phase === "error" && result?.detail && (
        <p className="mt-4 text-sm text-[var(--bad)]">{result.detail}</p>
      )}

      {phase === "done" && result && (
        <div className="mt-4 text-sm">
          <p className={result.truncated ? "text-[var(--good)]" : "text-[var(--bad)]"}>
            {result.truncated
              ? "Projection replaced with what recall returned."
              : "Projection was not modified."}
          </p>
          {result.warning && <p className="mt-2 text-[var(--dim)]">{result.warning}</p>}
          {counts && (
            <dl className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Count label="sources" value={counts.sources} />
              <Count label="claims" value={counts.claims} />
              <Count label="resolutions" value={counts.resolutions} />
              <Count label="score versions" value={counts.scoreVersions} />
              <Count label="memory log" value={counts.memoryLog} />
            </dl>
          )}
          <p className="mt-3 text-xs text-[var(--void)]">
            {result.coverage ? `${result.coverage.unique} unique memories from ${result.coverage.rawHits} hits` : ""}
            {result.duplicatesDropped ? ` · ${result.duplicatesDropped} duplicates dropped` : ""}
            {result.skipped?.length ? ` · ${result.skipped.length} skipped` : ""}
          </p>
          {result.notes && result.notes.length > 0 && (
            <ul className="mt-2 text-xs text-[var(--dim)] space-y-1">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-[var(--void)]">{label}</dt>
      <dd className="mt-1 mono text-lg">{value}</dd>
    </div>
  );
}
