/**
 * Trust meter.
 *
 * A score is a magnitude bounded by two published thresholds, so the form is a
 * track with both marks always drawn: the reader sees not just "0.48" but how
 * far it sits from being muted, and how far from being trusted. That distance
 * is the product's whole argument, and a bare number hides it.
 *
 * The fill uses one accent ramp (low → mid → high), not a traffic light, so it
 * reads as a single magnitude scale. The band is also stated in words next to
 * it — colour never carries the meaning alone.
 */
import { getLocale, getTranslations } from "next-intl/server";
import { TRUST_MUTED, TRUST_TRUSTED, type TrustBand } from "@/lib/score";
import { formatCount, formatFixed } from "@/lib/locale-format";
import { isLocale, type Locale } from "@/lib/locale";

const FILL: Record<TrustBand, string> = {
  unknown: "bg-band-low",
  muted: "bg-band-low",
  normal: "bg-band-mid",
  trusted: "bg-band-high",
};

const BAND_TEXT: Record<TrustBand, string> = {
  unknown: "text-ink-3",
  muted: "text-ink-2",
  normal: "text-ink-2",
  trusted: "text-accent",
};

async function locale(): Promise<Locale> {
  const value = await getLocale();
  return isLocale(value) ? value : "en";
}

export async function TrustMeter({
  score,
  band,
  size = "md",
  showMarks = true,
  rated = true,
}: {
  score: number;
  band: TrustBand;
  size?: "sm" | "md";
  showMarks?: boolean;
  /** False until three claims are adjudicated. The track stays; the fill does not pretend the bound is a score. */
  rated?: boolean;
}) {
  const t = await getTranslations("band");
  const lang = await locale();
  const pct = Math.max(0, Math.min(1, score)) * 100;
  const h = size === "sm" ? 4 : 6;
  return (
    <div
      className="meter-track w-full"
      title={
        rated
          ? t("meterTitle", { score: formatFixed(score, lang), band: t(band) })
          : t("unknown")
      }
    >
      <div className="meter" style={{ height: h, borderRadius: h / 2 }}>
        {rated && (
          <div
            className={`fill ${FILL[band]}`}
            style={{ width: `${pct}%`, borderRadius: h / 2 }}
          />
        )}
      </div>
      {showMarks && (
        <>
          <span
            className="meter-mark"
            style={{ left: `${TRUST_MUTED * 100}%` }}
            aria-hidden="true"
          />
          <span
            className="meter-mark strong"
            style={{ left: `${TRUST_TRUSTED * 100}%` }}
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}

/** Score + band word + sample size, the atom used in rows and headers. */
export async function TrustReadout({
  score,
  band,
  hits,
  misses,
  compact = false,
  rated = true,
}: {
  score: number;
  band: TrustBand;
  hits: number;
  misses: number;
  compact?: boolean;
  rated?: boolean;
}) {
  const t = await getTranslations("band");
  const common = await getTranslations("common");
  const lang = await locale();
  const adjudicated = hits + misses;
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="tnum text-[15px] font-medium tracking-[-0.01em]">
        {rated ? formatFixed(score, lang) : common("unavailable")}
      </span>
      <span className={`text-[11px] ${BAND_TEXT[band]}`}>{t(band)}</span>
      {!compact && rated && (
        <span className="text-[11px] text-ink-3 tnum">
          {formatCount(hits, lang)}/{formatCount(adjudicated, lang)}
        </span>
      )}
    </span>
  );
}

export { BAND_TEXT };
