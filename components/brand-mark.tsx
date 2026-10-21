import { cn } from "cn"

/**
 * Walkback mark: a torn receipt with the check that means "we kept it".
 *
 * Drawn for 16–32px. The paper is currentColor so it follows the header ink;
 * the check is the accent, hardcoded as a token so it stays purple on the
 * dark theme. Strokes are heavy enough to survive a browser tab.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        d="M7 5h13.5V10.5H26V22l-3.2 2.6-3.2-2.6-3.2 2.6-3.2-2.6-3.2 2.6L7 22V5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 5 26 10.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M11 15.2 14.2 18.4 21.4 10.8"
        stroke="var(--color-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
