/**
 * Source detail — the evidence chain.
 *
 * This screen exists to answer the question a judge will ask: "why is this
 * source's score 0.48 and not something else?" Every point of the score has to
 * be traceable to a verdict, and every verdict to a claim and its evidence.
 */
import { notFound } from "next/navigation";
import { readSource } from "@/lib/reads";
import { MIN_SAMPLE, TRUST_MUTED, trustBand } from "@/lib/score";

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
  let detail: SourceDetail | null;
  try {
    detail = await readSource(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return <p className="text-sm text-[var(--bad)]">{message}</p>;
  }
  if (!detail) notFound();

  const { source, versions, claims } = detail;

  const adjudicated = source.hits + source.misses;
  const band = trustBand(source.score, adjudicated);

  // Sparkline from score versions, drawn with block characters. No chart lib
  // for six data points.
  const spark = versions
    .map((v) => {
      const bars = "▁▂▃▄▅▆▇█";
      const i = Math.min(7, Math.max(0, Math.round(v.score * 7)));
      return bars[i];
    })
    .join("");

  return (
    <div>
      <a href="/" className="text-sm text-[var(--dim)] hover:text-[var(--fg)]">
        ← Feed
      </a>

      <div className="mt-4 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{source.handle}</h1>
        <span
          className={
            band === "muted"
              ? "text-[var(--bad)] text-sm"
              : band === "trusted"
                ? "text-[var(--good)] text-sm"
                : "text-[var(--dim)] text-sm"
          }
        >
          {source.score.toFixed(2)} · {band}
        </span>
      </div>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <Stat label="hits" value={String(source.hits)} />
        <Stat label="misses" value={String(source.misses)} />
        <Stat
          label="hit rate"
          value={
            adjudicated === 0 ? "—" : `${((source.hits / adjudicated) * 100).toFixed(0)}%`
          }
        />
        <Stat label="adjudicated" value={String(adjudicated)} />
      </dl>

      {adjudicated < MIN_SAMPLE && (
        <p className="mt-4 text-sm text-[var(--dim)]">
          Below the {MIN_SAMPLE}-claim minimum, so no trust badge is shown. A perfect
          record on one or two claims is not evidence yet — the lower bound says so.
        </p>
      )}

      {spark && (
        <div className="mt-8">
          <h2 className="text-sm text-[var(--dim)]">score history</h2>
          <div className="mt-2 flex items-center gap-4">
            <span className="mono text-2xl tracking-[0.2em]">{spark}</span>
            <span className="text-xs text-[var(--void)]">
              {versions.length} version{versions.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      <h2 className="mt-10 mb-3 text-sm text-[var(--dim)]">evidence chain</h2>
      <ul className="space-y-3">
        {claims.map(({ claim, resolution }) => (
          <li key={claim.id} className="border border-[var(--line)] rounded-lg p-4">
            <div className="flex items-baseline gap-3 text-xs">
              <span
                className={
                  !resolution
                    ? "text-[var(--void)]"
                    : resolution.outcome === "true"
                      ? "text-[var(--good)]"
                      : resolution.outcome === "false"
                        ? "text-[var(--bad)]"
                        : "text-[var(--void)]"
                }
              >
                {!resolution
                  ? "PENDING"
                  : resolution.outcome === "void"
                    ? "COULD NOT CHECK"
                    : resolution.outcome.toUpperCase()}
              </span>
              <span className="text-[var(--dim)]">{claim.claimType}</span>
              {claim.synthetic && <span className="text-[var(--void)]">synthetic</span>}
              <span className="ml-auto mono text-[var(--void)]">
                {claim.deadline.slice(0, 10)}
              </span>
            </div>

            <blockquote className="mt-2 text-sm leading-relaxed">“{claim.quote}”</blockquote>

            {resolution && (
              <p className="mt-2 text-sm text-[var(--dim)]">{resolution.reason}</p>
            )}

            {resolution && (
              <details className="mt-2">
                <summary className="text-xs text-[var(--void)] cursor-pointer">
                  raw evidence
                </summary>
                <pre className="mt-2 text-xs overflow-x-auto p-3 bg-[#141418] rounded mono">
                  {JSON.stringify(resolution.evidence, null, 2)}
                </pre>
              </details>
            )}

            <div className="mt-2 flex gap-3 text-xs mono text-[var(--void)]">
              {claim.walrusBlobId && <span>claim {claim.walrusBlobId.slice(0, 14)}…</span>}
              {resolution?.walrusBlobId && (
                <span>verdict {resolution.walrusBlobId.slice(0, 14)}…</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-xs text-[var(--void)]">
        Mute threshold {TRUST_MUTED.toFixed(2)}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--void)]">{label}</dt>
      <dd className="mt-1 text-lg mono">{value}</dd>
    </div>
  );
}
