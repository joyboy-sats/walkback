/**
 * Feed — claims ranked by their source's trust.
 *
 * The masthead, source table, and receipt rows keep the pre-redesign layout.
 * Counts, category records, and price wording come from the API. A chart is
 * drawn only when a claim stored at least two deciding candles of one size.
 */
import { getLocale, getTranslations } from "next-intl/server";
import { apiGet } from "@/lib/public-api";
import type { ClaimDetail } from "@/lib/claim-view";
import { displayDecimal, pricePath, shownActual, type ShownActual } from "@/lib/feed-present";
import {
  feedRows,
  includeMutedParam,
  visibleClaims,
  type LedgerSource,
  type LedgerView,
} from "@/lib/ledger";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, scoreIsShown, trustBand } from "@/lib/score";
import { formatCount, formatDateOnly, formatFixed, formatTimestamp } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
import VerdictBadge from "@/components/verdict-badge";
import { BAND_TEXT, TrustMeter, TrustReadout } from "@/components/trust-meter";
import { ReceiptIllustration, LedgerIllustration, SealIllustration } from "@/components/illustrations";
import { HaloBadge } from "@/components/ui/halo-badge";
import { Button } from "@/components/ui/button";
import { CopyId } from "@/components/copy-id";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { PriceChart } from "@/components/price-chart";
import { ArrowRight, ExternalLink } from "lucide-react";

interface ApiClaim {
  id: string;
  quote: string;
  claimType: string;
  status: string;
  deadline: string;
  synthetic: boolean;
  sourceUrl: string | null;
  walrusBlobId: string | null;
  resolution?: { outcome: "true" | "false" | "void"; reason: string } | null;
  detail?: ClaimDetail | null;
}

interface ApiRow {
  claim: ApiClaim;
  source: LedgerSource;
}

interface ApiFeed {
  rows?: ApiRow[];
  limit?: number;
  totals?: LedgerView["totals"];
}

