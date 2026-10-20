import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Walkback — receipts for onchain claims",
  description:
    "Sources make claims. Walkback checks them against Sui mainnet and demotes the ones that get it wrong.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-[var(--line)] px-6 py-4 flex items-baseline gap-4">
          <a href="/" className="text-lg font-semibold tracking-tight">
            Walkback
          </a>
          <span className="text-sm text-[var(--dim)]">we keep the receipts</span>
          <nav className="ml-auto flex gap-5 text-sm text-[var(--dim)]">
            <a href="/" className="hover:text-[var(--fg)]">Feed</a>
            <a href="/ingest" className="hover:text-[var(--fg)]">Ingest</a>
            <a href="/memory" className="hover:text-[var(--fg)]">Memory</a>
          </nav>
        </header>
        <main className="px-6 py-8 max-w-5xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
