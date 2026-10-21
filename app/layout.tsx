import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Walkback — receipts for onchain claims",
  description:
    "Sources make claims. Walkback checks them against Sui mainnet and demotes the ones that get it wrong.",
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
            <a href="/" className="group flex items-baseline gap-2.5">
              <span className="relative flex h-5 w-5 items-center justify-center self-center">
                {/* Mark: a receipt line that folds back on itself. */}
                <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
                  <path
                    d="M4 3.5h9.5a2 2 0 0 1 2 2v9.5a1.5 1.5 0 0 1-2.4 1.2l-1.7-1.25a.9.9 0 0 0-1.1 0l-1.7 1.25A1.5 1.5 0 0 1 6.2 15l-1.7-1.25"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    className="text-ink"
                  />
                  <path
                    d="M7 7.5h6M7 10.5h4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    className="text-accent"
                  />
                </svg>
              </span>
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
