/**
 * Fails when the Vercel app can see Postgres or a server secret.
 *
 * `app/` may import pure helpers and `lib/public-api.ts`. It may not import
 * `lib/db`, `lib/env`, or any file that reaches them. The only `process.env`
 * names on that graph are `NEXT_PUBLIC_*`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

const IMPORT_FROM = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_BARE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_DYNAMIC = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const ENV_READ = /process\.env(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;

export function isForbiddenModule(relPath: string): boolean {
  const norm = relPath.split(sep).join("/");
  return norm === "lib/env.ts" || norm.startsWith("lib/db/");
}

export function envNameViolations(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(ENV_READ)) {
    const name = match[1] || match[2] || "";
    if (name && !name.startsWith("NEXT_PUBLIC_")) names.push(name);
  }
  return names;
}

export function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [IMPORT_FROM, IMPORT_BARE, IMPORT_DYNAMIC]) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (spec) specs.add(spec);
    }
  }
  return [...specs];
}

export function resolveSpecifier(
  fromFile: string,
  spec: string,
  root: string,
  exists: (absPath: string) => boolean,
): string | null {
  if (spec.endsWith(".css") || spec.endsWith(".json")) return null;
  let target: string;
  if (spec.startsWith("@/")) target = join(root, spec.slice(2));
  else if (spec.startsWith(".")) target = resolve(dirname(fromFile), spec);
  else return null;

  const candidates = [
    target,
    ...SOURCE_EXT.map((ext) => target + ext),
    ...SOURCE_EXT.map((ext) => join(target, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk `entries` (paths relative to `root`) and return human-readable violations.
 * `read` returns file text, or null when the path is missing.
 */
export function findBoundaryViolations(
  root: string,
  entries: string[],
  read: (absPath: string) => string | null,
  exists: (absPath: string) => boolean = (abs) => read(abs) !== null,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  function visit(absFile: string, chain: string[]): void {
    const rel = relative(root, absFile).split(sep).join("/");
    if (isForbiddenModule(rel)) {
      violations.push(`${chain[0]} reaches ${rel} via ${chain.join(" -> ")}`);
      return;
    }
    if (seen.has(absFile)) return;
    seen.add(absFile);
    const text = read(absFile);
    if (text === null) {
      violations.push(`${chain.join(" -> ")} is missing`);
      return;
    }
    for (const name of envNameViolations(text)) {
      violations.push(`${rel} reads process.env.${name}`);
    }
    for (const spec of importSpecifiers(text)) {
      if (spec.endsWith(".css") || spec.endsWith(".json")) continue;
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      const next = resolveSpecifier(absFile, spec, root, exists);
      if (!next) {
        violations.push(`${rel} imports unresolved ${spec}`);
        continue;
      }
      visit(next, [...chain, relative(root, next).split(sep).join("/")]);
    }
  }

  for (const entry of entries) {
    visit(resolve(root, entry), [entry.split(sep).join("/")]);
  }
  return violations;
}

export function listAppEntries(root: string): string[] {
  const appDir = join(root, "app");
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (SOURCE_EXT.some((ext) => name.endsWith(ext))) {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }
  walk(appDir);
  return out.sort();
}

export function scanApp(root: string): string[] {
  const exists = (abs: string) => existsSync(abs) && statSync(abs).isFile();
  return findBoundaryViolations(
    root,
    listAppEntries(root),
    (abs) => (exists(abs) ? readFileSync(abs, "utf8") : null),
    exists,
  );
}
