import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh-Hant.json";

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function strings(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("message catalogs", () => {
  it("English and Traditional Chinese have the same keys", () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });

  it("every message is valid ICU in both locales", () => {
    for (const [locale, catalog] of [
      ["en", en],
      ["zh-Hant", zh],
    ] as const) {
      for (const [key, message] of strings(catalog)) {
        expect(() => new IntlMessageFormat(message, locale), `${locale} ${key}`).not.toThrow();
      }
    }
  });
});
