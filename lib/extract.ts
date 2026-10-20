/**
 * Claim extraction.
 *
 * This is the product's brain, and the only place an LLM is used. Everything
 * downstream is deterministic arithmetic over what this returns, so the rule
 * is conservative: reject anything you cannot check. Most text yields zero
 * claims and that is the correct answer, not a failure.
 *
 * Why not `memwal.analyze()`? The relayer has a server-side fact extractor. We
 * do not use it here because:
 *   - the output schema is fixed by the relayer and includes facts we cannot
 *     adjudicate, which would pollute the ledger;
 *   - extraction decisions are the product's differentiator and need to be
 *     testable against fixtures;
 *   - we need `claim_type` + typed `params` + `deadline`, not "facts".
 * It is still a legitimate fallback worth mentioning in the writeup.
 */
import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import type { ClaimParams, ClaimType, ExtractedClaim } from "./types";

const claimTypes = [
  "balance_threshold",
  "balance_change_since_ingest",
  "tx_replay",
  "price_threshold",
  "manual",
] as const;

const schema = z.object({
  claims: z
    .array(
      z.object({
        quote: z
          .string()
          .describe("Exact span of the source text, max 200 chars. Never paraphrase."),
        claim_type: z.enum(claimTypes),
        params: z.record(z.string(), z.union([z.string(), z.number()])),
        deadline: z
          .string()
          .describe("Absolute ISO-8601 timestamp, UTC, resolved from relative wording."),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3),
});

const SYSTEM = `You extract machine-checkable claims from social posts and newsletters.

A claim is admissible ONLY if all of these hold:
1. It is about a concrete, observable state of the world (a balance, a transfer,
   a price) — not an opinion, a comparison of vibes, or a prediction with no
   number in it.
2. It has an explicit or strongly implied deadline within the next 30 days.
3. Every field in params can be filled from the text plus the source's known
   address. NEVER invent an address, an amount, or a deadline. If a value is
   missing, drop the claim.
4. Its truth is decidable by reading Sui mainnet state or a market price.

Return {"claims": []} when nothing qualifies. That is correct most of the time
and is never penalised. Prefer FEWER, HIGHER-CONFIDENCE claims: one solid claim
beats three shaky ones. Never return more than 3.

claim_type must be one of:
  balance_threshold            "I hold at least 50k SUI"
  balance_change_since_ingest  "I'm adding 10k SUI this week" (change from now to deadline)
  tx_replay                    a change that already happened, or a window in the past
  price_threshold              "SUI will be above $3 by Friday"
  manual                       checkable but none of the above fit

Use tx_replay only when the claim refers to a period that has already started
or ended. Historical balances cannot be queried, so a retroactive claim must be
reconstructed by replaying transactions. Otherwise prefer
balance_change_since_ingest, which we can measure by snapshotting at ingest.

For the quote field, copy the exact asserting span. Do not paraphrase, do not
clean up typos, do not merge two sentences.

Deadlines: resolve relative expressions against source_published_at. "this week"
published on a Tuesday means the following Sunday 23:59 UTC. If you cannot
resolve a deadline to an absolute timestamp, drop the claim.

params by type:
  balance_threshold            {address, asset, direction: "gte"|"lte", amount}
  balance_change_since_ingest  {address, asset, direction, amount}
  tx_replay                    {address, asset, since, until, direction, amount}
  price_threshold              {symbol, quote, direction, amount}
  manual                       {note}
amount is always a decimal string in base units (mist for SUI) for balance
claims, and a decimal price string for price claims. asset is a coin type such
as "0x2::sui::SUI".`;

export interface ExtractionInput {
  handle: string;
  /** Known address for the source, used to fill params.address when the text omits it. */
  suiAddress?: string;
  /** ISO timestamp the source text was published. Anchors relative deadlines. */
  publishedAt: string;
  text: string;
}

/**
 * Extract candidate claims. Returns [] rather than throwing on unusable output:
 * a bad extraction is a normal outcome, not an exception.
 */
export async function extractClaims(input: ExtractionInput): Promise<ExtractedClaim[]> {
  const user = [
    `source_handle: ${input.handle}`,
    `source_address: ${input.suiAddress ?? "unknown"}`,
    `source_published_at: ${input.publishedAt}`,
    `text:`,
    '"""',
    input.text,
    '"""',
  ].join("\n");

  const { object } = await generateObject({
    model: "anthropic/claude-sonnet-4-5",
    schema,
    system: SYSTEM,
    prompt: user,
  });

  const out: ExtractedClaim[] = [];
  for (const c of object.claims) {
    if (c.confidence < MIN_CONFIDENCE) continue;
    const type = c.claim_type as ClaimType;
    // A claim whose params cannot be validated is worse than no claim: it would
    // resolve to void and clutter the ledger. Drop it here.
    const params = normalizeParams(type, c.params, input);
    if (!params) continue;
    if (!isIso(c.deadline)) continue;
    out.push({
      quote: c.quote.slice(0, 200),
      claimType: type,
      params,
      deadline: new Date(c.deadline).toISOString(),
      confidence: c.confidence,
    });
  }
  return out;
}

/** Below this we do not store the claim at all. */
export const MIN_CONFIDENCE = 0.6;

/**
 * Coerce and validate params per type. Returns null when the claim is not
 * actually checkable — a claim with a malformed address is worse than no
 * claim, because it will resolve to void and clutter the ledger.
 */
function normalizeParams(
  type: ClaimType,
  raw: Record<string, string | number>,
  input: ExtractionInput,
): ClaimParams | null {
  const str = (k: string) => (raw[k] === undefined ? undefined : String(raw[k]).trim());
  const addr = str("address") || input.suiAddress;

  switch (type) {
    case "balance_threshold": {
      if (!isAddress(addr)) return null;
      const amount = str("amount");
      const direction = asDirection(str("direction"));
      if (!amount || !isBaseUnits(amount) || !direction) return null;
      return {
        address: addr,
        asset: str("asset") || "0x2::sui::SUI",
        direction,
        amount,
      };
    }
    case "balance_change_since_ingest": {
      if (!isAddress(addr)) return null;
      const amount = str("amount");
      const direction = asDirection(str("direction"));
      if (!amount || !isBaseUnits(amount) || !direction) return null;
      return {
        address: addr,
        asset: str("asset") || "0x2::sui::SUI",
        direction,
        amount,
      };
    }
    case "tx_replay": {
      if (!isAddress(addr)) return null;
      const amount = str("amount");
      const direction = asDirection(str("direction"));
      const since = str("since");
      const until = str("until");
      if (!amount || !isBaseUnits(amount) || !direction || !isIso(since) || !isIso(until)) {
        return null;
      }
      return {
        address: addr,
        asset: str("asset") || "0x2::sui::SUI",
        since,
        until,
        direction,
        amount,
      };
    }
    case "price_threshold": {
      const symbol = str("symbol");
      const amount = str("amount");
      const direction = asDirection(str("direction"));
      if (!symbol || !amount || Number.isNaN(Number(amount)) || !direction) return null;
      return {
        symbol: symbol.toUpperCase(),
        quote: (str("quote") || "USD").toUpperCase(),
        direction,
        amount,
      };
    }
    case "manual":
      return { note: str("note") || "no detail provided" };
    default:
      return null;
  }
}

function isAddress(a: string | undefined): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(a);
}

/** Base units are integers; a decimal here means the model confused units. */
function isBaseUnits(a: string): boolean {
  return /^\d+$/.test(a);
}

function isIso(s: string | undefined): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function asDirection(s: string | undefined): "gte" | "lte" | undefined {
  if (s === "gte" || s === "lte") return s;
  if (s === ">=") return "gte";
  if (s === "<=") return "lte";
  return undefined;
}
