"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { askAdminToken, clearAdminToken } from "@/lib/admin-token";
import { formatCount, formatDateOnly, formatFixed, formatTimestamp } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
import { apiPost, pollJob } from "@/lib/public-api";
import { ReceiptIllustration, SealIllustration } from "@/components/illustrations";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { HaloBadge } from "@/components/ui/halo-badge";

/**
 * Paste a post and see exactly what ingest kept.
 *
 * The write is a job on Coolify. This page enqueues it and polls until the
 * worker finishes. Extraction is quick; each memory write to Walrus is about
 * six seconds, and the page shows elapsed time so the wait does not look like
 * a freeze. Zero extracted claims is a normal result and is rendered as one —
 * most text has nothing checkable in it.
 */

type Platform = "x" | "substack" | "rss" | "onchain" | "other";

interface StoredClaim {
  id: string;
  quote: string;
  claimType: string;
  deadline: string;
  confidence: number;
  synthetic: boolean;
}

interface IngestResponse {
  sourceId: string;
  claimIds: string[];
  claims: StoredClaim[];
  rejected: Array<{ quote: string; reason: string }>;
  snapshot: {
    address: string;
    asset: string;
    balance: string;
    checkpoint?: string;
    asOf: string;
  } | null;
  memoryBlobIds: string[];
}

const PLATFORMS: Platform[] = ["x", "substack", "rss", "onchain", "other"];

function useUiLocale(): Locale {
  const value = useLocale();
  return isLocale(value) ? value : "en";
}

function platformLabel(platform: Platform, t: ReturnType<typeof useTranslations<"ingest">>): string {
  if (platform === "other") return t("platformOther");
  if (platform === "onchain") return t("platformOnchain");
  return platform;
}

export default function IngestPage() {
  const t = useTranslations("ingest");
  const locale = useUiLocale();
  const [handle, setHandle] = useState("");
  const [platform, setPlatform] = useState<Platform>("x");
  const [publishedAt, setPublishedAt] = useState("");
  const [suiAddress, setSuiAddress] = useState("");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResponse | null>(null);
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const address = suiAddress.trim();
    if (address && !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
      setPhase("error");
      setError(t("addressError"));
      return;
    }
    if (!publishedAt) {
      setPhase("error");
      setError(t("publishedRequired"));
      return;
    }

    setPhase("working");
    setElapsed(0);
    setJobStatus(null);

    try {
      const token = askAdminToken({ prompt: t("tokenPrompt"), required: t("tokenRequired") });
      const res = await apiPost(
        "/ingest",
        {
          handle: handle.trim(),
          platform,
          text,
          publishedAt: new Date(publishedAt).toISOString(),
          ...(address ? { suiAddress: address } : {}),
        },
        token,
      );
      if (res.status === 401) {
        clearAdminToken();
        throw new Error(t("tokenRejected"));
      }
      if (res.status >= 400 || !res.body?.jobId) {
        throw new Error(res.body?.detail || res.body?.error || t("requestFailed", { status: res.status }));
      }
      const job = await pollJob(res.body.jobId, setJobStatus, () => cancel.current);
      if (job.status === "failed") throw new Error(job.error || t("failedJob"));
      const done = job.result as IngestResponse | null;
      if (!done || !Array.isArray(done.claims)) {
        throw new Error(t("noResult"));
      }
      setResult(done);
      setPhase("done");
    } catch (err) {
      if (cancel.current) return;
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const working = phase === "working";

  return (
    <div>
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-line bg-surface-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative grid items-center gap-6 px-6 py-7 sm:grid-cols-[1fr_200px] sm:px-8">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <HaloBadge variant="secondary">{t("badge")}</HaloBadge>
              <span className="label">{t("kicker")}</span>
            </div>
            <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em]">
              {t("title")}
            </h1>
            <p className="mt-3 max-w-[56ch] text-[14px] leading-relaxed text-ink-2">{t("body")}</p>
            <p className="mt-2 max-w-[56ch] text-[12px] leading-relaxed text-ink-3">
              {t("tokenBefore")} <span className="mono">x-admin-token</span>{t("tokenAfter")}
            </p>
          </div>
          <div className="hidden justify-self-end sm:block">
            <ReceiptIllustration className="h-[130px] w-[165px]" />
          </div>
        </div>
      </section>

      {/* ── Form ───────────────────────────────────────────────────────── */}
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("handle")} hint={t("handleHint")}>
            <input
              required
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={working}
              className={inputClass}
              placeholder="alice"
              spellCheck={false}
            />
          </Field>

          <Field label={t("platform")}>
            <div className="flex flex-wrap gap-1">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={working}
                  onClick={() => setPlatform(p)}
                  className={`min-w-[4.25rem] flex-1 rounded-md border px-2 py-2 text-[12px] transition-colors ${
                    platform === p
                      ? "border-accent/60 bg-accent/10 text-ink"
                      : "border-line bg-surface-1 text-ink-3 hover:border-line-strong hover:text-ink-2"
                  } disabled:opacity-50`}
                >
                  {platformLabel(p, t)}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t("published")} hint={t("publishedHint")} htmlFor="published-at">
            <DateTimePicker
              id="published-at"
              value={publishedAt}
              onChange={setPublishedAt}
              disabled={working}
              className={inputClass}
            />
          </Field>

          <Field label={t("address")} hint={t("addressHint")}>
            <input
              value={suiAddress}
              onChange={(e) => setSuiAddress(e.target.value)}
              disabled={working}
              className={`${inputClass} mono`}
              placeholder="0x…"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label={t("post")} hint={t("postHint")}>
          <textarea
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={working}
            rows={8}
            className={inputClass}
            placeholder={t("placeholder")}
          />
          <span className="mt-1.5 block text-right text-[11px] text-ink-3 tnum">
            {formatCount(text.length, locale)} / {formatCount(20000, locale)}
          </span>
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={working}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-50"
          >
            {working ? t("working") : t("submit")}
            {!working && (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M2.5 6h7M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {working && (
            <span className="text-[12px] text-ink-3 tnum">{t("elapsed", { seconds: elapsed })}</span>
          )}
        </div>
      </form>

      {/* ── Progress ───────────────────────────────────────────────────── */}
      {working && (
        <div className="mt-6" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
            {jobStatus === "pending"
              ? t("queued")
              : t("workingDetail", {
                  status:
                    jobStatus === "running"
                      ? t("statusRunning")
                      : jobStatus === "pending"
                        ? t("statusPending")
                        : (jobStatus ?? "none"),
                })}
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-6 rounded-lg border border-false/30 bg-false/5 p-4">
          <p className="label mb-1 text-false">{t("failed")}</p>
          <p className="text-[13px] text-ink-2">{error}</p>
        </div>
      )}

      {phase === "done" && result && <Result result={result} locale={locale} />}
    </div>
  );
}

