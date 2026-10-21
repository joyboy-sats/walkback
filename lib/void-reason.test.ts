import { describe, expect, it } from "vitest";
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
});
