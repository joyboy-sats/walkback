import { describe, expect, it } from "vitest";
import { formatLocalDateTime, parseLocalDateTime, pushTimeDigit } from "./local-datetime";

describe("local datetime values", () => {
  it("round-trips the string the ingest form posts", () => {
    const value = "2026-10-21T14:30";
    const date = parseLocalDateTime(value);
    expect(date).not.toBeNull();
    expect(formatLocalDateTime(date!)).toBe(value);
  });

  it("matches new Date() local-time parsing used at submit", () => {
    const value = "2026-10-21T14:30";
    const viaPicker = parseLocalDateTime(value)!;
    const viaSubmit = new Date(value);
    expect(viaSubmit.getFullYear()).toBe(viaPicker.getFullYear());
    expect(viaSubmit.getMonth()).toBe(viaPicker.getMonth());
    expect(viaSubmit.getDate()).toBe(viaPicker.getDate());
    expect(viaSubmit.getHours()).toBe(14);
    expect(viaSubmit.getMinutes()).toBe(30);
    expect(viaSubmit.toISOString()).toBe(viaPicker.toISOString());
  });

  it("builds an hour from keystrokes without inserting into the padded pair", () => {
    expect(pushTimeDigit("00", "1", 23)).toBe("1");
    expect(pushTimeDigit("1", "4", 23)).toBe("14");
    expect(pushTimeDigit("14", "0", 23)).toBe("0");
    expect(pushTimeDigit("0", "9", 23)).toBe("09");
    expect(pushTimeDigit("2", "9", 23)).toBeNull();
    expect(pushTimeDigit("00", "3", 59)).toBe("3");
    expect(pushTimeDigit("3", "0", 59)).toBe("30");
  });

  it("rejects a partial or offset value", () => {
    expect(parseLocalDateTime("")).toBeNull();
    expect(parseLocalDateTime("2026-10-21")).toBeNull();
    expect(parseLocalDateTime("2026-10-21T14:30:00Z")).toBeNull();
    expect(parseLocalDateTime("2026-02-31T00:00")).toBeNull();
  });
});
