/**
 * Feed — claims ranked by their source's trust.
 *
 * The one screen that has to demonstrate the product thesis: a source that was
 * wrong is *visible as demoted*, and one that is below the mute threshold is
 * collapsed rather than shown normally.
 *
 * Layout: the trust meter is the visual spine. It repeats down the left edge of
 * every row so the reader can scan the column and see the ranking without
 * reading a single number.
 *
 * Server component. Rows come from the Coolify API over HTTP.
 */
import { apiGet } from "@/lib/public-api";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, trustBand } from "@/lib/score";
import VerdictBadge from "@/components/verdict-badge";
import { TrustMeter, TrustReadout } from "@/components/trust-meter";

interface FeedRow {
  claim: {
    id: string;
    quote: string;
    claimType: string;
    status: string;
    deadline: string;
    synthetic: boolean;
    sourceUrl: string | null;
    walrusBlobId: string | null;
  };
  source: {
    id: string;
    handle: string;
    score: number;
    hits: number;
    misses: number;
    muted: boolean;
  };
}

export const dynamic = "force-dynamic";

const STATUS_OUTCOME: Record<string, "true" | "false" | "void" | null> = {
  resolved: "true",
  void: "void",
  pending: null,
};

export default async function FeedPage() {
  let rows: FeedRow[] = [];
  let loadError: string | null = null;
  try {
    rows = await apiGet<FeedRow[]>("/feed");
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const visible = rows.filter((r) => !r.source.muted);
  const hidden = rows.length - visible.length;
  const pending = visible.filter((r) => r.claim.status === "pending").length;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="label mb-2">Ledger</p>
            <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.02em]">
              Claims, ranked by who has been right.
            </h1>
          </div>
        </div>

        <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
          A source falls below {TRUST_MUTED.toFixed(2)} and its claims stop appearing
          here. Trust is a Wilson lower bound over adjudicated claims — one correct
          guess is not evidence.
        </p>

        {/* KPI row: the three numbers that frame everything below. */}
        <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
          <Kpi label="claims shown" value={String(visible.length)} />
          <Kpi label="pending" value={String(pending)} hint="awaiting deadline" />
          <Kpi label="hidden" value={String(hidden)} hint="muted sources" dim={hidden === 0} />
          <Kpi label="thresholds" value={`${TRUST_MUTED.toFixed(2)} / ${TRUST_TRUSTED.toFixed(2)}`} hint="mute / trust" />
        </dl>
      </section>

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      {loadError ? (
        <div className="rounded-lg border border-false/30 bg-false/5 p-4">
          <p className="label mb-1 text-false">API unreachable</p>
          <p className="text-[13px] text-ink-2">{loadError}</p>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="space-y-px overflow-hidden rounded-lg border border-line bg-line">
          {visible.map(({ claim, source }, i) => {
            const adjudicated = source.hits + source.misses;
            const band = trustBand(source.score, adjudicated);
            const outcome = STATUS_OUTCOME[claim.status] ?? null;
            return (
              <li
                key={claim.id}
                className="rise group relative bg-surface-1 px-4 py-4 transition-colors hover:bg-surface-2 sm:px-5"
                style={{ animationDelay: `${Math.min(i, 8) * 28}ms` }}
              >
                <div className="flex items-start gap-4">
                  {/* Rank */}
                  <span className="tnum w-5 shrink-0 pt-0.5 text-right text-[12px] text-ink-3">
                    {i + 1}
                  </span>

                  {/* Body */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <a
                        href={`/sources/${source.id}`}
                        className="text-[14px] font-medium underline-offset-4 hover:underline"
                      >
                        {source.handle}
                      </a>
                      <TrustReadout
                        score={source.score}
                        band={band}
                        hits={source.hits}
                        misses={source.misses}
                      />
                      {adjudicated < MIN_SAMPLE && (
                        <span className="text-[11px] text-ink-3">
                          {adjudicated}/{MIN_SAMPLE} judged
                        </span>
                      )}

                      <span className="ml-auto flex items-center gap-2">
                        {outcome ? (
                          <VerdictBadge outcome={outcome} />
                        ) : (
                          <span className="rounded border border-line-strong px-2 py-0.5 text-[11px] text-ink-3">
                            pending
                          </span>
                        )}
                      </span>
                    </div>

                    <blockquote className="mt-2.5 text-[15px] leading-[1.6] text-ink">
                      <span className="text-ink-3">“</span>
                      {claim.quote}
                      <span className="text-ink-3">”</span>
                    </blockquote>

                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-3">
                      <span className="mono">{claim.claimType}</span>
                      <span aria-hidden="true" className="text-line-strong">/</span>
                      <span className="mono tnum">due {claim.deadline.slice(0, 10)}</span>
                      {claim.synthetic && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">/</span>
                          <span className="rounded border border-line-strong px-1.5 py-px">
                            synthetic
                          </span>
                        </>
                      )}
                      {claim.sourceUrl?.startsWith("https://") && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">/</span>
                          <a
                            href={claim.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-2 hover:text-ink-2 hover:underline"
                          >
                            original post
                          </a>
                        </>
                      )}
                      {claim.walrusBlobId && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">/</span>
                          <span className="mono">blob {claim.walrusBlobId.slice(0, 10)}…</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Trust spine */}
                  <div className="hidden w-28 shrink-0 pt-1 sm:block">
                    <TrustMeter score={source.score} band={band} size="sm" />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hidden > 0 && (
        <p className="mt-4 text-[12px] text-ink-3">
          {hidden} claim{hidden === 1 ? "" : "s"} from muted sources{" "}
          {hidden === 1 ? "is" : "are"} not shown.
        </p>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <section className="mt-10 border-t border-line pt-5">
        <p className="label mb-3">How to read a row</p>
        <div className="grid gap-4 text-[12px] text-ink-2 sm:grid-cols-3">
          <LegendItem
            swatch={<TrustMeter score={0.62} band="trusted" size="sm" />}
            title="Trust meter"
            body={`Fill is the score. The two ticks are the mute (${TRUST_MUTED.toFixed(2)}) and trust (${TRUST_TRUSTED.toFixed(2)}) thresholds.`}
          />
          <LegendItem
            swatch={<VerdictBadge outcome="void" />}
            title="Verdict"
            body="True and false are judgements. Void means we could not check — it never moves a score."
          />
          <LegendItem
            swatch={<span className="mono text-[11px] text-ink-2">0.48 · 8/10</span>}
            title="Score and record"
            body="Wilson lower bound, then hits over adjudicated claims. Sample size is always visible."
          />
        </div>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  dim = false,
}: {
  label: string;
  value: string;
  hint?: string;
  dim?: boolean;
}) {
  return (
    <div className={`bg-surface-1 px-4 py-3 ${dim ? "opacity-55" : ""}`}>
      <dt className="label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2">
        <span className="tnum text-[19px] font-medium tracking-[-0.01em]">{value}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </dd>
    </div>
  );
}

function LegendItem({
  swatch,
  title,
  body,
}: {
  swatch: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="mb-2 flex h-5 items-center">{swatch}</div>
      <p className="mb-1 font-medium text-ink">{title}</p>
      <p className="leading-relaxed">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-6 py-14 text-center">
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-line-strong">
        <svg viewBox="0 0 20 20" className="h-5 w-5 text-ink-3" aria-hidden="true">
          <path
            d="M5 3h7.5A2.5 2.5 0 0 1 15 5.5v11L12 14l-3 2.5-3-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M7.5 7.5h5M7.5 10.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-[15px] font-medium">No claims in the ledger yet.</p>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] leading-relaxed text-ink-2">
        Paste a post that makes a checkable claim about onchain state. Walkback
        freezes a balance snapshot, waits for the deadline, then checks it against
        Sui mainnet.
      </p>
      <a
        href="/ingest"
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/85"
      >
        Ingest a post
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
          <path d="M2.5 6h7M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </div>
  );
}