const REPORTING_TYPES = new Set(["tx_replay", "balance_threshold", "balance_change_since_ingest"]);

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

  let rows: ApiRow[] = [];
  let feedMeta: ApiFeed | null = null;
  let loadError: string | null = null;
  let ledger: LedgerView | null = null;
  let ledgerError: string | null = null;
  const [feedSettled, ledgerSettled] = await Promise.allSettled([
    apiGet<ApiRow[] | ApiFeed>("/feed"),
    apiGet<LedgerView>("/ledger"),
  ]);
  if (feedSettled.status === "fulfilled") {
    rows = feedRows(feedSettled.value);
    feedMeta = Array.isArray(feedSettled.value) ? null : feedSettled.value;
  } else {
    loadError = feedSettled.reason instanceof Error ? feedSettled.reason.message : String(feedSettled.reason);
  }
  if (ledgerSettled.status === "fulfilled") ledger = ledgerSettled.value;
  else ledgerError = ledgerSettled.reason instanceof Error ? ledgerSettled.reason.message : String(ledgerSettled.reason);

  const totals = ledger?.totals ?? feedMeta?.totals ?? null;
  const sources = ledger?.sources ?? uniqueSources(rows);
  const pending = pendingBySource(rows);
  const { visible, hidden } = visibleClaims(rows, includeMuted);
  const pendingCount = visible.filter((row) => row.claim.status === "pending").length;
  const resolved = visible.filter((row) => row.claim.status === "resolved").length;
  const globalPending = ledger?.totals.pending ?? pendingCount;
  const memories = ledger?.totals.memories;
  const memoryVerified = memories?.verified ?? null;
  const memoryValue = memoryVerified === null ? (memories?.inventory ?? 0) : memoryVerified;
  const memoryKind = memoryVerified === null ? t("memoryInventory") : t("memoryVerified");
  const limit = feedMeta?.limit ?? null;
  const capped = limit !== null && rows.length >= limit && (totals?.all.claims ?? rows.length) > rows.length;

  return (
    <div>
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
          <div className="min-w-0 max-w-[68ch]">
            <h2 className="text-[13px] font-medium">{t("allSources")}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
              {includeMuted ? t("includeMutedOn") : t("includeMutedHint")}
            </p>
            {totals && (
              <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                {totals.hiddenClaimsFalse === null
                  ? t("filterLineNoWrong", {
                      all: totals.all.claims,
                      shown: totals.visible.claims,
                      hidden: totals.hiddenClaims,
                      sources: totals.mutedSources,
                      allScope: t("scopeIncludes"),
                      shownScope: t("scopeExcludes"),
                    })
                  : t("filterLine", {
                      all: totals.all.claims,
                      shown: totals.visible.claims,
                      hidden: totals.hiddenClaims,
                      sources: totals.mutedSources,
                      wrong: totals.hiddenClaimsFalse,
                      allScope: t("scopeIncludes"),
                      shownScope: t("scopeExcludes"),
                    })}
                {capped && limit !== null ? ` ${t("listCapped", { limit })}` : ""}
              </p>
            )}
          </div>
          <Button asChild size="sm" variant={includeMuted ? "secondary" : "outline"} className="w-fit">
            <a href={includeMuted ? "/" : "/?muted=1"} aria-pressed={includeMuted}>
              {includeMuted ? t("hideMuted") : t("includeMuted")}
            </a>
          </Button>
        </div>

        {ledgerError ? null : sources.length === 0 ? (
          <p className="text-[13px] text-ink-3">{t("overviewEmpty")}</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
            <div className="hidden border-b border-line px-4 py-2 text-[11px] text-ink-3 sm:grid sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-4">
              <span className="label">{t("allSources")}</span>
              <span className="label">{t("colForecast")}</span>
              <span className="label">{t("colReporting")}</span>
            </div>
            <ul>
              {sources.map((source) => {
                const counts = pending.get(source.id) ?? { forecast: 0, reporting: 0 };
                return (
                  <li key={source.id} className="border-b border-line last:border-0">
                    <a
                      href={`/sources/${source.id}`}
                      className="grid min-w-0 grid-cols-1 gap-2 px-4 py-2.5 transition-colors hover:bg-surface-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-x-4"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="truncate text-[14px] font-medium">{source.handle}</span>
                          <span className={`text-[11px] ${BAND_TEXT[source.band]}`}>{bandLabel(source.band)}</span>
                        </span>
                        {source.claimTypes.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                            {source.claimTypes.map((type) => (
                              <span key={type} className="text-[11px] text-ink-3">
                                {claimTypeName(t, type)}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      <CategoryCell
                        source={source}
                        category="forecast"
                        label={t("colForecast")}
                        pending={counts.forecast}
                        openLabel={t("forecastOpen", { count: counts.forecast })}
                        locale={locale}
                        unavailable={common("unavailable")}
                        unrated={t("unratedScore", {
                          done: source.forecast?.n ?? 0,
                          need: MIN_SAMPLE,
                        })}
                        bandName={bandLabel((source.forecast?.band ?? "unknown") as LedgerSource["band"])}
                        rightWrong={t("rightWrong", {
                          right: source.forecast?.hits ?? 0,
                          wrong: source.forecast?.misses ?? 0,
                        })}
                        basis={
                          source.muteBasis === "forecast" && (source.forecast?.n ?? 0) > 0
                            ? t("basisForecast")
                            : null
                        }
                      />
                      <CategoryCell
                        source={source}
                        category="reporting"
                        label={t("colReporting")}
                        pending={counts.reporting}
                        openLabel={t("reportsOpen", { count: counts.reporting })}
                        locale={locale}
                        unavailable={common("unavailable")}
                        unrated={t("unratedScore", {
                          done: source.reporting?.n ?? 0,
                          need: MIN_SAMPLE,
                        })}
                        bandName={bandLabel((source.reporting?.band ?? "unknown") as LedgerSource["band"])}
                        rightWrong={t("rightWrong", {
                          right: source.reporting?.hits ?? 0,
                          wrong: source.reporting?.misses ?? 0,
                        })}
                        basis={
                          source.muteBasis === "reporting" && (source.reporting?.n ?? 0) > 0
                            ? t("basisReporting")
                            : null
                        }
                      />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
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
          <span className="tnum">{formatCount(pendingCount, locale)}</span> {t("pending")}
        </p>
      )}

      {loadError ? (
        <div className="rounded-xl border border-false/30 bg-false/5 p-5">
          <p className="label mb-1.5 text-false">{t("apiDown")}</p>
          <p className="text-[13px] text-ink-2">{loadError}</p>
          <p className="mt-2 text-[12px] text-ink-3">
            {t("apiHintBefore")} <span className="mono">NEXT_PUBLIC_API_URL</span> {t("apiHintAfter")}
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
            const band = source.band ?? trustBand(source.score, adjudicated);
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
                      <span>{claimTypeName(t, claim.claimType)}</span>
                      <span aria-hidden="true" className="text-line-strong">
                        /
                      </span>
                      <span className="mono tnum">{t("due", { date: formatDateOnly(claim.deadline, locale) })}</span>
                      {claim.synthetic && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">
                            /
                          </span>
                          <span className="rounded border border-line-strong px-1.5 py-px">{t("synthetic")}</span>
                        </>
                      )}
                      {claim.walrusBlobId && (
                        <>
                          <span aria-hidden="true" className="text-line-strong">
                            /
                          </span>
                          <span className="mono">{t("blob", { id: claim.walrusBlobId.slice(0, 10) })}</span>
                        </>
                      )}
                    </div>

                    <Evidence row={{ claim, source }} locale={locale} t={t} />
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

      {hidden > 0 && <p className="mt-4 text-[12px] text-ink-3">{t("hidden", { count: hidden })}</p>}

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

function CategoryCell({
  source,
  category,
  label,
  pending,
  openLabel,
  locale,
  unavailable,
  unrated,
  bandName,
  rightWrong,
  basis,
}: {
  source: LedgerSource;
  category: "forecast" | "reporting";
  label: string;
  pending: number;
  openLabel: string;
  locale: Locale;
  unavailable: string;
  unrated: string;
  bandName: string;
  rightWrong: string;
  basis: string | null;
}) {
  const record = source[category];
  const n = record?.n ?? 0;
  const hasType =
    category === "forecast"
      ? source.claimTypes.includes("price_threshold")
      : source.claimTypes.some((type) => REPORTING_TYPES.has(type));
  if (n === 0 && pending === 0 && !hasType) {
    return (
      <span className="min-w-0 text-[12px] text-ink-3">
        <span className="mr-2 text-[11px] sm:hidden">{label}</span>
        {unavailable}
      </span>
    );
  }
  const rated = scoreIsShown(n);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] text-ink-3 sm:hidden">{label}</span>
        <span className={`text-[11px] ${BAND_TEXT[record?.band ?? "unknown"]}`}>{bandName}</span>
        {n > 0 && (
          <span className="tnum text-[13px] font-medium">
            {rated && record ? formatFixed(record.score, locale) : `${unavailable} ${unrated}`}
          </span>
        )}
        {n > 0 && <span className="tnum text-[12px] text-ink-2">{rightWrong}</span>}
        {n === 0 && pending > 0 && <span className="text-[12px] text-ink-2">{openLabel}</span>}
      </span>
      {basis && <span className="text-[11px] leading-relaxed text-ink-3">{basis}</span>}
    </span>
  );
}

function Evidence({
  row,
  locale,
  t,
}: {
  row: ApiRow;
  locale: Locale;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const detail = row.claim.detail ?? null;
  const pending = row.claim.status === "pending";
  const blobs = blobIds(row.claim, detail);
  const txLinks = detail?.transactions.filter((item) => item.url) ?? [];
  const path = pricePath(detail);
  const price = detail?.claimType === "price_threshold";

  return (
    <details className="mt-3">
      <summary className="w-fit text-[12px] text-ink-3">{t("evidence")}</summary>
      <div className="mt-3 max-w-[68ch] space-y-2 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
        {detail?.publishedAt && <p>{t("posted", { time: formatTimestamp(detail.publishedAt, locale) })}</p>}
        {!detail?.publishedAt && <p>{t("postedMissing")}</p>}
        {price && detail && <p>{claimSentence(detail, locale, t)}</p>}
        {pending ? (
          <p>
            <DeadlineCountdown deadline={row.claim.deadline} />
          </p>
        ) : (
          price && detail && <p>{actualPair(detail, locale, t)}</p>
        )}
        {detail?.parsed.conditionIgnored && (
          <p>{t("conditionNote", { text: detail.parsed.conditionIgnored.text })}</p>
        )}
        {(txLinks.length > 0 || row.claim.sourceUrl?.startsWith("https://")) && (
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {row.claim.sourceUrl?.startsWith("https://") && (
              <a
                href={row.claim.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 underline-offset-4 hover:underline"
              >
                {t("openPost")}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {txLinks.map((item) => (
              <a
                key={item.digest}
                href={item.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 underline-offset-4 hover:underline"
              >
                {t("suiscan")}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ))}
          </p>
        )}
        {path && <PriceChart path={path} label={t("chartLabel")} />}
        {blobs.length > 0 && (
          <div className="space-y-2">
            {blobs.map((blob) => (
              <CopyId
                key={blob.id}
                id={blob.id}
                label={blob.kind === "claim" ? t("claimBlob") : t("verdictBlob")}
                copyLabel={t("copy")}
                copiedLabel={t("copied")}
              />
            ))}
          </div>
        )}
        <details>
          <summary className="w-fit text-[12px] text-ink-3">{t("rawData")}</summary>
          <dl className="mt-2 space-y-1.5 text-[12px] leading-relaxed">
            <Raw label={t("rawQuote")} value={row.claim.quote} />
            <Raw label={t("rawType")} value={row.claim.claimType} mono />
            <Raw label={t("rawBasis")} value={detail?.parsed.deadlineBasis ?? t("unknownValue")} />
            <Raw label={t("rawReason")} value={row.claim.resolution?.reason ?? detail?.reason ?? t("unknownValue")} />
            <Raw label={t("rawGrain")} value={detail?.actual?.granularity ?? t("unknownValue")} mono />
            {detail?.actual?.net && <Raw label={t("rawNet")} value={detail.actual.net} mono />}
            {detail?.tatum?.kind === "data_source" && <Raw label={t("rawTatum")} value={detail.tatum.label} />}
            {detail?.tatum?.kind === "request" && (
              <Raw
                label={t("rawTatum")}
                value={`${detail.tatum.endpoint} ${JSON.stringify(detail.tatum.params)}`}
                mono
              />
            )}
          </dl>
        </details>
      </div>
    </details>
  );
}

function Raw({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-ink-3">{label}</dt>
      <dd className={mono ? "mono break-all" : "break-words"}>{value}</dd>
    </div>
  );
}

function claimTypeName(t: Awaited<ReturnType<typeof getTranslations>>, type: string): string {
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

function claimSentence(
  detail: ClaimDetail,
  locale: Locale,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (detail.claimType !== "price_threshold" || !detail.parsed.target) return detail.quote;
  const symbol = detail.parsed.symbol ?? t("unknownValue");
  const money = moneyOf(detail.parsed.target, detail.parsed.quote, t("unknownValue"));
  const deadlineIso = detail.parsed.window?.deadline ?? detail.deadline;
  const deadline = deadlineIso ? formatDateOnly(deadlineIso, locale) : t("unknownValue");
  const sinceIso = detail.parsed.window?.since;
  if (detail.parsed.evaluation === "at_deadline") {
    return t(detail.parsed.direction === "lte" ? "atMostDeadline" : "atLeastDeadline", {
      symbol,
      money,
      deadline,
    });
  }
  if (!sinceIso) return detail.quote;
  return t(detail.parsed.direction === "lte" ? "touchAtMost" : "touchAtLeast", {
    symbol,
    money,
    since: formatDateOnly(sinceIso, locale),
    deadline,
  });
}

function actualPair(
  detail: ClaimDetail,
  locale: Locale,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const expected = moneyOf(detail.expected, detail.parsed.quote, t("unknownValue"));
  const print = shownActual(detail);
  if (!print) return t("expectedOnly", { money: expected });
  return t("expectedActual", { money: expected, actual: actualText(print, detail.parsed.quote, locale, t) });
}

function moneyPrint(value: string, quote: string | null): string {
  const shown = displayDecimal(value);
  return quote === "USD" ? `$${shown}` : shown;
}

function actualText(
  print: ShownActual,
  quote: string | null,
  locale: Locale,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (print.bound) {
    const bound = moneyPrint(print.bound.value, quote);
    const boundDate = print.bound.at ? formatDateOnly(print.bound.at, locale) : null;
    const inside = print.inWindow;
    const inDate = inside?.at ? formatDateOnly(inside.at, locale) : null;
    if (inside && boundDate && inDate) {
      return t(print.field === "low" ? "actualBoundLowWindow" : "actualBoundHighWindow", {
        bound,
        boundDate,
        inWindow: moneyPrint(inside.value, quote),
        inWindowDate: inDate,
      });
    }
    if (boundDate) {
      return t(print.field === "low" ? "actualBoundLowDated" : "actualBoundHighDated", { bound, boundDate });
    }
    return t(print.field === "low" ? "actualBoundLow" : "actualBoundHigh", { value: bound });
  }
  if (!print.reached) return t("unknownValue");
  const value = moneyPrint(print.reached.value, quote);
  const date = print.reached.at ? formatDateOnly(print.reached.at, locale) : null;
  if (!date) return value;
  if (print.field === "low") return t("actualLow", { value, date });
  if (print.field === "close") return t("actualClose", { value, date });
  return t("actualHigh", { value, date });
}

function moneyOf(target: string | null, quote: string | null, unknown: string): string {
  if (!target) return unknown;
  if (quote === "USD") return `$${target}`;
  if (quote) return `${target} ${quote}`;
  return `${target} ${unknown}`;
}

function blobIds(
  claim: ApiClaim,
  detail: ClaimDetail | null,
): Array<{ id: string; kind: "claim" | "verdict" }> {
  const out: Array<{ id: string; kind: "claim" | "verdict" }> = [];
  const claimId = detail?.walrus.claimBlobId ?? claim.walrusBlobId;
  const verdictId = detail?.walrus.resolutionBlobId ?? null;
  if (claimId) out.push({ id: claimId, kind: "claim" });
  if (verdictId && verdictId !== claimId) out.push({ id: verdictId, kind: "verdict" });
  return out;
}

function pendingBySource(rows: readonly ApiRow[]): Map<string, { forecast: number; reporting: number }> {
  const map = new Map<string, { forecast: number; reporting: number }>();
  for (const row of rows) {
    const current = map.get(row.source.id) ?? { forecast: 0, reporting: 0 };
    if (row.claim.status === "pending") {
      if (row.claim.claimType === "price_threshold") current.forecast += 1;
      else if (REPORTING_TYPES.has(row.claim.claimType)) current.reporting += 1;
    }
    map.set(row.source.id, current);
  }
  return map;
}

function uniqueSources(rows: readonly ApiRow[]): LedgerSource[] {
  const seen = new Map<string, LedgerSource>();
  for (const row of rows) seen.set(row.source.id, row.source);
  return [...seen.values()];
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
