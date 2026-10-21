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
import { getLocale, getTranslations } from "next-intl/server";
import { ApiError, apiGet } from "@/lib/public-api";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, scoreIsShown, trustBand } from "@/lib/score";
import { formatCount, formatDateOnly, formatFixed, formatPercent } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";
import { matchVoidReason, voidReasonValues } from "@/lib/void-reason";
import VerdictBadge from "@/components/verdict-badge";
import { TrustMeter } from "@/components/trust-meter";
import { InspectIllustration } from "@/components/illustrations";
import { HaloBadge } from "@/components/ui/halo-badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

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
  const t = await getTranslations("source");
  const bandLabel = await getTranslations("band");
  const voidCopy = await getTranslations("voidReason");
  const common = await getTranslations("common");
  const locale = await uiLocale();
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
        <p className="label mb-1 text-false">{t("couldNotLoad")}</p>
        <p className="text-[13px] text-ink-2">{message}</p>
      </div>
    );
  }

  const { source, versions, claims } = detail;
  const adjudicated = source.hits + source.misses;
  const band = trustBand(source.score, adjudicated);
  const rated = scoreIsShown(adjudicated);
  const hitRate = adjudicated === 0 ? null : source.hits / adjudicated;
  const deadlines = claims
    .map((row) => row.claim.deadline)
    .filter((value) => value.length >= 10)
    .sort();
  const firstDeadline = deadlines[0];
  const lastDeadline = deadlines[deadlines.length - 1];
  const windowLabel =
    !firstDeadline || !lastDeadline
      ? common("unavailable")
      : firstDeadline.slice(0, 10) === lastDeadline.slice(0, 10)
        ? formatDateOnly(firstDeadline, locale)
        : t("windowRange", {
            from: formatDateOnly(firstDeadline, locale),
            to: formatDateOnly(lastDeadline, locale),
          });

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
      <Button asChild variant="ghost" size="sm" className="-ml-2 h-7 gap-1.5 px-2 text-[12px] text-ink-3">
        <a href="/">
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("back")}
        </a>
      </Button>

      {/* ── Headline ───────────────────────────────────────────────────── */}
      <header className="relative mt-4 overflow-hidden rounded-2xl border border-line bg-surface-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative grid items-start gap-6 px-6 py-7 lg:grid-cols-[1fr_190px]">
        <div>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <HaloBadge
            variant={band === "muted" ? "destructive" : band === "trusted" ? "default" : "secondary"}
            tabularNums
          >
            {bandLabel(band)}
          </HaloBadge>
          <span className="label">{t("kicker")}</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex items-end gap-5">
            <h1 className="text-[30px] font-semibold leading-none tracking-[-0.025em]">
              {source.handle}
            </h1>
          </div>
          <div className="flex items-end gap-8">
            <div>
              <p className="label mb-1.5">{t("trust")}</p>
              <p className="tnum text-[30px] font-semibold leading-none tracking-[-0.02em]">
                {rated ? formatFixed(source.score, locale) : common("unavailable")}
              </p>
              {!rated && (
                <p className="mt-1.5 text-[11px] text-ink-3">
                  {common("needed", { done: adjudicated, need: MIN_SAMPLE })}
                </p>
              )}
            </div>
            <div>
              <p className="label mb-1.5">{t("sample")}</p>
              <p className="text-[13px] leading-relaxed text-ink-2">
                <span className="tnum">{formatCount(source.hits, locale)}</span> {t("hit")}
                <span className="text-ink-3"> · </span>
                <span className="tnum">{formatCount(source.misses, locale)}</span> {t("miss")}
                <span className="text-ink-3"> · </span>
                <span className="tnum">{formatCount(counts.void, locale)}</span> {t("void")}
                <span className="text-ink-3"> · </span>
                <span className="tnum">{formatCount(counts.pending, locale)}</span> {t("pending")}
              </p>
            </div>
            <div>
              <p className="label mb-1.5">{t("window")}</p>
              <p className="tnum text-[13px] leading-relaxed text-ink-2">{windowLabel}</p>
            </div>
            <div>
              <p className="label mb-1.5">{t("hitRate")}</p>
              <p className="tnum text-[16px] leading-none text-ink-2">
                {hitRate === null ? common("unavailable") : formatPercent(hitRate, locale)}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <TrustMeter score={source.score} band={band} rated={rated} />
          <div className="mt-2 flex justify-between text-[11px] text-ink-3">
            <span>{t("mute", { value: formatFixed(TRUST_MUTED, locale) })}</span>
            <span>{t("trustMark", { value: formatFixed(TRUST_TRUSTED, locale) })}</span>
          </div>
        </div>

        {adjudicated < MIN_SAMPLE && (
          <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-ink-2">
            {t("belowMin", { count: MIN_SAMPLE })}
          </p>
        )}
        </div>
        <div className="hidden justify-self-end lg:block">
          <InspectIllustration className="h-[128px] w-[160px]" />
        </div>
        </div>
      </header>

      {/* ── Verdict tally ──────────────────────────────────────────────── */}
      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
        <Tally label={t("true")} value={counts.true} tone="text-true" locale={locale} />
        <Tally label={t("false")} value={counts.false} tone="text-false" locale={locale} />
        <Tally label={t("void")} value={counts.void} tone="text-ink-2" locale={locale} />
        <Tally label={t("pending")} value={counts.pending} tone="text-ink-2" locale={locale} />
      </dl>

      {/* ── Score history ──────────────────────────────────────────────── */}
      {versions.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="label">{t("history")}</h2>
            <span className="text-[11px] text-ink-3">{t("versions", { count: versions.length })}</span>
          </div>
          <Sparkline
            values={versions.map((v) => v.score)}
            labels={versions.map((v) => `v${v.version}`)}
            locale={locale}
            caption={t("spark", {
              from: formatFixed(versions[0]?.score ?? 0, locale),
              to: formatFixed(versions[versions.length - 1]?.score ?? 0, locale),
              count: versions.length,
            })}
            muteLabel={t("sparkMute")}
            trustLabel={t("sparkTrust")}
          />
        </section>
      )}

      {/* ── Evidence chain ─────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="label mb-3">{t("chain")}</h2>

        {claims.length === 0 ? (
          <p className="text-[13px] text-ink-3">{t("none")}</p>
        ) : (
          <ol className="space-y-px overflow-hidden rounded-lg border border-line bg-line">
            {claims.map(({ claim, resolution }) => (
              <li key={claim.id} className="bg-surface-1 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-center gap-2">
                  {resolution ? (
                    <VerdictBadge outcome={resolution.outcome} />
                  ) : (
                    <span className="rounded border border-line-strong px-2 py-0.5 text-[11px] text-ink-3">
                      {t("pending")}
                    </span>
                  )}
                  <span className="mono text-[11px] text-ink-3">{claim.claimType}</span>
                  {claim.synthetic && (
                    <span className="rounded border border-line-strong px-1.5 py-px text-[11px] text-ink-3">
                      {t("synthetic")}
                    </span>
                  )}
                  <span className="mono tnum ml-auto text-[11px] text-ink-3">
                    {formatDateOnly(claim.deadline, locale)}
                  </span>
                </div>

                <blockquote className="mt-2.5 text-[14px] leading-[1.6]">
                  <span className="text-ink-3">“</span>
                  {claim.quote}
                  <span className="text-ink-3">”</span>
                </blockquote>

                {resolution && (
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                    {resolution.outcome === "void"
                      ? translatedVoid(voidCopy, resolution.reason)
                      : resolution.reason}
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
                      {t("raw")}
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
                      {t("original")}
                    </a>
                  )}
                  {claim.walrusBlobId && (
                    <span>{t("claimBlob", { id: claim.walrusBlobId.slice(0, 14) })}</span>
                  )}
                  {resolution?.walrusBlobId && (
                    <span>{t("verdictBlob", { id: resolution.walrusBlobId.slice(0, 14) })}</span>
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
function Sparkline({
  values,
  labels,
  locale,
  caption,
  muteLabel,
  trustLabel,
}: {
  values: number[];
  labels: string[];
  locale: Locale;
  caption: string;
  muteLabel: string;
  trustLabel: string;
}) {
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
        aria-label={caption}
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
          {trustLabel}
        </text>
        <text x={padL - 6} y={y(TRUST_MUTED) + 9} textAnchor="end" fontSize="8.5" fill="var(--color-ink-3)" className="mono">
          {muteLabel}
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
          {formatFixed(last, locale)}
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

function Tally({
  label,
  value,
  tone,
  locale,
}: {
  label: string;
  value: number;
  tone: string;
  locale: Locale;
}) {
  return (
    <div className={`bg-surface-1 px-4 py-3 ${value === 0 ? "opacity-45" : ""}`}>
      <dt className="label">{label}</dt>
      <dd className={`tnum mt-1.5 text-[19px] font-medium ${tone}`}>{formatCount(value, locale)}</dd>
    </div>
  );
}

async function uiLocale(): Promise<Locale> {
  const value = await getLocale();
  return isLocale(value) ? value : "en";
}

function translatedVoid(
  t: Awaited<ReturnType<typeof getTranslations<"voidReason">>>,
  reason: string,
): string {
  const match = matchVoidReason(reason);
  if (!match) return reason;
  switch (match.key) {
    case "deadline":
      return t("deadline", { deadline: match.deadline });
    case "placeholder":
      return t("placeholder", { address: match.address });
    case "manual":
      return t("manual");
    case "unknownType":
      return t("unknownType", { type: match.type });
    case "checkFailed":
      return t("checkFailed", { message: match.message });
    case "noSnapshot":
      return t("noSnapshot");
    case "replayTruncated":
      return t("replayTruncated", voidReasonValues(match));
    case "rateUnsupported":
      return t("rateUnsupported", { pair: match.pair });
    case "synthetic":
      return t("synthetic");
  }
}
