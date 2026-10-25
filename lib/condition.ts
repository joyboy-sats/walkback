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
  "could target",
  "would bring",
  "may bring",
] as const;

export interface IgnoredCondition {
  /** The precondition clause, through the conditional verb. Not the target. */
  text: string;
  verbAt: number;
}

function findVerb(quote: string): { at: number; len: number } | null {
  const lower = quote.toLowerCase();
  let best: { at: number; len: number } | null = null;
  for (const verb of VERBS) {
    const at = lower.indexOf(verb);
    if (at !== -1 && (!best || at < best.at)) best = { at, len: verb.length };
  }
  return best;
}

/** A leading or mid-quote "If …" precondition, not the word inside another token. */
function findIf(quote: string): { at: number; len: number } | null {
  const match = /\bif\b/i.exec(quote);
  if (!match) return null;
  return { at: match.index, len: match[0].length };
}

function clauseStart(quote: string, at: number): number {
  const before = quote.slice(0, at);
  let from = 0;
  for (const token of [". ", ".\n", "! ", "!\n", "? ", "?\n", "\n"]) {
    const found = before.lastIndexOf(token);
    if (found !== -1) from = Math.max(from, found + token.length);
  }
  return from;
}

export function ignoredCondition(quote: string): IgnoredCondition | null {
  const verb = findVerb(quote);
  const iff = findIf(quote);
  if (!verb && !iff) return null;

  // The verb is the split between the precondition and the target. An If-clause
  // with no such verb ends at the comma, so "$1.00" stays in the condition
  // and a later target does not.
  let verbAt: number;
  let verbEnd: number;
  if (verb) {
    verbAt = verb.at;
    verbEnd = verb.at + verb.len;
  } else {
    const comma = quote.indexOf(",", iff!.at);
    verbAt = comma === -1 ? quote.length : comma;
    verbEnd = verbAt;
  }

  let from = clauseStart(quote, verbAt);
  if (iff && iff.at >= from && iff.at <= verbAt) from = iff.at;
  const text = quote.slice(from, verbEnd).replace(/\s+/g, " ").trim();
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
