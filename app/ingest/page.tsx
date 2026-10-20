"use client";

import { useEffect, useRef, useState } from "react";
import { askAdminToken, clearAdminToken } from "@/lib/admin-token";
import { apiPost, pollJob } from "@/lib/public-api";

/**
 * Paste a post and see exactly what ingest kept.
 *
 * The write is a job on Coolify. This page enqueues it and polls until the
 * worker finishes. Extraction is quick; each memory write to Walrus is about
 * six seconds, and the page shows elapsed time so the wait does not look like
 * a freeze. Zero extracted claims is a normal result and is rendered as one.
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
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Ingest</h1>
        <p className="mt-2 text-sm text-[var(--dim)] max-w-2xl">
          Paste a post. Walkback extracts claims it can check against Sui, freezes
          a balance snapshot, and writes each one to Walrus Memory. Most posts
          contain nothing checkable. That comes back as zero claims, not as an error.
        </p>
        <p className="mt-2 text-xs text-[var(--void)] max-w-2xl">
          The first write in a tab asks for the admin token. That is ADMIN_TOKEN
          on the Coolify backend. The browser keeps it in sessionStorage and sends
          it as x-admin-token. Vercel does not store it.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 max-w-2xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="handle">
            <input
              required
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={working}
              className={inputClass}
              placeholder="alice"
            />
          </Field>
          <Field label="platform">
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
              disabled={working}
              className={inputClass}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="published at">
            <input
              required
              type="datetime-local"
              value={publishedAt}
              onChange={(e) => setPublishedAt(e.target.value)}
              disabled={working}
              className={inputClass}
            />
          </Field>
          <Field label="Sui address, optional">
            <input
              value={suiAddress}
              onChange={(e) => setSuiAddress(e.target.value)}
              disabled={working}
              className={inputClass}
              placeholder="0x…"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label="post">
          <textarea
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={working}
            rows={8}
            className={inputClass}
            placeholder="Paste the post, verbatim."
          />
        </Field>

        <button
          type="submit"
          disabled={working}
          className="border border-[var(--line)] rounded px-4 py-2 text-sm hover:border-[var(--dim)] disabled:opacity-50"
        >
          {working ? "Working…" : "Extract and store"}
        </button>
      </form>

      {working && (
        <div className="mt-6 max-w-2xl" aria-busy="true">
          <div className="pending-bar">
            <span />
          </div>
          <p className="mt-3 text-sm text-[var(--dim)]">
            {jobStatus === "pending"
              ? `Queued for the worker. Elapsed ${elapsed}s.`
              : `Working${jobStatus ? ` (${jobStatus})` : ""}. Extraction is quick; each memory write to Walrus takes about 6 seconds. Elapsed ${elapsed}s.`}
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <p className="mt-6 text-sm text-[var(--bad)] max-w-2xl">{error}</p>
      )}

      {phase === "done" && result && <Result result={result} />}
    </div>
  );
}

function Result({ result }: { result: IngestResponse }) {
  const count = result.claims.length;
  const empty = count === 0;

  return (
    <div className="mt-8 max-w-2xl space-y-6">
      <section>
        <h2 className="text-lg font-medium">
          {empty ? "0 claims extracted" : `${count} claim${count === 1 ? "" : "s"} extracted`}
        </h2>
        {empty && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Nothing in this post was checkable. That is a normal result, not a
            failure. The source was still recorded.
          </p>
        )}
        {count > 0 && (
          <ul className="mt-3 space-y-3">
            {result.claims.map((c) => (
              <li key={c.id} className="border border-[var(--line)] rounded-lg p-4">
                <div className="flex flex-wrap items-baseline gap-3 text-xs text-[var(--dim)]">
                  <span className="pill">{c.claimType}</span>
                  {c.synthetic && (
                    <span className="border border-[var(--line)] rounded px-1.5 py-0.5 text-[var(--void)]">
                      synthetic
                    </span>
                  )}
                  <span>due {c.deadline.slice(0, 10)}</span>
                  <span className="mono">confidence {c.confidence.toFixed(2)}</span>
                </div>
                <blockquote className="mt-2 text-sm leading-relaxed">“{c.quote}”</blockquote>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm text-[var(--dim)]">rejected</h2>
        {result.rejected.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--void)]">None.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {result.rejected.map((r, i) => (
              <li key={i} className="text-sm border border-[var(--line)] rounded p-3">
                <p>“{r.quote}”</p>
                <p className="mt-1 text-[var(--dim)]">{r.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm text-[var(--dim)]">snapshot</h2>
        {result.snapshot ? (
          <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
            <Stat label="balance" value={result.snapshot.balance} />
            <Stat label="asset" value={result.snapshot.asset} />
            <Stat label="address" value={result.snapshot.address} />
            <Stat label="as of" value={result.snapshot.asOf} />
            {result.snapshot.checkpoint && (
              <Stat label="checkpoint" value={result.snapshot.checkpoint} />
            )}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-[var(--dim)]">
            No snapshot was taken. Without a Sui address there is no receipt, and a
            change-over-time claim cannot be checked later.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm text-[var(--dim)]">blob ids</h2>
        {result.memoryBlobIds.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--void)]">No memories were written.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {result.memoryBlobIds.map((id) => (
              <li key={id} className="mono text-xs text-[var(--dim)] break-all">
                {id}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-[var(--void)]">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--void)]">{label}</dt>
      <dd className="mt-1 mono text-sm break-all">{value}</dd>
    </div>
  );
}

const inputClass =
  "w-full bg-transparent border border-[var(--line)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--dim)] disabled:opacity-50";
