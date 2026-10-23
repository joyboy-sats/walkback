import { describe, expect, it } from "vitest";
import { resolutionMemory } from "./memory-text";
import { computeScore } from "./score";
import {
  formatRelayerListLines,
  formatResolveLine,
  parseStoredResolution,
  selectStoredResolution,
  selectStoredResolutionForBlob,
} from "./stored-resolution";

const claimId = "b3cfb240-691d-826f-72e1-1695f7e46335";

/** The body production wrote: a wall-clock date and the score snapshot of that moment. */
function legacyResolution(outcome: "false" | "void", id = claimId): string {
  return (
    `[RESOLUTION] mrcamerontrader claimed "SUI above 1.29" (price_threshold, resolved 2026-10-23). ` +
    `VERDICT: ${outcome.toUpperCase()}. window high 1.07 never reached 1.29 Trust moved.\n\n` +
    "```json\n" +
    JSON.stringify(
      {
        kind: "resolution",
        claim_id: id,
        outcome,
        reason: "window high 1.07 never reached 1.29",
        hits: 2,
        misses: outcome === "false" ? 1 : 0,
        score_before: 0.34,
        score_after: 0.2,
        evidence: { windowHigh: "1.07" },
        resolved_at: "2026-10-23T12:00:00.000Z",
      },
      null,
      2,
    ) +
    "\n```"
  );
}

describe("stored resolution", () => {
  it("reads the legacy body, including its date and score, and ignores a different claim", () => {
    const legacy = legacyResolution("false");
    const canonical = resolutionMemory(
      {
        claimId,
        sourceHandle: "mrcamerontrader",
        claimType: "price_threshold",
        quote: "SUI above 1.29",
        outcome: "false",
        reason: "window high 1.07 never reached 1.29",
        evidence: { windowHigh: "1.07" },
      },
      { before: computeScore(2, 0), after: computeScore(2, 1) },
    );
    expect(canonical.text).not.toBe(legacy);

    const parsed = selectStoredResolution(claimId, [
      { blobId: "blob-other", text: legacyResolution("void", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") },
      { blobId: "blob-old", text: legacy, createdAt: "2026-10-23T12:00:01.000Z" },
    ]);
    expect(parsed?.blobId).toBe("blob-old");
    expect(parsed?.outcome).toBe("false");
    expect(parsed?.reason).toContain("1.07");
    expect(parsed?.resolvedAt).toBe("2026-10-23T12:00:00.000Z");
    expect(parseStoredResolution({ blobId: "blob-old", text: "no json here" })).toBeNull();
  });

  it("adopts only the blob the memory log already recorded", () => {
    const hits = [
      { blobId: "blob-other", text: legacyResolution("void") },
      { blobId: "blob-logged", text: legacyResolution("false") },
    ];
    expect(selectStoredResolutionForBlob(claimId, "blob-logged", hits)?.outcome).toBe("false");
    expect(selectStoredResolutionForBlob(claimId, "blob-missing", hits)).toBeNull();
  });

  it("prints the handle, the verdict, and the reason on one line", () => {
    const line = formatResolveLine({
      handle: "mrcamerontrader",
      claimId,
      externalId: "post:x-mrcamerontrader-2107077951863099625:0",
      outcome: "false",
      reason: "window high 1.07 never reached 1.29",
      skipped: "adopted stored resolution",
    });
    expect(line).toContain("mrcamerontrader");
    expect(line).toContain(claimId);
    expect(line).toContain("post:x-mrcamerontrader-2107077951863099625:0");
    expect(line).toContain("false");
    expect(line).toContain("window high 1.07 never reached 1.29");
    expect(line).toContain("adopted stored resolution");
  });

  it("says the relayer list is not the homepage logged count", () => {
    const lines = formatRelayerListLines(58);
    expect(lines[0]).toBe("relayer live 58");
    expect(lines.join("\n")).toMatch(/relayer list/i);
    expect(lines.join("\n")).toMatch(/logged/);
    expect(lines.join("\n")).toMatch(/different set/);
    expect(lines.join("\n")).toMatch(/walkback\.smoke/);
    expect(lines.join("\n")).toMatch(/walkback\.timing/);
  });

  it("splits script probes out of the live total", () => {
    const lines = formatRelayerListLines(108, {
      "walkback.claim": 33,
      "walkback.resolution": 29,
      "walkback.score": 26,
      "walkback.source": 10,
      "walkback.smoke": 1,
      "walkback.timing": 9,
    });
    expect(lines[0]).toBe("relayer live 108");
    expect(lines.join("\n")).toContain("walkback.smoke 1");
    expect(lines.join("\n")).toContain("walkback.timing 9");
    expect(lines.join("\n")).toContain("product namespaces in this list: 98");
    expect(lines.join("\n")).toMatch(/not in memory_log/);
  });
});
