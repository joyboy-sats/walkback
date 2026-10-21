import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { feedResolution, latestResolution } from "./reads";

describe("feed resolutions", () => {
  it("rewrites the empty-effect provider error into a sentence", () => {
    const shown = feedResolution({
      outcome: "void",
      reason:
        'Check failed: ErrorObject { code: InvalidParams, message: "unable to derive balance/object changes because effect is empty", data: None }',
    });
    expect(shown.outcome).toBe("void");
    expect(shown.reason.toLowerCase()).toContain("no effects");
    expect(shown.reason).not.toContain("ErrorObject");
  });

  it("keeps the newest resolution when a claim was re-checked", () => {
    const latest = latestResolution([
      {
        claimId: "00000000-0000-4000-8000-000000000001",
        resolvedAt: new Date("2026-10-20T08:00:00.000Z"),
        outcome: "void" as const,
      },
      {
        claimId: "00000000-0000-4000-8000-000000000001",
        resolvedAt: new Date("2026-10-21T16:00:00.000Z"),
        outcome: "true" as const,
      },
    ]);
    expect(latest.get("00000000-0000-4000-8000-000000000001")?.outcome).toBe("true");
  });
});
