"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { askAdminToken, clearAdminToken } from "@/lib/admin-token";
import { formatCount, formatFixed } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
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
  replaceAllowed?: boolean;
  tables?: Array<{ table: string; before: number; after: number }>;
  orphans?: Array<{ kind: string; id: string; detail: string }>;
  unappliedSeedPosts?: string[];
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

function useUiLocale(): Locale {
  const value = useLocale();
  return isLocale(value) ? value : "en";
}

export default function RebuildButton() {
  const t = useTranslations("rebuild");
  const tokenCopy = useTranslations("ingest");
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
      const ok = window.confirm(t("confirm"));
      if (!ok) return;
    }
    setAction(mode);
    setPhase("working");
    setElapsed(0);
    setJobStatus(null);
    setResult(null);
    try {
      const token = askAdminToken({
        prompt: tokenCopy("tokenPrompt"),
        required: tokenCopy("tokenRequired"),
      });
      const res = await apiPost("/rebuild", mode === "rebuild" ? { mode: "rebuild", confirm: true } : { mode: "verify" }, token);
      if (res.status === 401) clearAdminToken();
      if (res.status === 401 || res.status >= 400 || !res.body?.jobId) {
        setPhase("error");
        setResult({
          error: "request failed",
          detail:
            res.status === 401
              ? t("tokenRejected")
              : res.body?.detail || res.body?.error || t("requestFailed", { status: res.status }),
        });
        return;
      }
      const job = await pollJob(res.body.jobId, setJobStatus, () => cancel.current);
      if (cancel.current) return;
      if (job.status === "failed") {
        setPhase("error");
        setResult({ error: "request failed", detail: job.error || t("workerFailed") });
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

  const canReplace = phase === "done" && result?.mode === "verify" && result.replaceAllowed === true;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run("verify")}
          disabled={phase === "working"}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-50"
        >
          {phase === "working" && action === "verify" ? t("verifying") : t("verify")}
        </button>
        <button
          type="button"
          onClick={() => run("rebuild")}
          disabled={phase === "working" || !canReplace}
          className="inline-flex items-center gap-2 rounded-md border border-line-strong px-4 py-2 text-[13px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-40"
        >
          {phase === "working" && action === "rebuild" ? t("replacing") : t("replace")}
        </button>
        {!canReplace && phase === "done" && (
          <span className="text-[11px] text-ink-3">{t("locked")}</span>
        )}
      </div>
      <p className="mt-2.5 max-w-2xl text-[11px] leading-relaxed text-ink-3">{t("help")}</p>

      {phase === "working" && (
        <div className="mt-4" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-[12px] text-ink-2">
            {jobStatus === "pending" ? t("queued") : t("reading")} {t("elapsed", { seconds: elapsed })}
          </p>
        </div>
      )}

      {phase === "error" && result?.detail && (
        <div className="mt-4 rounded-lg border border-false/30 bg-false/5 p-3">
        <p className="text-[13px] text-ink-2">{result.detail}</p>
      </div>
      )}

      {phase === "done" && result && <Report result={result} />}
    </div>
  );
}

function Report({ result }: { result: VerifyResponse }) {
  const t = useTranslations("rebuild");
  const locale = useUiLocale();
  const headline =
    result.mode === "rebuild" && result.truncated
      ? t("replaced")
      : result.mode === "rebuild"
        ? t("notReplaced")
        : t("verified");

  return (
    <div className="mt-4 text-sm">
      <p className={result.truncated ? "text-[var(--color-true)]" : "text-[var(--color-ink)]"}>{headline}</p>
      {result.warning && <p className="mt-2 text-[var(--color-ink-2)]">{result.warning}</p>}
      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Count label={t("matched")} value={result.matched ?? 0} locale={locale} />
        <Count label={t("mismatched")} value={result.mismatched ?? 0} locale={locale} />
        <Count label={t("missingRecall")} value={result.missingFromRecall ?? 0} locale={locale} />
        <Count label={t("onlyRecall")} value={result.recalledNotInPostgres ?? 0} locale={locale} />
      </dl>
      <p className="mt-3 text-xs text-[var(--color-ink-3)] max-w-2xl">
        {result.enumeration === "recall-fallback"
          ? t("recallFallback")
          : result.coverageComplete
            ? t("coverageRead")
            : t("coverageIncomplete")}{" "}
        {result.coverage
          ? t("plaintext", { unique: result.coverage.unique, hits: result.coverage.rawHits })
          : ""}{" "}
        {result.coverageComplete ? t("nsComplete") : t("nsIncomplete")}
        {result.excludedNamespaces && result.excludedNamespaces.length > 0
          ? ` ${t("excluded", { names: result.excludedNamespaces.join(", ") })}`
          : ""}
      </p>
      {result.tables && result.tables.length > 0 && (
        <table className="mt-4 w-full text-xs">
          <thead className="text-[var(--color-ink-3)]">
            <tr>
              <th className="text-left font-normal py-1">{t("table")}</th>
              <th className="text-right font-normal">{t("postgres")}</th>
              <th className="text-right font-normal">{t("rebuilt")}</th>
            </tr>
          </thead>
          <tbody>
            {result.tables.map((row) => (
              <tr key={row.table} className="border-t border-[var(--color-line)]">
                <td className="py-1">{row.table}</td>
                <td className="text-right mono">{formatCount(row.before, locale)}</td>
                <td className={`text-right mono ${row.after < row.before ? "text-[var(--color-false)]" : ""}`}>{formatCount(row.after, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.orphans && result.orphans.length > 0 && (
        <ul className="mt-2 text-xs text-[var(--color-false)] space-y-1">
          {result.orphans.map((orphan) => (
            <li key={`${orphan.kind}:${orphan.id}`}>
              {t("orphan", { kind: orphan.kind, id: orphan.id, detail: orphan.detail })}
            </li>
          ))}
        </ul>
      )}
      {result.unappliedSeedPosts && result.unappliedSeedPosts.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-false)]">
          {t("seedPosts", { count: result.unappliedSeedPosts.length })}
        </p>
      )}
      {result.coverage?.gaps && result.coverage.gaps.length > 0 && (
        <ul className="mt-2 text-xs text-[var(--color-ink-2)] space-y-1">
          {result.coverage.gaps.map((g) => (
            <li key={g.namespace}>
              {t("gap", { namespace: g.namespace, recalled: g.recalled, reported: g.reported })}
            </li>
          ))}
        </ul>
      )}
      {result.scores && result.scores.length > 0 && (
        <table className="mt-4 w-full text-xs">
          <thead className="text-[var(--color-ink-3)]">
            <tr>
              <th className="text-left font-normal py-1">{t("source")}</th>
              <th className="text-right font-normal">{t("stored")}</th>
              <th className="text-right font-normal">{t("recomputed")}</th>
            </tr>
          </thead>
          <tbody>
            {result.scores.map((s) => (
              <tr key={s.sourceId} className="border-t border-[var(--color-line)]">
                <td className="py-1">{s.handle}</td>
                <td className="text-right mono">{formatFixed(s.storedScore, locale)}</td>
                <td className={`text-right mono ${s.agree ? "" : "text-[var(--color-false)]"}`}>
                  {s.recomputedScore === null ? t("notInRecall") : formatFixed(s.recomputedScore, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.notes && result.notes.length > 0 && (
        <ul className="mt-2 text-xs text-[var(--color-ink-2)] space-y-1">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Count({ label, value, locale }: { label: string; value: number; locale: Locale }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-ink-3)]">{label}</dt>
      <dd className="mt-1 mono text-lg">{formatCount(value, locale)}</dd>
    </div>
  );
}
