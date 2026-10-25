/**
 * Conditional wording ("a breakout above 1.08 could trigger a move to 1.28").
 *
 * The precondition is not the claim. Adjudication judges the target amount
 * already stored on the row. This module only records that a precondition
 * was ignored, and whether the stored amount is the precondition rather than
 * the target. It does not change a verdict.
 */

const VERBS = [
  "could trigger",
  "could signal",
  "could confirm",
  "could open",
  "would bring",
  "may bring",
] as const;

export interface IgnoredCondition {
  /** The precondition clause, through the conditional verb. Not the target. */
  text: string;
  verbAt: number;
}

export function ignoredCondition(quote: string): IgnoredCondition | null {
  const lower = quote.toLowerCase();
  let verbAt = -1;
  let verbLen = 0;
  for (const verb of VERBS) {
    const at = lower.indexOf(verb);
    if (at !== -1 && (verbAt === -1 || at < verbAt)) {
      verbAt = at;
      verbLen = verb.length;
    }
  }
  if (verbAt === -1) return null;
  const before = quote.slice(0, verbAt);
  let from = 0;
  for (const token of [". ", ".\n", "! ", "!\n", "? ", "?\n", "\n"]) {
    const at = before.lastIndexOf(token);
    if (at !== -1) from = Math.max(from, at + token.length);
  }
  const text = quote.slice(from, verbAt + verbLen).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { text, verbAt };
}

function amounts(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\$?\d+(?:\.\d+)?/g)) {
    const n = Number(match[0].replace(/^\$/, ""));
    if (Number.isFinite(n)) found.push(n);
  }
  return found;
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * True only when the stored amount is the precondition (the number before
 * the conditional verb) and the quote names a different number after it.
 * Those rows would need a different target before they were re-judged.
 * Seed rows store the target, so this stays false for them.
 */
export function conditionWouldChange(quote: string, amount: string | null | undefined): boolean {
  const found = ignoredCondition(quote);
  if (!found || amount == null || amount === "") return false;
  const target = Number(amount);
  if (!Number.isFinite(target)) return false;
  const before = amounts(quote.slice(0, found.verbAt));
  const after = amounts(quote.slice(found.verbAt));
  const storedIsPrecondition = before.some((n) => same(n, target));
  const distinctLater = after.some((n) => !same(n, target));
  return storedIsPrecondition && distinctLater;
}

export interface ConditionalClaimRow {
  id: string;
  handle: string;
  quote: string;
  amount: string | null;
  condition: string;
  wouldChange: boolean;
}

interface SeedClaim {
  quote?: unknown;
  params?: unknown;
}

interface SeedPost {
  id?: unknown;
  handle?: unknown;
  claims?: unknown;
}

/** Scan `data/claims.json`. Does not read verdicts and does not invent any. */
export function scanConditionalClaims(posts: readonly SeedPost[]): ConditionalClaimRow[] {
  const rows: ConditionalClaimRow[] = [];
  for (const post of posts) {
    if (!Array.isArray(post.claims)) continue;
    for (const claim of post.claims as SeedClaim[]) {
      if (typeof claim.quote !== "string") continue;
      const ignored = ignoredCondition(claim.quote);
      if (!ignored) continue;
      const params = claim.params && typeof claim.params === "object" ? (claim.params as Record<string, unknown>) : {};
      const amount = typeof params.amount === "string" ? params.amount : null;
      rows.push({
        id: typeof post.id === "string" ? post.id : "",
        handle: typeof post.handle === "string" ? post.handle : "",
        quote: claim.quote,
        amount,
        condition: ignored.text,
        wouldChange: conditionWouldChange(claim.quote, amount),
      });
    }
  }
  return rows;
}
