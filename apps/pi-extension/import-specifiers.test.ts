import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * This package is distributed and executed as raw TypeScript through jiti
 * (and Bun in tests). A relative ".js" specifier names a file that never
 * exists here, so jiti reaches it only through a slow last-resort fallback
 * (~2ms per import vs ~20us for an exact ".ts" hit — ~30ms across the eager
 * graph); extensionless imports still require probing. Exact ".ts" paths also
 * satisfy native Node's TypeScript resolver, which remaps neither form.
 *
 * All relative specifiers must name the ".ts" file that actually ships.
 * vendor.sh enforces this for generated/ (normalization pass at the end);
 * this test enforces it for hand-written sources.
 */

const ROOT = import.meta.dir;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const RELATIVE_SPECIFIER =
  /(?:from\s+|import\s*\(\s*|import\s+)(["'])(\.\.?\/[^"']+)\1/g;

function isInexactTypeScriptSpecifier(specifier: string): boolean {
  return /\.(?:c|m)?js$/.test(specifier) || !/\.[^/]+$/.test(specifier);
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("relative import specifiers name the .ts files that actually ship", () => {
  const offenders: string[] = [];
  for (const file of collectTsFiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    RELATIVE_SPECIFIER.lastIndex = 0;
    while ((match = RELATIVE_SPECIFIER.exec(text))) {
      const specifier = match[2];
      if (isInexactTypeScriptSpecifier(specifier)) {
        offenders.push(`${file.slice(ROOT.length + 1)} -> ${specifier}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
