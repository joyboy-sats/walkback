import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import "./globals.css";

export const metadata: Metadata = {
  title: "Walkback — receipts for onchain claims",
  description:
    "Sources make claims. Walkback checks them against Sui mainnet and demotes the ones that get it wrong.",
  applicationName: "Walkback",
  openGraph: {
    title: "Walkback — we keep the receipts",
    description:
      "Sources make claims. Walkback checks them against Sui mainnet and demotes the ones that get it wrong.",
  },
};

const nav = [
  { href: "/", label: "Feed" },
  { href: "/ingest", label: "Ingest" },
  { href: "/memory", label: "Memory" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="sticky top-0 z-20 border-b border-line bg-surface-0/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-6">
            <a href="/" className="group flex items-center gap-2.5">
              <BrandMark className="h-5 w-5 text-ink" />
              <span className="text-[15px] font-semibold tracking-[-0.01em]">Walkback</span>
            </a>
            <span className="hidden text-[13px] text-ink-3 sm:inline">we keep the receipts</span>

            <nav className="ml-auto flex items-center gap-1">
              {nav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>

        <footer className="mx-auto mt-16 max-w-5xl px-6 pb-14">
          <div className="rule flex flex-col gap-2 pt-5 text-[12px] text-ink-3 sm:flex-row sm:items-baseline">
            <span>
              Every claim, verdict and score version is written to Walrus Memory on mainnet.
            </span>
            <span className="sm:ml-auto">
              Trust is a Wilson lower bound. A void is not a lie.
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
