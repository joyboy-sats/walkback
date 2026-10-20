/**
 * Claims that must not move a trust score.
 *
 * A synthetic row is a demo placeholder. A repeated-nibble address such as
 * 0x1111… is a fake address that Tatum still answers, with balance 0, which
 * would otherwise become a `false` and a miss. Both resolve to `void`.
 * `void` leaves hits and misses where they were.
 */

export function isPlaceholderAddress(address: string): boolean {
  const match = /^0x([0-9a-fA-F]+)$/.exec(address.trim());
  const hex = match?.[1];
  if (!hex || hex.length < 8) return false;
  const first = hex[0]!.toLowerCase();
  for (const ch of hex) {
    if (ch.toLowerCase() !== first) return false;
  }
  return true;
}

export function addressInParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const address = (params as { address?: unknown }).address;
  return typeof address === "string" ? address : null;
}

export interface ExclusionVerdict {
  outcome: "void";
  reason: string;
  evidence: Record<string, unknown>;
}

/**
 * A verdict that replaces adjudication. Null means the claim is eligible to
 * be checked and, if it is true or false, to move the score.
 */
export function exclusionVerdict(input: {
  synthetic: boolean;
  params: unknown;
}): ExclusionVerdict | null {
  if (input.synthetic) {
    return {
      outcome: "void",
      reason: "Synthetic claim is excluded from the trust score.",
      evidence: { synthetic: true, excluded: true },
    };
  }
  const address = addressInParams(input.params);
  if (address && isPlaceholderAddress(address)) {
    return {
      outcome: "void",
      reason:
        `Address ${address} is a placeholder, so the claim was not checked ` +
        "and does not affect the trust score.",
      evidence: { placeholder: true, address, excluded: true },
    };
  }
  return null;
}
