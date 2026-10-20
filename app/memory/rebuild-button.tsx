"use client";

import { useEffect, useRef, useState } from "react";
import { askAdminToken, clearAdminToken } from "@/lib/admin-token";
import { apiPost, pollJob } from "@/lib/public-api";

/**
 * Verify is the demo action: read Walrus, compare it with Postgres, and
 * leave the tables alone. Replace runs only after that report says coverage
 * is complete and the owner confirms.
 */

interface ScoreRow {
  sourceId: string;
  handle: string;
  storedScore: number;
  recomputedScore: number | null;
  agree: boolean;
}

interface VerifyResponse {
  mode?: "verify" | "rebuild";
  enumeration?: "list" | "recall-fallback";
  truncated?: boolean;
  warning?: string | null;
  limitation?: string;
  notes?: string[];
  matched?: number;
  mismatched?: number;
  missingFromRecall?: number;
  recalledNotInPostgres?: number;
  scores?: ScoreRow[];
  coverageComplete?: boolean;
  excludedNamespaces?: string[];
  mismatches?: Array<{ kind: string; id: string; detail: string }>;
  missing?: Array<{ kind: string; id: string }>;
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
  const [action, setAction] = useState<"verify" | "rebuild">("verify");
  const [elapsed, setElapsed] = useState(0);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
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

  async function run(mode: "verify" | "rebuild") {
    if (mode === "rebuild") {
      const ok = window.confirm(
        "Replace the Postgres projection with the listed memories? This drops the current tables. Do it only after the coverage report is complete.",
      );
      if (!ok) return;
    }
    setAction(mode);
    setPhase("working");
    setElapsed(0);
    setJobStatus(null);
    setResult(null);
    try {
      const token = askAdminToken();
      const res = await apiPost("/rebuild", mode === "rebuild" ? { mode: "rebuild", confirm: true } : { mode: "verify" }, token);
      if (res.status === 401) clearAdminToken();
      if (res.status === 401 || res.status >= 400 || !res.body?.jobId) {
        setPhase("error");
        setResult({
          error: "request failed",
          detail:
            res.status === 401
              ? "Admin token was rejected. Click again and enter the Coolify ADMIN_TOKEN."
              : res.body?.detail || res.body?.error || `request failed (${res.status})`,
        });
        return;
      }
      const job = await pollJob(res.body.jobId, setJobStatus, () => cancel.current);
      if (cancel.current) return;
      if (job.status === "failed") {
        setPhase("error");
        setResult({ error: "request failed", detail: job.error || "the worker failed" });
        return;
      }
      setResult(job.result as VerifyResponse);
      setPhase("done");
    } catch (err) {
      if (cancel.current) return;
      setPhase("error");
      setResult({ error: "request failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const canReplace = phase === "done" && result?.mode === "verify" && result.coverageComplete === true;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => run("verify")}
          disabled={phase === "working"}
          className="border border-[var(--line)] rounded px-4 py-2 text-sm hover:border-[var(--dim)] disabled:opacity-50"
        >
          {phase === "working" && action === "verify" ? "Verifying…" : "Verify against Walrus"}
        </button>
        <button
          type="button"
          onClick={() => run("rebuild")}
          disabled={phase === "working" || !canReplace}
          className="border border-[var(--line)] rounded px-4 py-2 text-sm text-[var(--dim)] hover:border-[var(--dim)] disabled:opacity-40"
        >
          {phase === "working" && action === "rebuild" ? "Replacing…" : "Replace projection"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--void)] max-w-2xl">
        Verify is the demo. It does not drop tables. Replace stays off until a verify report
        says every listed product-namespace memory was read. A recall fallback cannot turn it on.
      </p>

      {phase === "working" && (
        <div className="mt-4" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-sm text-[var(--dim)]">
            {jobStatus === "pending" ? "Queued for the worker." : "Reading Walrus and comparing it with Postgres."}{" "}
            Elapsed {elapsed}s.
          </p>
        </div>
      )}

      {phase === "error" && result?.detail && (
        <p className="mt-4 text-sm text-[var(--bad)]">{result.detail}</p>
      )}

      {phase === "done" && result && <Report result={result} />}
    </div>
  );
}

function Report({ result }: { result: VerifyResponse }) {
  const headline =
    result.mode === "rebuild" && result.truncated
      ? "Projection replaced from the listed memories."
      : result.mode === "rebuild"
        ? "Projection was not replaced."
        : "Verification finished. Postgres was not modified.";

  return (
    <div className="mt-4 text-sm">
      <p className={result.truncated ? "text-[var(--good)]" : "text-[var(--fg)]"}>{headline}</p>
      {result.warning && <p className="mt-2 text-[var(--dim)]">{result.warning}</p>}
      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Count label="matched" value={result.matched ?? 0} />
        <Count label="mismatched" value={result.mismatched ?? 0} />
        <Count label="missing from recall" value={result.missingFromRecall ?? 0} />
        <Count label="only in recall" value={result.recalledNotInPostgres ?? 0} />
      </dl>
      <p className="mt-3 text-xs text-[var(--void)] max-w-2xl">
        {result.enumeration === "recall-fallback"
          ? "Listing was unavailable. This is a recall sample, so a missing row can still be on Walrus. Replace stays off."
          : result.coverageComplete
            ? "Every listed product memory was read. A missing row is not in that inventory."
            : "Coverage is incomplete, so a missing row can still be on Walrus."}
        {result.coverage ? ` ${result.coverage.unique} memories with plaintext from ${result.coverage.rawHits} recall hits.` : ""}
        {result.coverageComplete ? " Product-namespace coverage is complete." : " Product-namespace coverage is not complete."}
        {result.excludedNamespaces && result.excludedNamespaces.length > 0
          ? ` Excluded namespaces: ${result.excludedNamespaces.join(", ")}.`
          : ""}
      </p>
      {result.coverage?.gaps && result.coverage.gaps.length > 0 && (
        <ul className="mt-2 text-xs text-[var(--dim)] space-y-1">
          {result.coverage.gaps.map((g) => (
            <li key={g.namespace}>
              {g.namespace}: plaintext for {g.recalled} of {g.reported} listed
            </li>
          ))}
        </ul>
      )}
      {result.scores && result.scores.length > 0 && (
        <table className="mt-4 w-full text-xs">
          <thead className="text-[var(--void)]">
            <tr>
              <th className="text-left font-normal py-1">source</th>
              <th className="text-right font-normal">stored</th>
              <th className="text-right font-normal">recomputed</th>
            </tr>
          </thead>
          <tbody>
            {result.scores.map((s) => (
              <tr key={s.sourceId} className="border-t border-[var(--line)]">
                <td className="py-1">{s.handle}</td>
                <td className="text-right mono">{s.storedScore.toFixed(2)}</td>
                <td className={`text-right mono ${s.agree ? "" : "text-[var(--bad)]"}`}>
                  {s.recomputedScore === null ? "not in recall" : s.recomputedScore.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.notes && result.notes.length > 0 && (
        <ul className="mt-2 text-xs text-[var(--dim)] space-y-1">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
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
