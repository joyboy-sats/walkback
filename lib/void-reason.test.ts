import { describe, expect, it } from "vitest";
import { explainVoidReason } from "./verdict-reason";
import { matchVoidReason } from "./void-reason";

describe("matchVoidReason", () => {
  it("recognises the stored void sentences", () => {
    expect(matchVoidReason("Manual claim; no automated check applies.")).toEqual({ key: "manual" });
    expect(matchVoidReason("Synthetic claim is excluded from the trust score.")).toEqual({
      key: "synthetic",
    });
    expect(
      matchVoidReason("Deadline (2026-11-01T00:00:00.000Z) has not passed; nothing to check yet."),
    ).toEqual({ key: "deadline", deadline: "2026-11-01T00:00:00.000Z" });
    expect(
      matchVoidReason(
        "Address 0x1111…1111 is a placeholder, so the claim was not checked and does not affect the trust score.",
      ),
    ).toEqual({ key: "placeholder", address: "0x1111…1111" });
    expect(matchVoidReason("Check failed: rate unavailable")).toEqual({
      key: "checkFailed",
      message: "rate unavailable",
    });
  });

  it("leaves a true/false narrative untouched", () => {
    expect(matchVoidReason("0xabc held 12 SUI at resolution, at least the 10 SUI claimed.")).toBeNull();
  });

  it("leaves newer resolution sentences as stored text", () => {
    const emptyEffect = explainVoidReason(
      'Check failed: ErrorObject { message: "unable to derive balance/object changes because effect is empty" }',
    );
    const reasons = [
      emptyEffect,
      "Could not read balance changes for ABC inside the window, so the total is unknown.",
      'The price threshold "nope" is not a number, so the claim was not checked.',
      "Tatum historical prices are published in USD, so SUI/EUR was not checked.",
      "The price window is empty, so the claim was not checked.",
      "The rate feed does not cover SUI/USD; the claim was not checked.",
      "From 2026-10-01T00:00:00.000Z to 2026-11-01T00:00:00.000Z, Tatum SUI/USD 1h high was 1.2 in the candle opening 2026-10-02T00:00:00.000Z, gte the 4 claimed.",
    ];
    for (const reason of reasons) {
      expect(matchVoidReason(reason)).toBeNull();
    }
    expect(emptyEffect).not.toContain("ErrorObject");
  });
});
