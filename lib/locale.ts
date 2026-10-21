/**
 * Locale for the UI chrome.
 *
 * No path prefix: `/ingest` stays `/ingest`. The choice is the NEXT_LOCALE
 * cookie; the first visit falls back to Accept-Language, then English.
 */

export const locales = ["en", "zh-Hant"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "zh-Hant";
}

/**
 * Traditional Chinese tags only. zh-CN / zh-Hans stay on English — this app
 * has no Simplified catalog, and showing Traditional to that browser would
 * be the wrong language.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return defaultLocale;
  const tags = header
    .split(",")
    .map((part) => {
      const [tagRaw, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().toLowerCase().startsWith("q="));
      const quality = qParam ? Number(qParam.split("=")[1]) : 1;
      return {
        tag: (tagRaw ?? "").trim().toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((item) => item.tag.length > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of tags) {
    if (
      tag === "zh-hant" ||
      tag === "zh-tw" ||
      tag === "zh-hk" ||
      tag === "zh-mo" ||
      tag.startsWith("zh-hant-")
    ) {
      return "zh-Hant";
    }
  }
  return defaultLocale;
}
