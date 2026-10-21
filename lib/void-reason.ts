/**
 * Known void sentences written by adjudication.
 *
 * The stored reason is English. The UI rewrites the ones it recognises.
 * Anything else — including true/false narratives and provider errors
 * pasted after "Check failed:" — stays as stored text.
 */

export type VoidReason =
  | { key: "deadline"; deadline: string }
  | { key: "placeholder"; address: string }
  | { key: "manual" }
  | { key: "unknownType"; type: string }
  | { key: "checkFailed"; message: string }
  | { key: "noSnapshot" }
  | { key: "replayTruncated"; address: string; blocks: string }
  | { key: "rateUnsupported"; pair: string }
  | { key: "synthetic" };

const EXACT: Record<string, VoidReason> = {
  "Manual claim; no automated check applies.": { key: "manual" },
  "No snapshot was taken when this claim was ingested, so the change cannot be measured. A claim without a receipt is not a claim.":
    { key: "noSnapshot" },
  "Synthetic claim is excluded from the trust score.": { key: "synthetic" },
};

export function voidReasonValues(match: VoidReason): Record<string, string | number> {
  switch (match.key) {
    case "deadline":
      return { deadline: match.deadline };
    case "placeholder":
      return { address: match.address };
    case "unknownType":
      return { type: match.type };
    case "checkFailed":
      return { message: match.message };
    case "replayTruncated":
      return { address: match.address, blocks: Number(match.blocks) };
    case "rateUnsupported":
      return { pair: match.pair };
    default:
      return {};
  }
}

export function matchVoidReason(reason: string): VoidReason | null {
  const exact = EXACT[reason];
  if (exact) return exact;

  const deadline = /^Deadline \((.+)\) has not passed; nothing to check yet\.$/.exec(reason);
  if (deadline?.[1]) return { key: "deadline", deadline: deadline[1] };

  const placeholder =
    /^Address (.+) is a placeholder, so the claim was not checked and does not affect the trust score\.$/.exec(
      reason,
    );
  if (placeholder?.[1]) return { key: "placeholder", address: placeholder[1] };

  const unknown = /^Unknown claim type: (.+)$/.exec(reason);
  if (unknown?.[1]) return { key: "unknownType", type: unknown[1] };

  const failed = /^Check failed: ([\s\S]+)$/.exec(reason);
  if (failed?.[1]) return { key: "checkFailed", message: failed[1] };

  const replay =
    /^Transaction history for (.+) exceeded the replay window \((\d+) blocks read\); the total is unknown, so no verdict\.$/.exec(
      reason,
    );
  if (replay?.[1] && replay[2]) return { key: "replayTruncated", address: replay[1], blocks: replay[2] };

  const rate = /^The rate feed does not cover ([^;]+); the claim type is disabled\.$/.exec(reason);
  if (rate?.[1]) return { key: "rateUnsupported", pair: rate[1] };

  return null;
}
