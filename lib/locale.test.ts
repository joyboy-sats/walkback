import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage } from "./locale";

describe("localeFromAcceptLanguage", () => {
  it("defaults to English", () => {
    expect(localeFromAcceptLanguage(null)).toBe("en");
    expect(localeFromAcceptLanguage("")).toBe("en");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("zh-CN,zh;q=0.9")).toBe("en");
  });

  it("picks Traditional Chinese from Taiwan and Hong Kong tags", () => {
    expect(localeFromAcceptLanguage("zh-TW,zh;q=0.9,en;q=0.8")).toBe("zh-Hant");
    expect(localeFromAcceptLanguage("zh-HK")).toBe("zh-Hant");
    expect(localeFromAcceptLanguage("zh-Hant")).toBe("zh-Hant");
    expect(localeFromAcceptLanguage("en;q=0.4,zh-TW;q=0.9")).toBe("zh-Hant");
  });
});
