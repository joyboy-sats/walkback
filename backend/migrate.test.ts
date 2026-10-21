import { describe, expect, it } from "vitest";
import { migrationAppliedLine } from "./migrate";

describe("migration success line", () => {
  it("includes the duration so a Coolify log shows the boot finished", () => {
    expect(migrationAppliedLine(42)).toBe("[migrate] applied migrations in 42ms");
    expect(migrationAppliedLine(41.6)).toBe("[migrate] applied migrations in 42ms");
    expect(migrationAppliedLine(0)).toBe("[migrate] applied migrations in 0ms");
    expect(migrationAppliedLine(Number.NaN)).toBe("[migrate] applied migrations in 0ms");
  });
});
