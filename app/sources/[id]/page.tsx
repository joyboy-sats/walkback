/**
 * Source detail — the evidence chain.
 *
 * This screen answers the one question a judge will ask: "why is this source at
 * 0.48 and not something else?" So the page is ordered by that question —
 * headline score, then the history that produced it, then every verdict that
 * supports the number, then the raw provider response behind each one.
 *
 * The score history is a real sparkline rather than block characters: the shape
 * of how trust moved is the product's claim to "learning over time", and it
 * deserves an axis.
 */
import { notFound } from "next/navigation";
import { ApiError, apiGet } from "@/lib/public-api";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, trustBand } from "@/lib/score";
import VerdictBadge from "@/components/verdict-badge";
import { TrustMeter, TrustReadout } from "@/components/trust-meter";

interface SourceDetail {
  source: {
    id: string;
    handle: string;
    score: number;
    hits: number;
    misses: number;
  };
  versions: Array<{ version: number; score: number }>;
  claims: Array<{
    claim: {
      id: string;
      quote: string;
      claimType: string;
      deadline: string;
      synthetic: boolean;
      sourceUrl: string | null;
      walrusBlobId: string | null;
    };
    resolution: {
      outcome: "true" | "false" | "void";
      reason: string;
      evidence: unknown;
      walrusBlobId: string | null;
    } | null;
  }>;
}