function Result({ result, locale }: { result: IngestResponse; locale: Locale }) {
  const t = useTranslations("ingest");
  const count = result.claims.length;
  const empty = count === 0;

  return (
    <div className="mt-10 space-y-8">
      {/* Summary */}
      <section>
        <div className="flex items-baseline gap-3">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">
            {empty ? t("extractedZero") : t("extracted", { count })}
          </h2>
          {!empty && (
            <span className="text-[12px] text-ink-3">
              {t("memoriesWritten", { count: result.memoryBlobIds.length })}
            </span>
          )}
        </div>

        {empty && (
          <div className="mt-3 rounded-lg border border-line bg-surface-1 p-4">
            <div className="flex items-start gap-4">
              <SealIllustration className="hidden h-12 w-14 shrink-0 sm:block" muted />
              <p className="text-[13px] leading-relaxed text-ink-2">{t("emptyResult")}</p>
            </div>
          </div>
        )}

        {count > 0 && (
          <ol className="mt-3 space-y-px overflow-hidden rounded-xl border border-line bg-line">
            {result.claims.map((c) => (
              <li key={c.id} className="bg-surface-1 px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="mono rounded border border-line-strong px-1.5 py-0.5 text-ink-2">
                    {c.claimType}
                  </span>
                  {c.synthetic && (
                    <span className="rounded border border-line-strong px-1.5 py-0.5 text-ink-3">
                      {t("synthetic")}
                    </span>
                  )}
                  <span className="mono tnum text-ink-3">
                    {t("due", { date: formatDateOnly(c.deadline, locale) })}
                  </span>
                  <span className="mono tnum ml-auto text-ink-3">
                    {t("confidence", { value: formatFixed(c.confidence, locale) })}
                  </span>
                </div>
                <blockquote className="mt-2 text-[14px] leading-[1.6]">
                  <span className="text-ink-3">“</span>
                  {c.quote}
                  <span className="text-ink-3">”</span>
                </blockquote>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Rejected */}
      {result.rejected.length > 0 && (
        <section>
          <h2 className="label mb-2.5">{t("rejected")}</h2>
          <ul className="space-y-px overflow-hidden rounded-xl border border-line bg-line">
            {result.rejected.map((r, i) => (
              <li key={i} className="bg-surface-1 px-4 py-3">
                <p className="text-[13px] leading-relaxed">
                  <span className="text-ink-3">“</span>
                  {r.quote}
                  <span className="text-ink-3">”</span>
                </p>
                <p className="mt-1 text-[12px] text-ink-3">{r.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Snapshot */}
      <section>
        <h2 className="label mb-2.5">{t("receipt")}</h2>
        {result.snapshot ? (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
            <Stat label={t("balance")} value={result.snapshot.balance} mono />
            <Stat label={t("asset")} value={result.snapshot.asset} mono />
            <Stat label={t("asOf")} value={formatTimestamp(result.snapshot.asOf, locale)} mono />
            <Stat
              label={t("checkpoint")}
              value={result.snapshot.checkpoint ?? "—"}
              mono
            />
            <div className="col-span-2 bg-surface-1 px-4 py-3 sm:col-span-4">
              <dt className="label">{t("addressLabel")}</dt>
              <dd className="mono mt-1 break-all text-[12px] text-ink-2">
                {result.snapshot.address}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <p className="text-[13px] leading-relaxed text-ink-2">{t("noSnapshot")}</p>
          </div>
        )}
      </section>

      {/* Blobs */}
      <section>
        <h2 className="label mb-2.5">{t("written")}</h2>
        {result.memoryBlobIds.length === 0 ? (
          <p className="text-[13px] text-ink-3">{t("noneWritten")}</p>
        ) : (
          <ul className="space-y-px overflow-hidden rounded-xl border border-line bg-line">
            {result.memoryBlobIds.map((id) => (
              <li key={id} className="mono break-all bg-surface-1 px-4 py-2.5 text-[12px] text-ink-2">
                {id}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /** Caption points at a control that cannot sit inside the label (the date button). */
  htmlFor?: string;
}) {
  const caption = (
    <span className="mb-1.5 flex items-baseline gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="label">
          {label}
        </label>
      ) : (
        <span className="label">{label}</span>
      )}
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </span>
  );

  if (htmlFor) {
    return (
      <div>
        {caption}
        {children}
      </div>
    );
  }

  return (
    <label className="block">
      {caption}
      {children}
    </label>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-surface-1 px-4 py-3">
      <dt className="label">{label}</dt>
      <dd className={`mt-1 break-all text-[12px] text-ink ${mono ? "mono" : ""}`}>{value}</dd>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-line-strong focus:border-accent/60 disabled:opacity-50";
