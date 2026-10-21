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

import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import { z } from "zod";
import { priceParamsFromRaw } from "./price-candle";
import type { ClaimParams, ClaimType, ExtractedClaim } from "./types";

/**
 * Gateway id whose listed name is "DeepSeek V4.1 Flash"
 * (GET https://ai-gateway.vercel.sh/v1/models). Not a secret.
 * Dated snapshots (`-1017`) and the `-fast` tier are different models.
 */
export const DEFAULT_EXTRACT_MODEL = "deepseek/deepseek-v4.1-flash";

/** Blank or missing `EXTRACT_MODEL` keeps the DeepSeek V4.1 Flash default. */
export function extractModelId(env: Record<string, string | undefined> = process.env): LanguageModel {
  const configured = env.EXTRACT_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_EXTRACT_MODEL;
}

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
        deadline_basis: z
          .string()
          .max(160)
          .optional()
          .describe('Why the deadline is that timestamp. "stated in post" when the text gives the time.'),
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
  price_threshold              "SUI hits $3 by Friday" (touch) or "SUI will be above $3 on Friday" (at the deadline)
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
  price_threshold              {symbol, quote, direction, amount, evaluation}
  manual                       {note}
amount is always a decimal string in base units (mist for SUI) for balance
claims, and a decimal price string for price claims. asset is a coin type such
as "0x2::sui::SUI".

price_threshold.evaluation is "touch" or "at_deadline".
  touch         the level is hit at any time from publish until the deadline.
                Upside or bullish wording (hits, reaches, target, take-profit)
                is direction gte and is checked against the window high.
                Downside or bearish wording (retest, drops to, stop) is
                direction lte and is checked against the window low.
                "by Friday" is touch.
  at_deadline   the price is above or below the level at the deadline itself.
                "on Friday" is at_deadline. direction gte means that print is
                at least amount; direction lte means it is at most amount.
symbol is the base asset, such as SUI, SOL, ETH, or BTC. quote is USD.
Do not send since. Do not invent a deadline. If the text does not resolve
to a time, drop the claim.

deadline_basis is a short phrase naming why deadline is that timestamp.
Use "stated in post" when the text gives the time.`;

type ClaimDraft = z.infer<typeof schema>["claims"][number];

/**
 * Pull a JSON object out of a model reply that wrapped it in prose or a
 * fence, then keep it only when it satisfies the same zod schema
 * `generateObject` uses. Returns null when nothing in the text is usable.
 */
export function repairClaimsJson(text: string): string | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    if (candidate === trimmed) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return JSON.stringify(parsed.data);
    } catch {
      // The next span may be the object.
    }
  }
  return null;
}

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

  // V4 Flash thinks by default, and thinking tokens are billed as output.
  // Extraction is a schema fill, so thinking stays off. That also lets
  // temperature apply. `sort: "cost"` prefers the cheap provider: the model
  // list marks the price as varying, and the US regional price is higher.
  let claims: ClaimDraft[];
  try {
    const { object } = await generateObject({
      model: extractModelId(),
      schema,
      schemaName: "ExtractedClaims",
      schemaDescription: "Machine-checkable claims from one post. An empty claims array is valid.",
      system: SYSTEM,
      prompt: user,
      temperature: 0,
      experimental_repairText: async ({ text }) => repairClaimsJson(text),
      providerOptions: {
        gateway: { sort: "cost" },
        deepseek: { thinking: { type: "disabled" } },
      },
    });
    claims = object.claims;
  } catch (err) {
    // The model answered, but the text still is not the schema. That is an
    // empty extraction, not a job failure. Auth and network errors rethrow.
    if (NoObjectGeneratedError.isInstance(err)) return [];
    throw err;
  }

  const out: ExtractedClaim[] = [];
  for (const c of claims) {
    if (c.confidence < MIN_CONFIDENCE) continue;
    const type = c.claim_type as ClaimType;
    // A claim whose params cannot be validated is worse than no claim: it would
    // resolve to void and clutter the ledger. Drop it here.
    const params = normalizeParams(type, c.params, input);
    if (!params) continue;
    if (!isIso(c.deadline)) continue;
    const deadlineBasis = (c.deadline_basis?.trim() || "stated in post").slice(0, 160);
    out.push({
      quote: c.quote.slice(0, 200),
      claimType: type,
      params,
      deadline: new Date(c.deadline).toISOString(),
      deadlineBasis,
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
      const direction = asDirection(str("direction"));
      const params = priceParamsFromRaw({
        symbol: str("symbol"),
        quote: str("quote"),
        ...(direction ? { direction } : {}),
        amount: str("amount"),
        evaluation: str("evaluation"),
        since: str("since"),
        publishedAt: input.publishedAt,
      });
      if (!params) return null;
      // New extractions store the mode explicitly. Rows that predate the
      // field still omit it and are read as at_deadline.
      if (!params.evaluation) return { ...params, evaluation: "at_deadline" };
      return params;
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
