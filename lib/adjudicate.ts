/**
 * Adjudication: turn a claim into a verdict.
 *
 * Contract every resolver must honour:
 *
 *   1. Evidence is the normalized provider payload, stored raw. The evidence
 *      panel and the blog post both read it; a reason string alone is not
 *      enough to defend a verdict.
 *   2. `reason` is one plain-English sentence, safe to paste into a memory.
 *      Bad:  "balance check returned false"
 *      Good: "0xab..12 held 12,400 SUI on 2026-10-31, below the 50,000 claimed."
 *   3. Failure to check is `void`, never `false`. A `void` never moves a score.
 *      The UI must say "could not check", never "lied".
 *   4. Resolvers never throw. A thrown error becomes a `void` with the error
 *      as its reason, so one dead endpoint cannot fail a whole batch.
 */
import { fmtPrice } from "./price-candle";
import { loadDeadlinePrice, loadTouchWindow, type PriceHistorySource } from "./price-history";
import {
  getBalance,
  getOhlcvAt,
  getOhlcvPage,
  netChangeInWindow,
  TatumError,
} from "./tatum";
import { isPlaceholderAddress } from "./scoring-exclusion";
import { explainVoidReason } from "./verdict-reason";
import type {
  BalanceChangeParams,
  BalanceSnapshot,
  BalanceThresholdParams,
  ClaimParams,
  ClaimType,
  ManualParams,
  PriceThresholdParams,
  TxReplayParams,
  Verdict,
} from "./types";

const SUI_COIN_TYPE = "0x2::sui::SUI";

export interface AdjudicationInput {
  claimType: ClaimType;
  params: ClaimParams;
  snapshot: BalanceSnapshot | null;
  deadline: string;
  /**
   * Why the deadline is that timestamp. Copied into price evidence.
   * Not used to compute the deadline.
   */
  deadlineBasis?: string | null;
}

/** Format base units as a readable amount for reason strings. */
function fmt(baseUnits: string, decimals = 9): string {
  const n = BigInt(baseUnits);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const div = 10n ** BigInt(decimals);
  const whole = abs / div;
  const frac = (abs % div).toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = neg ? "-" : "";
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}

function held(value: string, direction: "gte" | "lte", threshold: string): boolean {
  const v = BigInt(value);
  const t = BigInt(threshold);
  return direction === "gte" ? v >= t : v <= t;
}

function satisfied(actual: bigint, direction: "gte" | "lte", target: bigint): boolean {
  return direction === "gte" ? actual >= target : actual <= target;
}

const OP = { gte: "at least", lte: "at most" } as const;

/**
 * Adjudicate one claim. Never throws.
 *
 * `now` is injectable so tests can pin the clock.
 */
export async function adjudicate(
  input: AdjudicationInput,
  now: Date = new Date(),
): Promise<Verdict> {
  const deadline = new Date(input.deadline);

  // A claim resolved before its deadline is a guess about the world, not a
  // check of it. Callers normally only resolve matured claims; this guard
  // exists because the "Resolve now" button is available to the user.
  if (deadline > now) {
    return {
      outcome: "void",
      reason: `Deadline (${input.deadline}) has not passed; nothing to check yet.`,
      evidence: { deadlinePassed: false, asOf: now.toISOString() },
    };
  }

  const address = addressOf(input.params);
  if (address && isPlaceholderAddress(address)) {
    return voidVerdict(
      `Address ${short(address)} is a placeholder, so the claim was not checked and does not affect the trust score.`,
      { placeholder: true, address },
    );
  }

  try {
    switch (input.claimType) {
      case "balance_threshold":
        return await resolveBalanceThreshold(input.params as BalanceThresholdParams);
      case "balance_change_since_ingest":
        return await resolveBalanceChange(
          input.params as BalanceChangeParams,
          input.snapshot,
        );
      case "tx_replay":
        return await resolveTxReplay(input.params as TxReplayParams);
      case "price_threshold":
        return await resolvePriceThreshold(
          input.params as PriceThresholdParams,
          input.deadline,
          input.deadlineBasis,
        );
      case "manual":
        return voidVerdict(
          "Manual claim; no automated check applies.",
          { manualNote: (input.params as ManualParams).note },
        );
      default:
        return voidVerdict(`Unknown claim type: ${String(input.claimType)}`, {});
    }
  } catch (err) {
    // Rule 4: a dead provider is a void, not a lie.
    const message = err instanceof TatumError ? err.message : String(err);
    return voidVerdict(explainVoidReason(`Check failed: ${message}`), {
      error: message,
      claimType: input.claimType,
    });
  }
}

