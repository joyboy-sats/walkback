import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: t("title"),
    description: t("description"),
    applicationName: "Walkback",
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
    },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("nav");
  const footer = await getTranslations("footer");
  const common = await getTranslations("common");
  const nav = [
    { href: "/", label: t("feed") },
    { href: "/ingest", label: t("ingest") },
    { href: "/memory", label: t("memory") },
    { href: "/methodology", label: t("methodology") },
  ];

  return (
    <html lang={locale}>
      <body className="min-h-dvh">
        <NextIntlClientProvider>
          <TooltipProvider>
          <header className="sticky top-0 z-20 border-b border-line bg-surface-0/85 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
              <a href="/" className="group flex shrink-0 items-center gap-2">
                <BrandMark className="h-7 w-7" />
                <span className="text-[14px] font-semibold tracking-[-0.01em] sm:text-[15px]">
                  Walkback
                </span>
              </a>
              <span className="hidden min-w-0 truncate text-[13px] text-ink-3 lg:inline">{t("tagline")}</span>

              <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
                <details className="relative sm:hidden">
                  <summary className="list-none rounded-md px-2 py-1.5 text-[12px] text-ink-2 marker:content-none [&::-webkit-details-marker]:hidden">
                    {t("menu")}
                  </summary>
                  <nav className="absolute right-0 z-30 mt-1 w-max rounded-md border border-line bg-surface-1 p-1">
                    {nav.map((item) => (
                      <a
                        key={item.href}
                        href={item.href}
                        className="block w-fit rounded-md px-2.5 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
                      >
                        {item.label}
                      </a>
                    ))}
                  </nav>
                </details>
                <nav className="hidden items-center sm:flex">
                  {nav.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      className="rounded-md px-1.5 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink sm:px-2.5 sm:text-[13px]"
                    >
                      {item.label}
                    </a>
                  ))}
                </nav>
                <LocaleSwitcher />
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>

          <footer className="mx-auto mt-16 max-w-5xl px-6 pb-14">
            <p className="max-w-[68ch] text-[12px] leading-relaxed text-ink-3">{common("disclaimer")}</p>
            <div className="rule mt-4 flex flex-col gap-2 pt-5 text-[12px] text-ink-3 sm:flex-row sm:items-baseline">
              <a href="/methodology" className="w-fit underline-offset-4 hover:underline">
                {t("methodology")}
              </a>
              <span>{footer("record")}</span>
              <span className="sm:ml-auto">{footer("bound")}</span>
            </div>
          </footer>
          </TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