export const dynamic = "force-dynamic";

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    notFound();
  }
  let detail: SourceDetail;
  try {
    detail = await apiGet<SourceDetail>(`/sources/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    const message = err instanceof Error ? err.message : String(err);
    return (
      <div className="rounded-lg border border-false/30 bg-false/5 p-4">
        <p className="label mb-1 text-false">Could not load source</p>
        <p className="text-[13px] text-ink-2">{message}</p>
      </div>
    );
  }

  const { source, versions, claims } = detail;
  const adjudicated = source.hits + source.misses;
  const band = trustBand(source.score, adjudicated);
  const hitRate = adjudicated === 0 ? null : source.hits / adjudicated;

  const counts = claims.reduce(
    (acc, c) => {
      if (!c.resolution) acc.pending++;
      else acc[c.resolution.outcome]++;
      return acc;
    },
    { true: 0, false: 0, void: 0, pending: 0 },
  );

  return (
    <div>
      <a
        href="/"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-3 transition-colors hover:text-ink"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
          <path d="M9.5 6h-7M5.5 3l-3 3 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Feed
      </a>

      {/* ── Headline ───────────────────────────────────────────────────── */}
      <header className="mt-5">
        <p className="label mb-2">Source</p>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <h1 className="text-[30px] font-semibold leading-none tracking-[-0.025em]">
            {source.handle}
          </h1>
          <div className="flex items-end gap-8">
            <div>
              <p className="label mb-1.5">trust</p>
              <p className="tnum text-[30px] font-semibold leading-none tracking-[-0.02em]">
                {source.score.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="label mb-1.5">record</p>
              <p className="tnum text-[16px] leading-none text-ink-2">
                {source.hits}
                <span className="text-ink-3"> hit </span>
                {source.misses}
                <span className="text-ink-3"> miss</span>
              </p>
            </div>
            <div>
              <p className="label mb-1.5">hit rate</p>
              <p className="tnum text-[16px] leading-none text-ink-2">
                {hitRate === null ? "—" : `${(hitRate * 100).toFixed(0)}%`}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <TrustMeter score={source.score} band={band} />
          <div className="mt-2 flex justify-between text-[11px] text-ink-3">
            <span>mute {TRUST_MUTED.toFixed(2)}</span>
            <span>trust {TRUST_TRUSTED.toFixed(2)}</span>
          </div>
        </div>

        {adjudicated < MIN_SAMPLE && (
          <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-ink-2">
            Below the {MIN_SAMPLE}-claim minimum. A perfect record on one or two
            claims is not evidence yet — that is exactly what the lower bound
            encodes, and why no band is assigned.
          </p>
        )}
      </header>

      {/* ── Verdict tally ──────────────────────────────────────────────── */}
      <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        <Tally label="true" value={counts.true} tone="text-true" />
        <Tally label="false" value={counts.false} tone="text-false" />
        <Tally label="could not check" value={counts.void} tone="text-ink-2" />
        <Tally label="pending" value={counts.pending} tone="text-ink-2" />
      </dl>

      {/* ── Score history ──────────────────────────────────────────────── */}
      {versions.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="label">score history</h2>
            <span className="text-[11px] text-ink-3">
              {versions.length} version{versions.length === 1 ? "" : "s"}
            </span>
          </div>
          <Sparkline
            values={versions.map((v) => v.score)}
            labels={versions.map((v) => `v${v.version}`)}
          />
        </section>
      )}

      {/* ── Evidence chain ─────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="label mb-3">evidence chain</h2>

        {claims.length === 0 ? (
          <p className="text-[13px] text-ink-3">No claims recorded for this source.</p>
        ) : (
          <ol className="space-y-px overflow-hidden rounded-lg border border-line bg-line">
            {claims.map(({ claim, resolution }) => (
              <li key={claim.id} className="bg-surface-1 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-center gap-2">
                  {resolution ? (
                    <VerdictBadge outcome={resolution.outcome} />
                  ) : (
                    <span className="rounded border border-line-strong px-2 py-0.5 text-[11px] text-ink-3">
                      pending
                    </span>
                  )}
                  <span className="mono text-[11px] text-ink-3">{claim.claimType}</span>
                  {claim.synthetic && (
                    <span className="rounded border border-line-strong px-1.5 py-px text-[11px] text-ink-3">
                      synthetic
                    </span>
                  )}
                  <span className="mono tnum ml-auto text-[11px] text-ink-3">
                    {claim.deadline.slice(0, 10)}
                  </span>
                </div>

                <blockquote className="mt-2.5 text-[14px] leading-[1.6]">
                  <span className="text-ink-3">“</span>
                  {claim.quote}
                  <span className="text-ink-3">”</span>
                </blockquote>

                {resolution && (
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                    {resolution.reason}
                  </p>
                )}

                {resolution && (
                  <details className="group mt-2.5">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-ink-3 transition-colors hover:text-ink-2">
                      <svg
                        viewBox="0 0 12 12"
                        className="h-2.5 w-2.5 transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      >
                        <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      raw evidence
                    </summary>
                    <pre className="mono mt-2 max-h-64 overflow-auto rounded-md border border-line bg-surface-0 p-3 text-[11px] leading-relaxed text-ink-2">
{JSON.stringify(resolution.evidence, null, 2)}
                    </pre>
                  </details>
                )}

                <div className="mono mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
                  {claim.sourceUrl?.startsWith("https://") && (
                    <a
                      href={claim.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:text-ink-2 hover:underline"
                    >
                      original post
                    </a>
                  )}
                  {claim.walrusBlobId && <span>claim {claim.walrusBlobId.slice(0, 14)}…</span>}
                  {resolution?.walrusBlobId && (
                    <span>verdict {resolution.walrusBlobId.slice(0, 14)}…</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/* ── Sparkline ─────────────────────────────────────────────────────────────
 * A score history is one series over an ordered index, so the form is a line.
 * No legend (a single series is named by the section header), a muted grid,
 * and the threshold bands shaded so a drop across the mute line is visible as
 * a crossing rather than a number the reader has to compare.
 */
function Sparkline({ values, labels }: { values: number[]; labels: string[] }) {
  const W = 720;
  const H = 88;
  const padL = 30;
  const padR = 8;
  const padY = 8;
  const innerW = W - padL - padR;
  const innerH = H - padY * 2;

  const x = (i: number) =>
    padL + (values.length <= 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
  const y = (v: number) => padY + innerH - Math.max(0, Math.min(1, v)) * innerH;

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const path = `M ${pts.join(" L ")}`;
  const area = `M ${padL},${padY + innerH} L ${pts.join(" L ")} L ${x(values.length - 1).toFixed(1)},${padY + innerH} Z`;
  const last = values[values.length - 1] ?? 0;

  return (
    <div className="rounded-lg border border-line bg-surface-1 p-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[88px] w-full"
        role="img"
        aria-label={`Trust moved from ${values[0]?.toFixed(2)} to ${last.toFixed(2)} over ${values.length} versions`}
      >
        {/* Threshold bands */}
        <rect x={padL} y={y(TRUST_TRUSTED)} width={innerW} height={padY + innerH - y(TRUST_TRUSTED)} fill="var(--color-accent)" opacity="0.05" />
        <rect x={padL} y={padY} width={innerW} height={y(TRUST_MUTED) - padY} fill="var(--color-false)" opacity="0.045" />

        {/* Threshold rules. The numeric values are labelled once by the main
            meter above; repeating them here collided at 11px apart. */}
        {[TRUST_TRUSTED, TRUST_MUTED].map((t) => (
          <line
            key={t}
            x1={padL}
            x2={W - padR}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--color-line-strong)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ))}

        {/* Range labels, placed in the gutter and staggered so they cannot
            collide when the two thresholds are close together. */}
        <text x={padL - 6} y={y(TRUST_TRUSTED) - 3} textAnchor="end" fontSize="8.5" fill="var(--color-ink-3)" className="mono">
          trust
        </text>
        <text x={padL - 6} y={y(TRUST_MUTED) + 9} textAnchor="end" fontSize="8.5" fill="var(--color-ink-3)" className="mono">
          mute
        </text>

        {/* Area + line */}
        <path d={area} fill="var(--color-accent)" opacity="0.10" />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Points: only the last one is labelled, never every point. */}
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === values.length - 1 ? 3.5 : 2} fill="var(--color-accent)" />
        ))}
        <text
          x={x(values.length - 1)}
          y={y(last) - 8}
          textAnchor="end"
          fontSize="10"
          fill="var(--color-ink)"
          className="mono"
        >
          {last.toFixed(2)}
        </text>
      </svg>

      <div className="mono mt-1 flex justify-between text-[10px] text-ink-3">
        <span>{labels[0]}</span>
        {values.length > 2 && <span>{labels[Math.floor(values.length / 2)]}</span>}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`bg-surface-1 px-4 py-3 ${value === 0 ? "opacity-45" : ""}`}>
      <dt className="label">{label}</dt>
      <dd className={`tnum mt-1.5 text-[19px] font-medium ${tone}`}>{value}</dd>
    </div>
  );
}