function voidVerdict(reason: string, evidence: unknown): Verdict {
  return { outcome: "void", reason, evidence };
}

async function resolveBalanceThreshold(p: BalanceThresholdParams): Promise<Verdict> {
  const asset = p.asset || SUI_COIN_TYPE;
  const bal = await getBalance(p.address, asset);
  const ok = held(bal.balance, p.direction, p.amount);

  return {
    outcome: ok ? "true" : "false",
    reason:
      `${short(p.address)} held ${fmt(bal.balance)} ${ticker(asset)} at resolution, ` +
      `${ok ? "" : "not "}${OP[p.direction]} the ${fmt(p.amount)} ${ticker(asset)} claimed.`,
    evidence: { balance: bal, threshold: p.amount, direction: p.direction, asset },
  };
}

async function resolveBalanceChange(
  p: BalanceChangeParams,
  snapshot: BalanceSnapshot | null,
): Promise<Verdict> {
  // The product rule: a claim without a receipt is not a claim. We froze the
  // world at ingest precisely because history cannot be re-queried.
  if (!snapshot) {
    return voidVerdict(
      "No snapshot was taken when this claim was ingested, so the change cannot " +
        "be measured. A claim without a receipt is not a claim.",
      { snapshotMissing: true },
    );
  }

  const asset = p.asset || SUI_COIN_TYPE;
  const now = await getBalance(p.address, asset);
  const delta = BigInt(now.balance) - BigInt(snapshot.balance);
  const magnitude = delta < 0n ? -delta : delta;
  const ok = satisfied(magnitude, p.direction, BigInt(p.amount));

  return {
    outcome: ok ? "true" : "false",
    reason:
      `${short(p.address)} moved from ${fmt(snapshot.balance)} to ${fmt(now.balance)} ` +
      `${ticker(asset)} since ingest (${delta >= 0n ? "+" : "-"}${fmt(magnitude.toString())}), ` +
      `${ok ? "" : "not "}${OP[p.direction]} the ${fmt(p.amount)} claimed.`,
    evidence: {
      snapshot,
      current: now,
      delta: delta.toString(),
      direction: p.direction,
      amount: p.amount,
    },
  };
}

async function resolveTxReplay(p: TxReplayParams): Promise<Verdict> {
  const asset = p.asset || SUI_COIN_TYPE;
  const replay = await netChangeInWindow(p.address, asset, p.since, p.until);
  const { net, sampledBlocks, truncated } = replay;
  const unreadableDigests = replay.unreadableDigests ?? [];
  const evidence = {
    net,
    sampledBlocks,
    truncated,
    since: p.since,
    until: p.until,
    droppedPhantoms: replay.droppedPhantoms ?? 0,
    unreadableDigests,
    digests: replay.digests ?? [],
  };

  // A truncated replay gives a floor, not a total. Reporting a verdict from it
  // would be manufacturing evidence.
  if (truncated) {
    return voidVerdict(
      `Transaction history for ${short(p.address)} exceeded the replay window ` +
        `(${sampledBlocks} blocks read); the total is unknown, so no verdict.`,
      evidence,
    );
  }

  if (unreadableDigests.length > 0) {
    const shown = unreadableDigests.slice(0, 3).join(", ");
    return voidVerdict(
      `Could not read balance changes for ${shown} inside the window, so the total is unknown.`,
      evidence,
    );
  }

  const netBig = BigInt(net);
  const magnitude = netBig < 0n ? -netBig : netBig;
  const ok = satisfied(magnitude, p.direction, BigInt(p.amount));

  return {
    outcome: ok ? "true" : "false",
    reason:
      `Replaying ${sampledBlocks} blocks from ${p.since.slice(0, 10)} to ` +
      `${p.until.slice(0, 10)}, ${short(p.address)} netted ` +
      `${netBig >= 0n ? "+" : "-"}${fmt(magnitude.toString())} ${ticker(asset)}; ` +
      `${ok ? "" : "not "}${OP[p.direction]} the ${fmt(p.amount)} claimed.`,
    evidence,
  };
}

const priceSource: PriceHistorySource = {
  page: (query) => getOhlcvPage(query.symbol, query.from, query.interval, query.limit),
  at: (query) => getOhlcvAt(query.symbol, query.at, query.interval),
};

/**
 * A past deadline is checkable. The candle is selected by the deadline and
 * the publish time, not by when the worker runs. A future deadline still
 * voids above, before this function is called.
 */
