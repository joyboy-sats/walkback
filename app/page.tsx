/**
 * Feed — claims ranked by their source's trust.
 *
 * The one screen that has to demonstrate the product thesis: a source that was
 * wrong is *visible as demoted*, and one that is below the mute threshold is
 * collapsed rather than shown normally.
 *
 * Layout: the trust meter is the visual spine. It repeats down the right edge of
 * every row so the reader can scan the column and see the ranking without
 * reading a single number.
 *
 * Server component. Rows come from the Coolify API over HTTP.
 */
import { apiGet } from "@/lib/public-api";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, trustBand } from "@/lib/score";
import VerdictBadge from "@/components/verdict-badge";
import { TrustMeter, TrustReadout } from "@/components/trust-meter";
import {
  ReceiptIllustration,
  LedgerIllustration,
  SealIllustration,
} from "@/components/illustrations";
import { HaloBadge } from "@/components/ui/halo-badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, ExternalLink } from "lucide-react";

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
  const resolved = visible.length - pending;

  return (
    <div>
      {/* ── Masthead ───────────────────────────────────────────────────── */}
      <section className="relative mb-10 overflow-hidden rounded-2xl border border-line bg-surface-1">
        {/* Faint grid, so the panel has texture rather than being a flat box. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative grid items-center gap-6 px-6 py-8 sm:grid-cols-[1fr_220px] sm:px-8">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <HaloBadge variant="secondary" tabularNums live={pending > 0}>
                {pending > 0 ? `${pending} pending` : "ledger live"}
              </HaloBadge>
              <span className="label">Walrus Memory · mainnet</span>
            </div>
            <h1 className="text-[30px] font-semibold leading-[1.12] tracking-[-0.03em] sm:text-[34px]">
              Claims, ranked by
              <br className="hidden sm:block" /> who has been right.
            </h1>
            <p className="mt-3 max-w-[54ch] text-[14px] leading-relaxed text-ink-2">
              A source falls below {TRUST_MUTED.toFixed(2)} and its claims stop
              appearing here. Trust is a Wilson lower bound over adjudicated
              claims — one correct guess is not evidence.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button asChild size="sm" className="gap-1.5">
                <a href="/ingest">
                  Ingest a post
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button asChild size="sm" variant="ghost" className="gap-1.5 text-ink-2">
                <a href="/memory">Inspect the memory log</a>
              </Button>
            </div>
          </div>

          <div className="hidden justify-self-end sm:block">
            <ReceiptIllustration className="h-[150px] w-[190px]" />
          </div>
        </div>

        {/* Stat strip */}
        <div className="relative grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
          <Kpi label="claims shown" value={String(visible.length)} />
          <Kpi label="resolved" value={String(resolved)} />
          <Kpi label="pending" value={String(pending)} hint="awaiting deadline" />
          <Kpi
            label="thresholds"
            value={`${TRUST_MUTED.toFixed(2)} / ${TRUST_TRUSTED.toFixed(2)}`}
            hint="mute / trust"
          />
        </div>
      </section>

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      {loadError ? (
        <div className="rounded-xl border border-false/30 bg-false/5 p-5">
          <p className="label mb-1.5 text-false">API unreachable</p>
          <p className="text-[13px] text-ink-2">{loadError}</p>
          <p className="mt-2 text-[12px] text-ink-3">
            Set <span className="mono">NEXT_PUBLIC_API_URL</span> to the Coolify API
            origin, or check that the API container is healthy.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="space-y-2">
          {visible.map(({ claim, source }, i) => {
            const adjudicated = source.hits + source.misses;
            const band = trustBand(source.score, adjudicated);

            return (
              <li
                key={claim.id}
                className="rise group relative overflow-hidden rounded-xl border border-line bg-surface-1 transition-colors hover:border-line-strong"
                style={{ animationDelay: `${Math.min(i, 8) * 28}ms` }}
              >
                <div className="flex items-stretch">
                  {/* Rank gutter */}
                  <div className="flex w-11 shrink-0 flex-col items-center justify-start border-r border-line bg-surface-0/40 pt-4">
                    <span className="tnum text-[12px] text-ink-3">{i + 1}</span>
                  </div>

                  <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                        {claim.status === "resolved" ? (
                          <VerdictBadge outcome="true" />
                        ) : claim.status === "void" ? (
                          <VerdictBadge outcome="void" />
                        ) : (
                          <HaloBadge variant="outline" className="text-[11px]">
                            pending
                          </HaloBadge>
                        )}
                        {claim.sourceUrl?.startsWith("https://") && (
                          <a
                            href={claim.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open the original post"
                            className="text-ink-3 transition-colors hover:text-ink"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
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
                      {claim.walrusBlobId && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">/</span>
                          <span className="mono">blob {claim.walrusBlobId.slice(0, 10)}…</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Trust spine */}
                  <div className="hidden w-32 shrink-0 flex-col justify-center gap-2 border-l border-line px-4 sm:flex">
                    <span className="label">trust</span>
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
      <section className="mt-12 overflow-hidden rounded-2xl border border-line bg-surface-1">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <LedgerIllustration className="h-5 w-6 text-ink-3" muted />
          <h2 className="text-[13px] font-medium">How to read a row</h2>
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-3">
          <LegendItem
            visual={<TrustMeter score={0.62} band="trusted" size="sm" />}
            title="Trust meter"
            body={`Fill is the score. The two ticks are the mute (${TRUST_MUTED.toFixed(2)}) and trust (${TRUST_TRUSTED.toFixed(2)}) thresholds.`}
          />
          <LegendItem
            visual={<VerdictBadge outcome="void" />}
            title="Verdict"
            body="True and false are judgements. Void means we could not check — it never moves a score."
          />
          <LegendItem
            visual={<span className="mono text-[11px] text-ink-2">0.48 · 8/10</span>}
            title="Score and record"
            body="Wilson lower bound, then hits over adjudicated claims. Sample size is always visible."
          />
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-surface-1 px-4 py-3">
      <dt className="label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2">
        <span className="tnum text-[19px] font-medium tracking-[-0.01em]">{value}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </dd>
    </div>
  );
}

function LegendItem({
  visual,
  title,
  body,
}: {
  visual: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-surface-1 px-5 py-4">
      <div className="mb-2.5 flex h-5 items-center">{visual}</div>
      <p className="mb-1 text-[12px] font-medium text-ink">{title}</p>
      <p className="text-[12px] leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface-1 px-6 py-12 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-[0.06]"
        style={{
          background: "radial-gradient(60% 100% at 50% 0%, var(--color-accent), transparent)",
        }}
      />
      <div className="relative mx-auto flex max-w-md flex-col items-center">
        <SealIllustration className="mb-4 h-[92px] w-[120px]" />
        <p className="text-[16px] font-medium">No claims in the ledger yet.</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Paste a post that makes a checkable claim about onchain state. Walkback
          freezes a balance snapshot, waits for the deadline, then checks it
          against Sui mainnet.
        </p>
        <Button asChild size="sm" className="mt-5 gap-1.5">
          <a href="/ingest">
            Ingest a post
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}
