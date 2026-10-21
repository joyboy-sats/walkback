import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { isLocale, localeFromAcceptLanguage, LOCALE_COOKIE, type Locale } from "@/lib/locale";

const catalogs: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import("../messages/en.json"),
  "zh-Hant": () => import("../messages/zh-Hant.json"),
};

export default getRequestConfig(async () => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookie)
    ? cookie
    : localeFromAcceptLanguage((await headers()).get("accept-language"));

  return {
    locale,
    timeZone: "UTC",
    messages: (await catalogs[locale]()).default,
  };
});
