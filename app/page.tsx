/**
 * Homepage.
 *
 * Counts come from the API. A chart is drawn only when a claim stored at
 * least two deciding candles. Pending rows show a deadline countdown and
 * do not ask for a live price.
 */
import { getLocale, getTranslations } from "next-intl/server";
import { apiGet } from "@/lib/public-api";
import type { ClaimDetail } from "@/lib/claim-view";
import {
  displayDecimal,
  groupFeed,
  heroClaim,
  heroSource,
  pricePath,
  shownActual,
  type ShownActual,
} from "@/lib/feed-present";
import {
  feedRows,
  includeMutedParam,
  type LedgerSource,
  type LedgerView,
} from "@/lib/ledger";
import { MIN_SAMPLE, scoreIsShown, type TrustBand } from "@/lib/score";
import { formatCount, formatDateOnly, formatFixed, formatTimestamp } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
import { CopyId } from "@/components/copy-id";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { PriceChart } from "@/components/price-chart";
import { Term } from "@/components/term";
import { BAND_TEXT } from "@/components/trust-meter";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";

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
  const exampleSource = heroSource(sources);
  const exampleRow = exampleSource ? heroClaim(rows, exampleSource.handle) : null;
  const exampleDetail = exampleRow?.claim.detail ?? null;
  const examplePath = pricePath(exampleDetail);
  const groups = groupFeed(rows, includeMuted);
  const listCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const limit = feedMeta?.limit ?? null;
  const capped = limit !== null && rows.length >= limit && (totals?.all.claims ?? rows.length) > rows.length;
  const forecastSources = sources.filter(inForecast).sort((a, b) => compareCategory(a, b, "forecast"));
  const reportingSources = sources.filter(inReporting).sort((a, b) => compareCategory(a, b, "reporting"));

  return (
    <div>
      <section className="mb-8">
        <p className="label mb-3">{t("network")}</p>
        <h1 className="max-w-[22ch] text-[30px] font-semibold leading-[1.12] tracking-[-0.03em] sm:text-[34px]">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">{t("subline")}</p>

        {exampleSource?.forecast && (
          <div className="mt-5 max-w-[62ch] border-t border-dashed border-line pt-4">
            <p className="text-[15px] leading-relaxed">
              {t("heroExample", {
                handle: exampleSource.handle,
                n: exampleSource.forecast.n,
                hits: exampleSource.forecast.hits,
              })}
            </p>
            {exampleDetail && (
              <div className="mt-3">
                <p className="text-[14px] leading-relaxed text-ink-2">{claimSentence(exampleDetail, locale, t)}</p>
                {examplePath ? (
                  <PriceChart path={examplePath} label={t("chartLabel")} />
                ) : (
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                    {actualPair(exampleDetail, locale, t)}
                  </p>
                )}
                <p className="mt-2 text-[12px] text-ink-3">
                  <a href={`/sources/${exampleSource.id}`} className="underline-offset-4 hover:underline">
                    {exampleSource.handle}
                  </a>
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mb-8 rounded-xl border border-line bg-surface-1 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-[68ch]">
            {totals ? (
              <p className="text-[14px] leading-relaxed">
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
              </p>
            ) : (
              <p className="text-[14px] text-ink-2">{ledgerError ? t("ledgerDown") : t("overviewEmpty")}</p>
            )}
            {ledgerError && <p className="mt-1 text-[12px] text-ink-3">{ledgerError}</p>}
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              {includeMuted
                ? t("listIncludes", { count: listCount })
                : t("listExcludes", { count: listCount })}
              {capped && limit !== null ? ` ${t("listCapped", { limit })}` : ""}
            </p>
          </div>
          <Button asChild size="sm" variant={includeMuted ? "secondary" : "outline"} className="w-fit">
            <a href={includeMuted ? "/" : "/?muted=1"} aria-pressed={includeMuted}>
              {t("includeMuted")}
            </a>
          </Button>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-[13px] font-medium">{t("leaderboard")}</h2>
        <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-ink-3">{t("leaderboardHint")}</p>
        {sources.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">{t("overviewEmpty")}</p>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Leaderboard
              title={t("colForecast")}
              sources={forecastSources}
              category="forecast"
              locale={locale}
              empty={t("columnEmpty")}
            />
            <Leaderboard
              title={t("colReporting")}
              sources={reportingSources}
              category="reporting"
              locale={locale}
              empty={t("columnEmpty")}
            />
          </div>
        )}
      </section>

      {loadError ? (
        <div className="rounded-xl border border-false/30 bg-false/5 p-5">
          <p className="label mb-1.5 text-false">{t("apiDown")}</p>
          <p className="text-[13px] text-ink-2">{loadError}</p>
        </div>
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-1 px-5 py-6 text-[13px] text-ink-2">
          {rows.length === 0 ? t("emptyTitle") : t("filteredEmpty")}
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => {
            const basis = basisRecord(group.source);
            const rated = scoreIsShown(basis?.n ?? 0);
            return (
              <details key={group.source.id} className="rounded-xl border border-line bg-surface-1">
                <summary className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                  <span className="text-[14px] font-medium">{group.source.handle}</span>
                  <span className="text-[13px] text-ink-2">{groupSummary(group.source, group.rows, t)}</span>
                  <span className="ml-auto flex items-baseline gap-2">
                    <span className="text-[11px] text-ink-3">{t("trustScore")}</span>
                    <span className="tnum text-[18px] font-medium tracking-[-0.02em]">
                      {rated && basis
                        ? formatFixed(basis.score, locale)
                        : `${common("unavailable")} ${t("unratedScore", { done: basis?.n ?? 0, need: MIN_SAMPLE })}`}
                    </span>
                    <span className={`text-[11px] ${BAND_TEXT[basis?.band ?? "unknown"]}`}>
                      {bandLabel((basis?.band ?? "unknown") as TrustBand)}
                    </span>
                  </span>
                </summary>
                <div className="border-t border-dashed border-line">
                  <p className="px-4 pt-3 text-[12px]">
                    <a href={`/sources/${group.source.id}`} className="underline-offset-4 hover:underline">
                      {t("sourcePage")}
                    </a>
                    {muteBasisNote(group.source, t) && (
                      <span className="ml-3 text-ink-3">{muteBasisNote(group.source, t)}</span>
                    )}
                    <span className="ml-3">
                      <Term label={t("trustScore")} tip={t("trustScoreTip")} />
                    </span>
                  </p>
                  <ol>
                    {group.rows.map((row) => (
                      <li key={row.claim.id} className="border-t border-line px-4 py-4">
                        <ClaimRow row={row} locale={locale} />
                      </li>
                    ))}
                  </ol>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function Leaderboard({
  title,
  sources,
  category,
  locale,
  empty,
}: {
  title: string;
  sources: LedgerSource[];
  category: "forecast" | "reporting";
  locale: Locale;
  empty: string;
}) {
  const t = await getTranslations("feed");
  const bandLabel = await getTranslations("band");
  const common = await getTranslations("common");
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
      <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-medium">{title}</h3>
      {sources.length === 0 ? (
        <p className="px-4 py-4 text-[12px] text-ink-3">{empty}</p>
      ) : (
        <ul>
          {sources.map((source) => {
            const record = source[category];
            const n = record?.n ?? 0;
            const rated = scoreIsShown(n);
            return (
              <li key={source.id} className="border-b border-line last:border-0">
                <a
                  href={`/sources/${source.id}`}
                  className="block px-4 py-2.5 transition-colors hover:bg-surface-2"
                >
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[14px] font-medium">{source.handle}</span>
                    <span className={`text-[11px] ${BAND_TEXT[record?.band ?? "unknown"]}`}>
                      {bandLabel((record?.band ?? "unknown") as TrustBand)}
                    </span>
                    <span className="tnum ml-auto text-[13px] font-medium">
                      {rated && record
                        ? formatFixed(record.score, locale)
                        : `${common("unavailable")} ${t("unratedScore", { done: n, need: MIN_SAMPLE })}`}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
                    <span className="tnum">
                      {t("rightWrong", { right: record?.hits ?? 0, wrong: record?.misses ?? 0 })}
                    </span>
                    {muteBasisNote(source, t) && <span>{muteBasisNote(source, t)}</span>}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

async function ClaimRow({ row, locale }: { row: ApiRow; locale: Locale }) {
  const t = await getTranslations("feed");
  const detail = row.claim.detail ?? null;
  const outcome = row.claim.resolution?.outcome ?? (row.claim.status === "void" ? "void" : null);
  const pending = row.claim.status === "pending" || outcome === null;
  const blobs = blobIds(row.claim, detail);
  const txLinks = detail?.transactions.filter((item) => item.url) ?? [];

  return (
    <article>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Term label={kindLabel(row.claim.claimType, t)} tip={kindTip(row.claim.claimType, t)} />
        {!pending && outcome && (
          <span className={outcome === "false" ? "text-[12px] text-false" : outcome === "true" ? "text-[12px] text-true" : "text-[12px] text-ink-3"}>
            {outcomeLabel(row.claim.claimType, outcome, t)}
          </span>
        )}
        {pending && <span className="text-[12px] text-ink-2">{t("pendingOpen")}</span>}
        <span className="text-[12px] text-ink-3">
          {detail?.publishedAt
            ? t("posted", { time: formatTimestamp(detail.publishedAt, locale) })
            : t("postedMissing")}
        </span>
      </div>

      <p className="mt-2 text-[15px] leading-[1.55]">{detail ? claimSentence(detail, locale, t) : row.claim.quote}</p>

      {pending ? (
        <p className="mt-2 text-[13px] text-ink-2">
          <DeadlineCountdown deadline={row.claim.deadline} />
        </p>
      ) : (
        detail &&
        detail.claimType === "price_threshold" && (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{actualPair(detail, locale, t)}</p>
        )
      )}

      {detail?.parsed.conditionIgnored && (
        <p className="mt-2 max-w-[68ch] text-[13px] leading-relaxed text-ink-2">
          {t("conditionNote", { text: detail.parsed.conditionIgnored.text })}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
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
      </div>

      {blobs.length > 0 && (
        <div className="mt-3 space-y-2">
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

      <details className="mt-3">
        <summary className="w-fit text-[12px] text-ink-3">{t("rawData")}</summary>
        <dl className="mt-2 max-w-[72ch] space-y-1.5 border-t border-dashed border-line pt-2 text-[12px] leading-relaxed text-ink-2">
          <Raw label={t("rawQuote")} value={row.claim.quote} />
          <Raw label={t("rawType")} value={row.claim.claimType} mono />
          <Raw label={t("rawBasis")} value={detail?.parsed.deadlineBasis ?? t("unknownValue")} />
          <Raw label={t("rawReason")} value={row.claim.resolution?.reason ?? detail?.reason ?? t("unknownValue")} />
          <Raw label={t("rawGrain")} value={detail?.actual?.granularity ?? t("unknownValue")} mono />
          {detail?.actual?.net && <Raw label={t("rawNet")} value={detail.actual.net} mono />}
          {detail?.tatum?.kind === "data_source" && <Raw label={t("rawTatum")} value={detail.tatum.label} />}
          {detail?.tatum?.kind === "request" && (
            <Raw label={t("rawTatum")} value={`${detail.tatum.endpoint} ${JSON.stringify(detail.tatum.params)}`} mono />
          )}
        </dl>
      </details>
    </article>
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

function groupSummary(
  source: LedgerSource,
  rows: ApiRow[],
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const parts: string[] = [];
  const pendingForecast = rows.filter(
    (row) => row.claim.status === "pending" && row.claim.claimType === "price_threshold",
  ).length;
  const pendingReporting = rows.filter(
    (row) => row.claim.status === "pending" && REPORTING_TYPES.has(row.claim.claimType),
  ).length;
  const forecastN = source.forecast?.n ?? 0;
  const reportingN = source.reporting?.n ?? 0;
  if (forecastN === 0 && reportingN === 0) parts.push(t("notYetRated"));
  if (forecastN > 0 && source.forecast) {
    parts.push(t("forecastSummary", { n: source.forecast.n, hits: source.forecast.hits }));
  } else if (pendingForecast > 0) {
    parts.push(t("forecastOpen", { count: pendingForecast }));
  }
  if (reportingN > 0 && source.reporting) {
    if (source.reporting.misses === 0) parts.push(t("reportsAllVerified", { n: source.reporting.n }));
    else parts.push(t("reportsRecord", { n: source.reporting.n, hits: source.reporting.hits }));
  } else if (pendingReporting > 0) {
    parts.push(t("reportsOpen", { count: pendingReporting }));
  }
  const pendingLeft = rows.filter((row) => row.claim.status === "pending").length - pendingForecast - pendingReporting;
  if (pendingLeft > 0) parts.push(t("stillOpen", { count: pendingLeft }));
  if (parts.length === 0) parts.push(t("claimsInGroup", { count: rows.length }));
  return parts.join(" · ");
}

function muteBasisNote(
  source: LedgerSource,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string | null {
  if (source.muteBasis === "forecast" && (source.forecast?.n ?? 0) > 0) return t("basisForecast");
  if (source.muteBasis === "reporting" && (source.reporting?.n ?? 0) > 0) return t("basisReporting");
  return null;
}

function basisRecord(source: LedgerSource) {
  if (source.muteBasis === "reporting") return source.reporting;
  if (source.muteBasis === "forecast") return source.forecast;
  return source.overall;
}

function inForecast(source: LedgerSource): boolean {
  return (source.forecast?.n ?? 0) > 0 || source.claimTypes.includes("price_threshold");
}

function inReporting(source: LedgerSource): boolean {
  return (source.reporting?.n ?? 0) > 0 || source.claimTypes.some((type) => REPORTING_TYPES.has(type));
}

function compareCategory(a: LedgerSource, b: LedgerSource, category: "forecast" | "reporting"): number {
  const order: Record<TrustBand, number> = { trusted: 0, normal: 1, muted: 2, unknown: 3 };
  const left = a[category];
  const right = b[category];
  const band = order[left?.band ?? "unknown"] - order[right?.band ?? "unknown"];
  if (band !== 0) return band;
  const score = (right?.score ?? 0) - (left?.score ?? 0);
  if (score !== 0 && (left?.band ?? "unknown") !== "unknown") return score;
  return a.handle.localeCompare(b.handle);
}

function uniqueSources(rows: ApiRow[]): LedgerSource[] {
  const seen = new Map<string, LedgerSource>();
  for (const row of rows) seen.set(row.source.id, row.source);
  return [...seen.values()];
}

function kindLabel(type: string, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (type === "price_threshold") return t("termForecast");
  if (type === "tx_replay") return t("termTx");
  if (type === "manual") return t("termManual");
  if (REPORTING_TYPES.has(type)) return t("termBalance");
  return type;
}

function kindTip(type: string, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (type === "price_threshold") return t("tipForecast");
  if (type === "tx_replay") return t("tipTx");
  if (type === "void") return t("tipVoid");
  return t("tipBalance");
}

function outcomeLabel(
  type: string,
  outcome: "true" | "false" | "void",
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (outcome === "void") return t("couldNotVerify");
  if (type === "price_threshold") return outcome === "true" ? t("cameTrue") : t("didNotComeTrue");
  return outcome === "true" ? t("verified") : t("didNotMatch");
}

async function uiLocale(): Promise<Locale> {
  const value = await getLocale();
  return isLocale(value) ? value : "en";
}
