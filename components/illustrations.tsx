/**
 * Line-art illustrations.
 *
 * The product is a ledger, so the motifs are paper artefacts: a torn receipt,
 * a stamp, an archive drawer, a ledger column. Drawn as SVG rather than
 * commissioned art so they can carry the accent colour, survive both themes,
 * and stay crisp at any size.
 *
 * Every illustration shares one stroke language: 1.5px hairlines, rounded caps,
 * no fills except the accent wash. That is what makes four different drawings
 * read as one set.
 */

interface IllustrationProps {
  className?: string;
  /** Monochrome line work, no accent. For small or repeated placements. */
  muted?: boolean;
}

const STROKE = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

/** A torn receipt — the core motif. */
export function ReceiptIllustration({ className, muted }: IllustrationProps) {
  const accent = muted ? "currentColor" : "var(--color-accent)";
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      <g {...STROKE} className="text-ink-3">
        {/* Paper with a torn bottom edge */}
        <path d="M52 18h96v118l-8-6-8 6-8-6-8 6-8-6-8 6-8-6-8 6-8-6-8 6-8-6-8 6V18z" />
        {/* Ruled lines */}
        <path d="M68 42h64M68 56h44M68 70h52M68 84h36" opacity="0.5" />
        {/* Total rule */}
        <path d="M68 104h64" strokeDasharray="3 3" opacity="0.6" />
      </g>
      {/* Accent: the checked line */}
      <g stroke={accent} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M68 118h30" opacity="0.7" />
        <circle cx="122" cy="118" r="9" />
        <path d="M118 118l3 3 6-6" />
      </g>
      {/* Corner fold */}
      <path
        d="M132 18v14h16"
        {...STROKE}
        className="text-ink-3"
        opacity="0.35"
      />
    </svg>
  );
}

/** Ledger columns with a rising trace — "learning over time". */
export function LedgerIllustration({ className, muted }: IllustrationProps) {
  const accent = muted ? "currentColor" : "var(--color-accent)";
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      <g {...STROKE} className="text-ink-3">
        <rect x="26" y="30" width="148" height="104" rx="3" />
        <path d="M26 48h148M74 48v86" opacity="0.6" />
        {/* Row lines */}
        <path d="M38 66h24M84 66h74M38 84h24M84 84h58M38 102h24M84 102h66" opacity="0.45" />
        <path d="M38 120h24" opacity="0.45" />
      </g>
      {/* Accent trace rising through the rows */}
      <path
        d="M84 118l20-14 16 10 14-22 16 8 12-24"
        stroke={accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <g fill={accent}>
        <circle cx="84" cy="118" r="2.5" />
        <circle cx="162" cy="76" r="2.5" />
      </g>
    </svg>
  );
}

/** A wax-seal style stamp — the verdict mark. */
export function SealIllustration({ className, muted }: IllustrationProps) {
  const accent = muted ? "currentColor" : "var(--color-accent)";
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      {/* Radiating notches */}
      <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="text-ink-3" opacity="0.5">
        {Array.from({ length: 16 }).map((_, i) => {
          const a = (i / 16) * Math.PI * 2;
          const r1 = 52;
          const r2 = 60;
          return (
            <path
              key={i}
              d={`M${100 + Math.cos(a) * r1} ${80 + Math.sin(a) * r1}L${100 + Math.cos(a) * r2} ${80 + Math.sin(a) * r2}`}
            />
          );
        })}
      </g>
      <circle cx="100" cy="80" r="46" {...STROKE} className="text-ink-3" />
      <circle cx="100" cy="80" r="38" {...STROKE} className="text-ink-3" opacity="0.5" />
      <g stroke={accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M86 80l10 10 20-22" />
      </g>
    </svg>
  );
}

/** Archive drawers — memory that outlives the session. */
export function ArchiveIllustration({ className, muted }: IllustrationProps) {
  const accent = muted ? "currentColor" : "var(--color-accent)";
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      <g {...STROKE} className="text-ink-3">
        <rect x="40" y="26" width="120" height="108" rx="4" />
        <path d="M40 62h120M40 98h120" opacity="0.6" />
        {/* Handles */}
        <path d="M88 44h24M88 80h24" opacity="0.5" />
        {/* Open drawer, pulled forward */}
        <path d="M40 106h34l6 8h0" opacity="0" />
      </g>
      {/* Accent: one drawer open with a card lifting out */}
      <g stroke={accent} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M46 106h108v20H46z" />
        <path d="M88 106v20M112 106v20" opacity="0.5" />
        <path d="M92 106V86h16v20" />
        <path d="M92 92h16" opacity="0.6" />
      </g>
    </svg>
  );
}

/** A magnifier over ruled rows — verification. */
export function InspectIllustration({ className, muted }: IllustrationProps) {
  const accent = muted ? "currentColor" : "var(--color-accent)";
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      <g {...STROKE} className="text-ink-3">
        <rect x="24" y="34" width="104" height="92" rx="3" />
        <path d="M36 54h80M36 68h80M36 82h56M36 96h80M36 110h44" opacity="0.45" />
      </g>
      {/* Accent: lens + handle */}
      <g stroke={accent} strokeWidth={1.8} strokeLinecap="round" fill="none">
        <circle cx="126" cy="70" r="26" />
        <path d="M145 89l22 22" strokeWidth={2.6} />
      </g>
      <circle cx="126" cy="70" r="26" fill={accent} opacity="0.07" />
    </svg>
  );
}

/** Horizontal divider with a woven rule — used under section headers. */
export function WovenRule({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 8" preserveAspectRatio="none" className={className} aria-hidden="true">
      <path
        d="M0 4h400"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="1 5"
        opacity="0.5"
      />
    </svg>
  );
}
