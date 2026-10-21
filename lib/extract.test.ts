import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const generateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateObject };
});

import { NoObjectGeneratedError } from "ai";
import { DEFAULT_EXTRACT_MODEL, extractClaims, extractModelId, repairClaimsJson } from "./extract";

const input = {
  handle: "alice",
  suiAddress: "0xabc",
  publishedAt: "2026-10-18T15:04:00.000Z",
  text: "I hold at least 50k SUI",
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    quote: "I hold at least 50k SUI",
    claim_type: "balance_threshold",
    params: { address: "0xabc", asset: "0x2::sui::SUI", direction: "gte", amount: "50000000000000" },
    deadline: "2026-10-31T23:59:00.000Z",
    confidence: 0.9,
    ...overrides,
  };
}

describe("extract model", () => {
  it("defaults to the DeepSeek V4.1 Flash gateway id", () => {
    expect(DEFAULT_EXTRACT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(extractModelId({ EXTRACT_MODEL: undefined })).toBe(DEFAULT_EXTRACT_MODEL);
    expect(extractModelId({ EXTRACT_MODEL: "  " })).toBe(DEFAULT_EXTRACT_MODEL);
  });

  it("uses EXTRACT_MODEL when it is set", () => {
    expect(extractModelId({ EXTRACT_MODEL: " deepseek/deepseek-v4-pro " })).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("repairClaimsJson", () => {
  it("accepts a fenced object and a prose-wrapped object", () => {
    const body = JSON.stringify({ claims: [draft()] });
    expect(repairClaimsJson("```json\n" + body + "\n```")).toBe(JSON.stringify({ claims: [draft()] }));
    const salvaged = repairClaimsJson(`Here is the result:\n${body}\nDone.`);
    expect(salvaged).not.toBeNull();
    expect(JSON.parse(salvaged ?? "{}")).toEqual({ claims: [draft()] });
  });

  it("rejects text that is not the claim schema", () => {
    expect(repairClaimsJson("no object here")).toBeNull();
    expect(repairClaimsJson(JSON.stringify({ claims: [{ quote: "x" }] }))).toBeNull();
    expect(repairClaimsJson("{not json")).toBeNull();
  });
});

describe("extractClaims", () => {
  beforeEach(() => {
    generateObject.mockReset();
    delete process.env.EXTRACT_MODEL;
  });

  it("asks the configured model for the zod object and keeps a valid claim", async () => {
    process.env.EXTRACT_MODEL = "deepseek/deepseek-v4.1-flash";
    generateObject.mockResolvedValue({ object: { claims: [draft(), draft({ confidence: 0.2 })] } });

    const claims = await extractClaims(input);

    expect(generateObject).toHaveBeenCalledOnce();
    const args = generateObject.mock.calls[0]?.[0] as {
      model: string;
      temperature: number;
      system: string;
      providerOptions: { gateway: { sort: string }; deepseek: { thinking: { type: string } } };
      experimental_repairText: (options: { text: string }) => Promise<string | null>;
    };
    expect(args.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(args.temperature).toBe(0);
    expect(args.providerOptions.gateway.sort).toBe("cost");
    expect(args.providerOptions.deepseek.thinking).toEqual({ type: "disabled" });
    expect(await args.experimental_repairText({ text: "```json\n" + JSON.stringify({ claims: [] }) + "\n```" })).toBe(
      JSON.stringify({ claims: [] }),
    );
    expect(claims).toEqual([
      {
        quote: "I hold at least 50k SUI",
        claimType: "balance_threshold",
        params: {
          address: "0xabc",
          asset: "0x2::sui::SUI",
          direction: "gte",
          amount: "50000000000000",
        },
        deadline: "2026-10-31T23:59:00.000Z",
        deadlineBasis: "stated in post",
        confidence: 0.9,
      },
    ]);
    expect(args.system).toContain("touch");
    expect(args.system).toContain("at_deadline");
    expect(args.system).toContain("stated in post");
    expect(args.system).not.toContain("7-day");
    expect(args.system).not.toContain("14-day");
  });

  it("records a touch from the publish time and defaults a missing mode to the deadline", async () => {
    generateObject.mockResolvedValue({
      object: {
        claims: [
          draft({
            quote: "SUI hits $3 by Friday",
            claim_type: "price_threshold",
            params: { symbol: "sui", quote: "usd", direction: "gte", amount: "3", evaluation: "touch", since: "1999-01-01T00:00:00.000Z" },
            deadline_basis: "stated in post",
          }),
          draft({
            quote: "ETH will be above $2 on Friday",
            claim_type: "price_threshold",
            params: { symbol: "eth", direction: "gte", amount: "2" },
          }),
        ],
      },
    });

    const claims = await extractClaims(input);
    expect(claims.map((claim) => claim.params)).toEqual([
      {
        symbol: "SUI",
        quote: "USD",
        direction: "gte",
        amount: "3",
        evaluation: "touch",
        since: input.publishedAt,
      },
      {
        symbol: "ETH",
        quote: "USD",
        direction: "gte",
        amount: "2",
        evaluation: "at_deadline",
      },
    ]);
    expect(claims.every((claim) => claim.deadlineBasis === "stated in post")).toBe(true);
  });

  it("returns [] when the model text cannot be validated", async () => {
    generateObject.mockRejectedValue(
      new NoObjectGeneratedError({
        message: "No object generated: response did not match schema.",
        text: "I could not find a claim.",
        response: { id: "r", timestamp: new Date(), modelId: DEFAULT_EXTRACT_MODEL },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: "stop",
      }),
    );
    await expect(extractClaims(input)).resolves.toEqual([]);
  });

  it("rethrows gateway failures", async () => {
    generateObject.mockRejectedValue(new Error("AI_GATEWAY_API_KEY missing"));
    await expect(extractClaims(input)).rejects.toThrow("AI_GATEWAY_API_KEY missing");
  });
});
