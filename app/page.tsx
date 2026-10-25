/**
 * Feed — claims ranked by their source's trust.
 *
 * The source list above the feed names every source, including muted and
 * unrated ones. The feed itself hides muted claims until "Include muted" is on,
 * so a low score does not erase the evidence. Ledger totals count the whole
 * projection; the line above the rows counts only what this view is showing.
 *
 * Server component. Rows come from the Coolify API over HTTP.
 */
import { getLocale, getTranslations } from "next-intl/server";
import { apiGet } from "@/lib/public-api";
import { feedRows, includeMutedParam, visibleClaims, type LedgerView } from "@/lib/ledger";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, scoreIsShown, trustBand } from "@/lib/score";
import { formatCount, formatDateOnly, formatFixed } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
import VerdictBadge from "@/components/verdict-badge";
import { BAND_TEXT, TrustMeter, TrustReadout } from "@/components/trust-meter";
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
    resolution?: { outcome: "true" | "false" | "void"; reason: string } | null;
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

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ muted?: string | string[] }>;
}) {
  const t = await getTranslations("feed");
  const common = await getTranslations("common");
  const bandLabel = await getTranslations("band");
  const locale = await uiLocale();
  const includeMuted = includeMutedParam((await searchParams).muted);

  let rows: FeedRow[] = [];
  let loadError: string | null = null;
  let ledger: LedgerView | null = null;
  let ledgerError: string | null = null;
  const [feedSettled, ledgerSettled] = await Promise.allSettled([
    apiGet<FeedRow[] | { rows: FeedRow[] }>("/feed"),
    apiGet<LedgerView>("/ledger"),
  ]);
  if (feedSettled.status === "fulfilled") rows = feedRows(feedSettled.value);
  else loadError = feedSettled.reason instanceof Error ? feedSettled.reason.message : String(feedSettled.reason);
  if (ledgerSettled.status === "fulfilled") ledger = ledgerSettled.value;
  else ledgerError = ledgerSettled.reason instanceof Error ? ledgerSettled.reason.message : String(ledgerSettled.reason);

  const { visible, hidden } = visibleClaims(rows, includeMuted);
  const pending = visible.filter((r) => r.claim.status === "pending").length;
  const resolved = visible.filter((r) => r.claim.status === "resolved").length;
  const globalPending = ledger?.totals.pending ?? pending;
  const memories = ledger?.totals.memories;
  const memoryVerified = memories?.verified ?? null;
  const memoryValue = memoryVerified === null ? (memories?.inventory ?? 0) : memoryVerified;
  const memoryKind = memoryVerified === null ? t("memoryInventory") : t("memoryVerified");

  return (
    <div>
      {/* ── Masthead ───────────────────────────────────────────────────── */}
      <section className="relative mb-10 overflow-hidden rounded-2xl border border-line bg-surface-1">
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
              <HaloBadge variant="secondary" tabularNums live={globalPending > 0}>
                {globalPending > 0 ? t("pendingCount", { count: globalPending }) : t("live")}
              </HaloBadge>
              <span className="label">{t("network")}</span>
            </div>
            <h1 className="text-[30px] font-semibold leading-[1.12] tracking-[-0.03em] sm:text-[34px]">
              {t("title")}
            </h1>
            <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">{t("subline")}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button asChild size="sm" className="w-fit gap-1.5">
                <a href="/ingest">
                  {t("ingest")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button asChild size="sm" variant="ghost" className="w-fit gap-1.5 text-ink-2">
                <a href="/memory">{t("inspect")}</a>
              </Button>
            </div>
          </div>

          <div className="hidden justify-self-end sm:block">
            <ReceiptIllustration className="h-[150px] w-[190px]" />
          </div>
        </div>

        {ledgerError ? (
          <div className="relative border-t border-line px-6 py-3">
            <p className="label text-false">{t("ledgerDown")}</p>
            <p className="mt-1 text-[12px] text-ink-2">{ledgerError}</p>
          </div>
        ) : ledger ? (
          <>
            <dl className="relative grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
              <Kpi label={t("ledgerClaims")} value={formatCount(ledger.totals.claims, locale)} />
              <Kpi label={t("ledgerResolved")} value={formatCount(ledger.totals.resolved, locale)} />
              <Kpi
                label={t("ledgerPending")}
                value={formatCount(ledger.totals.pending, locale)}
                hint={t("awaiting")}
              />
              <div className="bg-surface-1 px-4 py-3">
                <dt className="label">
                  {t("ledgerMemories")} · {memoryKind}
                </dt>
                <dd className="mt-1.5 flex items-baseline gap-2">
                  <a
                    href="/memory"
                    aria-label={t("memoryLink")}
                    className="tnum text-[19px] font-medium tracking-[-0.01em] underline-offset-4 hover:underline"
                  >
                    {formatCount(memoryValue, locale)}
                  </a>
                  {memoryVerified !== null && memoryVerified !== memories?.inventory && (
                    <span className="text-[11px] text-ink-3">
                      {t("memoryInventoryHint", { count: memories?.inventory ?? 0 })}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            {ledger.totals.void > 0 && (
              <p className="border-t border-line bg-surface-1 px-4 py-2 text-[12px] leading-relaxed text-ink-3">
                {t("couldNotCheck", { count: ledger.totals.void })}
              </p>
            )}
          </>
        ) : null}
      </section>

      <p className="mb-6 max-w-[68ch] text-[13px] leading-relaxed text-ink-2">{common("disclaimer")}</p>

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-[62ch]">
            <h2 className="text-[13px] font-medium">{t("allSources")}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
              {includeMuted ? t("includeMutedOn") : t("includeMutedHint")}
            </p>
          </div>
          <Button asChild size="sm" variant={includeMuted ? "secondary" : "outline"} className="w-fit">
            <a href={includeMuted ? "/" : "/?muted=1"} aria-pressed={includeMuted}>
              {t("includeMuted")}
            </a>
          </Button>
        </div>

        {ledgerError ? null : !ledger || ledger.sources.length === 0 ? (
          <p className="text-[13px] text-ink-3">{t("overviewEmpty")}</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface-1">
            {ledger.sources.map((source) => {
              const adjudicated = source.hits + source.misses;
              const rated = scoreIsShown(adjudicated);
              return (
                <li key={source.id} className="border-b border-line last:border-0">
                  <a
                    href={`/sources/${source.id}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-surface-2 sm:grid sm:grid-cols-[minmax(0,1.15fr)_5.5rem_minmax(9rem,1fr)_4.75rem_minmax(0,1.25fr)] sm:items-center"
                  >
                    <span className="truncate text-[14px] font-medium">{source.handle}</span>
                    <span className={`text-[11px] ${BAND_TEXT[source.band]}`}>{bandLabel(source.band)}</span>
                    <span className="tnum text-[12px] text-ink-2">
                      {t("rightWrong", { right: source.hits, wrong: source.misses })}
                    </span>
                    <span className="tnum text-[13px] font-medium">
                      {rated
                        ? formatFixed(source.score, locale)
                        : `${common("unavailable")} ${t("unratedScore", { done: adjudicated, need: MIN_SAMPLE })}`}
                    </span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {source.claimTypes.length === 0 ? (
                        <span className="text-[11px] text-ink-3">{common("unavailable")}</span>
                      ) : (
                        source.claimTypes.map((type) => (
                          <span key={type} className="inline-flex items-baseline gap-1.5">
                            <span className="text-[12px] text-ink-2">{claimTypeName(t, type)}</span>
                            <span className="mono text-[10px] text-ink-3">{type}</span>
                          </span>
                        ))
                      )}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!loadError && rows.length > 0 && (
        <p className="mb-3 text-[12px] text-ink-2">
          <span className="label mr-2">{t("inFeed")}</span>
          <span className="tnum">{formatCount(visible.length, locale)}</span> {t("shown")}
          <span aria-hidden="true" className="mx-1.5 text-line-strong">
            /
          </span>
          <span className="tnum">{formatCount(resolved, locale)}</span> {t("resolved")}
          <span aria-hidden="true" className="mx-1.5 text-line-strong">
            /
          </span>
          <span className="tnum">{formatCount(pending, locale)}</span> {t("pending")}
        </p>
      )}

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      {loadError ? (
        <div className="rounded-xl border border-false/30 bg-false/5 p-5">
          <p className="label mb-1.5 text-false">{t("apiDown")}</p>
          <p className="text-[13px] text-ink-2">{loadError}</p>
          <p className="mt-2 text-[12px] text-ink-3">
            {t("apiHintBefore")} <span className="mono">NEXT_PUBLIC_API_URL</span>{" "}
            {t("apiHintAfter")}
          </p>
        </div>
      ) : visible.length === 0 && hidden > 0 ? (
        <p className="rounded-xl border border-line bg-surface-1 px-5 py-6 text-[13px] text-ink-2">
          {t("filteredEmpty")}
        </p>
      ) : visible.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="space-y-2">
          {visible.map(({ claim, source }, i) => {
            const adjudicated = source.hits + source.misses;
            const band = trustBand(source.score, adjudicated);
            const rated = scoreIsShown(adjudicated);

            return (
              <li
                key={claim.id}
                className="rise group relative overflow-hidden rounded-xl border border-line bg-surface-1 transition-colors hover:border-line-strong"
                style={{ animationDelay: `${Math.min(i, 8) * 28}ms` }}
              >
                <div className="flex items-stretch">
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
                        rated={rated}
                      />
                      {!rated && (
                        <span className="text-[11px] text-ink-3">
                          {common("needed", { done: adjudicated, need: MIN_SAMPLE })}
                        </span>
                      )}
                      {source.muted && (
                        <HaloBadge variant="outline" className="text-[11px]">
                          {bandLabel("muted")}
                        </HaloBadge>
                      )}

                      <span className="ml-auto flex items-center gap-2">
                        {claim.resolution ? (
                          <VerdictBadge outcome={claim.resolution.outcome} />
                        ) : claim.status === "resolved" ? (
                          <VerdictBadge outcome="true" />
                        ) : claim.status === "void" ? (
                          <VerdictBadge outcome="void" />
                        ) : (
                          <HaloBadge variant="outline" className="text-[11px]">
                            {t("pending")}
                          </HaloBadge>
                        )}
                        {claim.sourceUrl?.startsWith("https://") && (
                          <a
                            href={claim.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={t("openPost")}
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

                    {claim.resolution?.outcome === "void" && (
                      <p className="mt-2 max-w-[68ch] text-[13px] leading-relaxed text-ink-2">
                        {claim.resolution.reason}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-3">
                      <span className="mono">{claim.claimType}</span>
                      <span aria-hidden="true" className="text-line-strong">
                        /
                      </span>
                      <span className="mono tnum">
                        {t("due", { date: formatDateOnly(claim.deadline, locale) })}
                      </span>
                      {claim.synthetic && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">
                            /
                          </span>
                          <span className="rounded border border-line-strong px-1.5 py-px">
                            {t("synthetic")}
                          </span>
                        </>
                      )}
                      {claim.walrusBlobId && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">
                            /
                          </span>
                          <span className="mono">
                            {t("blob", { id: claim.walrusBlobId.slice(0, 10) })}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="hidden w-32 shrink-0 flex-col justify-center gap-2 border-l border-line px-4 sm:flex">
                    <span className="label">{t("trust")}</span>
                    <TrustMeter score={source.score} band={band} size="sm" rated={rated} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hidden > 0 && (
        <p className="mt-4 text-[12px] text-ink-3">{t("hidden", { count: hidden })}</p>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <section className="mt-12 overflow-hidden rounded-2xl border border-line bg-surface-1">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <LedgerIllustration className="h-5 w-6 text-ink-3" muted />
          <h2 className="text-[13px] font-medium">{t("legendTitle")}</h2>
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-3">
          <LegendItem
            visual={<TrustMeter score={0.62} band="trusted" size="sm" />}
            title={t("meterTitle")}
            body={t("meterBody", {
              mute: formatFixed(TRUST_MUTED, locale),
              trust: formatFixed(TRUST_TRUSTED, locale),
            })}
          />
          <LegendItem
            visual={<VerdictBadge outcome="void" />}
            title={t("verdictTitle")}
            body={t("verdictBody")}
          />
          <LegendItem
            visual={
              <span className="mono text-[11px] text-ink-2">
                {formatFixed(0.48, locale)} · {formatCount(8, locale)}/{formatCount(10, locale)}
              </span>
            }
            title={t("scoreTitle")}
            body={t("scoreBody")}
          />
        </div>
      </section>
    </div>
  );
}

function claimTypeName(
  t: Awaited<ReturnType<typeof getTranslations>>,
  type: string,
): string {
  switch (type) {
    case "tx_replay":
      return t("claimTypes.tx_replay");
    case "price_threshold":
      return t("claimTypes.price_threshold");
    case "balance_threshold":
      return t("claimTypes.balance_threshold");
    case "balance_change_since_ingest":
      return t("claimTypes.balance_change_since_ingest");
    case "manual":
      return t("claimTypes.manual");
    default:
      return type;
  }
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

async function uiLocale(): Promise<Locale> {
  const value = await getLocale();
  return isLocale(value) ? value : "en";
}

async function EmptyState() {
  const t = await getTranslations("feed");
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
        <p className="text-[16px] font-medium">{t("emptyTitle")}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{t("emptyBody")}</p>
        <Button asChild size="sm" className="mt-5 w-fit gap-1.5">
          <a href="/ingest">
            {t("ingest")}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}
