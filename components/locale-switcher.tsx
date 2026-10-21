"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useTransition, type KeyboardEvent } from "react";
import { isLocale, LOCALE_COOKIE, type Locale } from "@/lib/locale";

const ORDER: Locale[] = ["en", "zh-Hant"];

/**
 * English / 繁體中文. The cookie is NEXT_LOCALE; router.refresh() re-renders
 * the server chrome without navigating, so the Ingest form and the admin
 * token in sessionStorage stay put.
 */
export function LocaleSwitcher() {
  const current = useLocale();
  const locale: Locale = isLocale(current) ? current : "en";
  const t = useTranslations("nav");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refs = useRef<Record<Locale, HTMLButtonElement | null>>({
    en: null,
    "zh-Hant": null,
  });

  function choose(next: Locale) {
    if (next === locale || pending) return;
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    startTransition(() => {
      router.refresh();
    });
    refs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = ORDER.indexOf(locale);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      choose(ORDER[(index + 1) % ORDER.length] ?? "en");
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      choose(ORDER[(index - 1 + ORDER.length) % ORDER.length] ?? "en");
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={t("language")}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center rounded-md border border-line p-0.5"
    >
      <LocaleOption
        buttonRef={(node) => {
          refs.current.en = node;
        }}
        pressed={locale === "en"}
        pending={pending}
        onClick={() => choose("en")}
        shortLabel={t("englishShort")}
        label={t("english")}
      />
      <LocaleOption
        buttonRef={(node) => {
          refs.current["zh-Hant"] = node;
        }}
        pressed={locale === "zh-Hant"}
        pending={pending}
        onClick={() => choose("zh-Hant")}
        shortLabel={t("traditionalShort")}
        label={t("traditional")}
      />
    </div>
  );
}

function LocaleOption({
  pressed,
  pending,
  onClick,
  shortLabel,
  label,
  buttonRef,
}: {
  pressed: boolean;
  pending: boolean;
  onClick: () => void;
  shortLabel: string;
  label: string;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={pressed}
      tabIndex={pressed ? 0 : -1}
      disabled={pending}
      onClick={onClick}
      className={`cursor-pointer rounded px-1.5 py-1 text-[12px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-2 ${
        pressed ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink"
      } disabled:opacity-60`}
    >
      <span className="sm:hidden">{shortLabel}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
