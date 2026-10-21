"use client";

import { useEffect, useRef, useState } from "react";
import { askAdminToken, clearAdminToken } from "@/lib/admin-token";
import { apiPost, pollJob } from "@/lib/public-api";
import { ReceiptIllustration, SealIllustration } from "@/components/illustrations";
import { HaloBadge } from "@/components/ui/halo-badge";
import { ArrowRight } from "lucide-react";

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

export default function IngestPage() {
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
      setError("Sui address must be 0x followed by hex.");
      return;
    }
    if (!publishedAt) {
      setPhase("error");
      setError("Published time is required. It anchors any deadline in the post.");
      return;
    }

    setPhase("working");
    setElapsed(0);
    setJobStatus(null);

    try {
      const token = askAdminToken();
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
        throw new Error("Admin token was rejected. Submit again and enter the Coolify ADMIN_TOKEN.");
      }
      if (res.status >= 400 || !res.body?.jobId) {
        throw new Error(res.body?.detail || res.body?.error || `ingest failed (${res.status})`);
      }
      const job = await pollJob(res.body.jobId, setJobStatus, () => cancel.current);
      if (job.status === "failed") throw new Error(job.error || "ingest failed");
      const done = job.result as IngestResponse | null;
      if (!done || !Array.isArray(done.claims)) {
        throw new Error("ingest finished without a result");
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
              <HaloBadge variant="secondary">ingest</HaloBadge>
              <span className="label">extract · snapshot · write</span>
            </div>
            <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em]">
              Turn a post into a receipt.
            </h1>
            <p className="mt-3 max-w-[56ch] text-[14px] leading-relaxed text-ink-2">
              Walkback extracts claims that can be checked against Sui, freezes a
              balance snapshot at this moment, and writes each one to Walrus
              Memory. Most posts contain nothing checkable — that comes back as
              zero claims, not as an error.
            </p>
            <p className="mt-2 max-w-[56ch] text-[12px] leading-relaxed text-ink-3">
              The first write in a tab asks for the admin token (ADMIN_TOKEN on the
              Coolify backend). The browser keeps it in sessionStorage and sends it
              as <span className="mono">x-admin-token</span>. Vercel stores nothing.
            </p>
          </div>
          <div className="hidden justify-self-end sm:block">
            <ReceiptIllustration className="h-[130px] w-[165px]" />
          </div>
        </div>
      </section>

      {/* ── Form ───────────────────────────────────────────────────────── */}
      <form onSubmit={onSubmit} className="max-w-2xl space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="handle" hint="who is speaking">
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

          <Field label="platform">
            <div className="flex gap-1">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={working}
                  onClick={() => setPlatform(p)}
                  className={`flex-1 rounded-md border px-2 py-2 text-[12px] transition-colors ${
                    platform === p
                      ? "border-accent/60 bg-accent/10 text-ink"
                      : "border-line bg-surface-1 text-ink-3 hover:border-line-strong hover:text-ink-2"
                  } disabled:opacity-50`}
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>

          <Field label="published at" hint="anchors relative deadlines">
            <input
              required
              type="datetime-local"
              value={publishedAt}
              onChange={(e) => setPublishedAt(e.target.value)}
              disabled={working}
              className={inputClass}
            />
          </Field>

          <Field label="Sui address" hint="optional — needed to take a receipt">
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

        <Field label="post" hint="verbatim, including typos">
          <textarea
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={working}
            rows={8}
            className={inputClass}
            placeholder="Paste the post."
          />
          <span className="mt-1.5 block text-right text-[11px] text-ink-3 tnum">
            {text.length} / 20000
          </span>
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={working}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-50"
          >
            {working ? "Working…" : "Extract and store"}
            {!working && (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M2.5 6h7M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {working && (
            <span className="text-[12px] text-ink-3 tnum">{elapsed}s elapsed</span>
          )}
        </div>
      </form>

      {/* ── Progress ───────────────────────────────────────────────────── */}
      {working && (
        <div className="mt-6 max-w-2xl" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
            {jobStatus === "pending"
              ? "Queued for the worker."
              : `Working${jobStatus ? ` (${jobStatus})` : ""}. Extraction is quick; each memory write to Walrus takes about 6 seconds.`}
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-6 max-w-2xl rounded-lg border border-false/30 bg-false/5 p-4">
          <p className="label mb-1 text-false">Failed</p>
          <p className="text-[13px] text-ink-2">{error}</p>
        </div>
      )}

      {phase === "done" && result && <Result result={result} />}
    </div>
  );
}

function Result({ result }: { result: IngestResponse }) {
  const count = result.claims.length;
  const empty = count === 0;

  return (
    <div className="mt-10 max-w-2xl space-y-8">
      {/* Summary */}
      <section>
        <div className="flex items-baseline gap-3">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">
            {empty ? "0 claims extracted" : `${count} claim${count === 1 ? "" : "s"} extracted`}
          </h2>
          {!empty && (
            <span className="text-[12px] text-ink-3">
              {result.memoryBlobIds.length} memor
              {result.memoryBlobIds.length === 1 ? "y" : "ies"} written
            </span>
          )}
        </div>

        {empty && (
          <div className="mt-3 rounded-lg border border-line bg-surface-1 p-4">
            <div className="flex items-start gap-4">
              <SealIllustration className="hidden h-12 w-14 shrink-0 sm:block" muted />
              <p className="text-[13px] leading-relaxed text-ink-2">
                Nothing in this post was checkable. That is a normal result, not a
                failure — most text contains no falsifiable claim about onchain
                state. The source was still recorded.
              </p>
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
                      synthetic
                    </span>
                  )}
                  <span className="mono tnum text-ink-3">due {c.deadline.slice(0, 10)}</span>
                  <span className="mono tnum ml-auto text-ink-3">
                    conf {c.confidence.toFixed(2)}
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
          <h2 className="label mb-2.5">rejected</h2>
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
        <h2 className="label mb-2.5">receipt</h2>
        {result.snapshot ? (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
            <Stat label="balance" value={result.snapshot.balance} mono />
            <Stat label="asset" value={result.snapshot.asset} mono />
            <Stat label="as of" value={result.snapshot.asOf.slice(0, 19).replace("T", " ")} mono />
            <Stat
              label="checkpoint"
              value={result.snapshot.checkpoint ?? "—"}
              mono
            />
            <div className="col-span-2 bg-surface-1 px-4 py-3 sm:col-span-4">
              <dt className="label">address</dt>
              <dd className="mono mt-1 break-all text-[12px] text-ink-2">
                {result.snapshot.address}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <p className="text-[13px] leading-relaxed text-ink-2">
              No snapshot was taken. Without a Sui address there is no receipt,
              and a change-over-time claim cannot be checked later — it will
              resolve to void rather than be guessed.
            </p>
          </div>
        )}
      </section>

      {/* Blobs */}
      <section>
        <h2 className="label mb-2.5">written to Walrus</h2>
        {result.memoryBlobIds.length === 0 ? (
          <p className="text-[13px] text-ink-3">No memories were written.</p>
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
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="label">{label}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </span>
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
