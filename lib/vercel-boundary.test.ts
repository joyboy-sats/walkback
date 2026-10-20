import { describe, expect, it } from "vitest";
import { findBoundaryViolations, scanApp } from "./vercel-boundary";

function load(files: Record<string, string>) {
  return (absPath: string) => {
    const rel = absPath.replace(/\\/g, "/").replace(/^\/repo\//, "");
    return files[rel] ?? null;
  };
}

describe("vercel boundary", () => {
  it("flags a page that reaches lib/db through another module", () => {
    const files = {
      "app/page.tsx": `import { readFeed } from "@/lib/reads";\n`,
      "lib/reads.ts": `import { getDb } from "./db";\n`,
      "lib/db/index.ts": `export function getDb() {}\n`,
    };
    const hits = findBoundaryViolations("/repo", ["app/page.tsx"], load(files));
    expect(hits.join("\n")).toContain("lib/db/index.ts");
  });

  it("flags lib/env and a non-public process.env read", () => {
    const envHit = findBoundaryViolations(
      "/repo",
      ["app/secret.tsx"],
      load({
        "app/secret.tsx": `import { env } from "@/lib/env";\n`,
        "lib/env.ts": `export function env() {}\n`,
      }),
    );
    expect(envHit.join("\n")).toContain("lib/env.ts");

    const processHit = findBoundaryViolations(
      "/repo",
      ["app/page.tsx"],
      load({ "app/page.tsx": `const url = process.env.DATABASE_URL;\n` }),
    );
    expect(processHit.join("\n")).toContain("DATABASE_URL");
  });

  it("allows a public fetch helper and a pure score import", () => {
    const files = {
      "app/page.tsx": `import { apiGet } from "@/lib/public-api";\nimport { trustBand } from "@/lib/score";\n`,
      "lib/public-api.ts": `export const base = process.env.NEXT_PUBLIC_API_URL;\n`,
      "lib/score.ts": `export function trustBand() { return "normal"; }\n`,
    };
    expect(findBoundaryViolations("/repo", ["app/page.tsx"], load(files))).toEqual([]);
  });

  it("the app directory stays on the public side of the boundary", () => {
    expect(scanApp(process.cwd())).toEqual([]);
  });
});
