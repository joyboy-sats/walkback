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
        confidence: 0.9,
      },
    ]);
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
