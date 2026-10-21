/**
 * Verdict badge.
 *
 * Red and green are indistinguishable under deuteranopia (ΔE 4.1 on this
 * surface), so a verdict is triply encoded: a distinct glyph shape, a word,
 * and a colour. Removing any one of the three still leaves it readable.
 */
import { getTranslations } from "next-intl/server";
import type { Outcome } from "@/lib/types";

const SPEC: Record<
  Outcome,
  { glyph: React.ReactNode; text: string; ring: string; bg: string }
> = {
  true: {
    text: "text-true",
    ring: "border-true/35",
    bg: "bg-true/8",
    glyph: (
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
        <path
          d="M2.5 6.2 4.8 8.5 9.5 3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  false: {
    text: "text-false",
    ring: "border-false/35",
    bg: "bg-false/8",
    glyph: (
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
        <path
          d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  void: {
    text: "text-ink-3",
    ring: "border-line-strong",
    bg: "bg-surface-2",
    glyph: (
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
        <circle cx="6" cy="6" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.5 8.5 8.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
};

export default async function VerdictBadge({
  outcome,
  size = "sm",
}: {
  outcome: Outcome;
  size?: "sm" | "lg";
}) {
  const t = await getTranslations("verdict");
  const s = SPEC[outcome];
  const pad = size === "lg" ? "px-2.5 py-1 text-[13px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border ${s.ring} ${s.bg} ${s.text} ${pad} font-medium`}
    >
      {s.glyph}
      {t(outcome)}
    </span>
  );
}
