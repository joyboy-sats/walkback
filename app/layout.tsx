import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitcher } from "@/components/locale-switcher";
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
  const nav = [
    { href: "/", label: t("feed") },
    { href: "/ingest", label: t("ingest") },
    { href: "/memory", label: t("memory") },
  ];

  return (
    <html lang={locale}>
      <body className="min-h-dvh">
        <NextIntlClientProvider>
          <header className="sticky top-0 z-20 border-b border-line bg-surface-0/85 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
              <a href="/" className="group flex shrink-0 items-center gap-2">
                <BrandMark className="h-7 w-7" />
                <span className="text-[14px] font-semibold tracking-[-0.01em] sm:text-[15px]">
                  Walkback
                </span>
              </a>
              <span className="hidden text-[13px] text-ink-3 sm:inline">{t("tagline")}</span>

              <div className="ml-auto flex items-center gap-1 sm:gap-2">
                <nav className="flex items-center">
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
            <div className="rule flex flex-col gap-2 pt-5 text-[12px] text-ink-3 sm:flex-row sm:items-baseline">
              <span>{footer("record")}</span>
              <span className="sm:ml-auto">{footer("bound")}</span>
            </div>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