async function resolvePriceThreshold(
  p: PriceThresholdParams,
  deadline: string,
  deadlineBasis?: string | null,
): Promise<Verdict> {
  const symbol = p.symbol.toUpperCase();
  const quote = (p.quote || "USD").toUpperCase();
  const evaluation = p.evaluation === "touch" || p.evaluation === "at_deadline" ? p.evaluation : "at_deadline";
  const evaluationDefaulted = p.evaluation !== "touch" && p.evaluation !== "at_deadline";
  const threshold = Number(p.amount);
  const basis = deadlineBasis?.trim() ? { deadlineBasis: deadlineBasis.trim() } : {};
  const common = {
    symbol,
    quote,
    evaluation,
    ...(evaluationDefaulted ? { evaluationDefaulted: true } : {}),
    direction: p.direction,
    threshold: p.amount,
    deadline,
    ...basis,
  };

  if (!Number.isFinite(threshold)) {
    return voidVerdict(
      `The price threshold "${p.amount}" is not a number, so the claim was not checked.`,
      common,
    );
  }
  if (quote !== "USD") {
    return voidVerdict(
      `Tatum historical prices are published in USD, so ${symbol}/${quote} was not checked.`,
      common,
    );
  }

  if (evaluation === "touch") {
    if (!p.since || Number.isNaN(Date.parse(p.since))) {
      return voidVerdict(
        "This touch claim does not record when it was published, so the window cannot be checked.",
        common,
      );
    }
    const loaded = await loadTouchWindow(priceSource, {
      symbol,
      from: p.since,
      to: deadline,
      direction: p.direction,
    });
    if (!loaded.ok) return voidVerdict(loaded.reason, { ...common, ...loaded.evidence });
    const ok = p.direction === "gte" ? loaded.extreme.value >= threshold : loaded.extreme.value <= threshold;
    const side = p.direction === "gte" ? "high" : "low";
    return {
      outcome: ok ? "true" : "false",
      reason:
        `From ${new Date(p.since).toISOString()} to ${new Date(deadline).toISOString()}, ` +
        `Tatum ${symbol}/${quote} ${loaded.interval} ${side} was ${fmtPrice(loaded.extreme.value)} ` +
        `in the candle opening ${loaded.extreme.at}, ` +
        `${ok ? "" : "not "}${OP[p.direction]} the ${p.amount} claimed.`,
      evidence: {
        ...common,
        source: loaded.source,
        interval: loaded.interval,
        ...(loaded.intervalFallback ? { intervalFallback: loaded.intervalFallback } : {}),
        window: { from: new Date(p.since).toISOString(), to: new Date(deadline).toISOString() },
        extreme: loaded.extreme,
        maxHigh: loaded.maxHigh,
        minLow: loaded.minLow,
        boundary: loaded.boundary,
        candleCount: loaded.candles.length,
        requests: loaded.requests,
      },
    };
  }

  const print = await loadDeadlinePrice(priceSource, { symbol, at: deadline });
  if (!print.ok) return voidVerdict(print.reason, { ...common, ...print.evidence });
  const ok = p.direction === "gte" ? print.value >= threshold : print.value <= threshold;
  const lead = evaluationDefaulted ? "No evaluation was stored, so the deadline price was used; " : "";
  return {
    outcome: ok ? "true" : "false",
    reason:
      `${lead}At ${new Date(deadline).toISOString()}, Tatum ${symbol}/${quote} ${print.interval} ` +
      `${print.field} was ${fmtPrice(print.value)} at ${print.at}, ` +
      `${ok ? "" : "not "}${OP[p.direction]} the ${p.amount} claimed.`,
    evidence: {
      ...common,
      source: print.source,
      interval: print.interval,
      ...(print.intervalFallback ? { intervalFallback: print.intervalFallback } : {}),
      extreme: {
        value: print.value,
        at: print.at,
        field: print.field,
        candleOpen: print.candle.openTime,
        candleClose: print.candle.closeTime,
      },
      deadlinePrice: {
        value: print.value,
        field: print.field,
        at: print.at,
        open: print.candle.open,
        high: print.candle.high,
        low: print.candle.low,
        close: print.candle.close,
        candleOpen: print.candle.openTime,
        candleClose: print.candle.closeTime,
      },
    },
  };
}

function ticker(coinType: string): string {
  if (coinType === SUI_COIN_TYPE) return "SUI";
  const parts = coinType.split("::");
  return parts[parts.length - 1] || coinType.slice(0, 8);
}

function addressOf(params: ClaimParams): string | null {
  if ("address" in params && typeof params.address === "string") return params.address;
  return null;
}
