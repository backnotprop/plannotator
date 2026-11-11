/**
 * The Inbox window's shape (packages/inbox), held by two rules (docs/agent-guides/inbox-window.md, "Where code goes").
 *
 * 1. Size. Every file under the new folders (`data/`, `screens/`, `parts/`) stays at or under NEW_FILE_CAP lines.
 *    The files that were already big (over BIG_FILE_LINES when this guard came) each have a ceiling in
 *    inbox-size-ceilings.json equal to their size; a ceiling only goes down: a file that shrank fails until its
 *    ceiling is lowered to its new size, and no other file may pass BIG_FILE_LINES.
 * 2. Imports. Screens and parts draw; they never fetch: no `fetch(` and no `inboxApi` (the API client) there, and no
 *    import of a big file but its types (so they cannot lean on its private copies of data). `data/` holds no React components:
 *    nothing it imports is a `.tsx` file, a component folder, or the big files.
 *
 * A source scan, since the repo has no linter to say it (no Oxlint or ESLint config).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const inbox = join(root, "packages/inbox");
const NEW_FOLDERS = ["data", "screens", "parts"] as const;
export const NEW_FILE_CAP = 300;
const BIG_FILE_LINES = 1500;
const ceilingsFile = join(import.meta.dir, "inbox-size-ceilings.json");
const ceilings = JSON.parse(readFileSync(ceilingsFile, "utf8")) as Record<string, number>;

const lines = (file: string) => readFileSync(file, "utf8").split("\n").length - 1;
const rel = (file: string) => relative(root, file).split("\\").join("/");

function sources(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The modules a source imports (static, dynamic and re-exports), as written; `typeOnly`: an `import type`. */
export function importsOf(text: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(import|export)(\s+type)?\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[3]!, typeOnly: !!m[2] });
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1]!, typeOnly: false });
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** A relative import resolved to a repo path (with its extension when one exists), or the bare name. */
function resolveImport(from: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate);
  }
  return rel(base);
}

/** Comments out, so a rule's own explanation in a comment never counts as a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

/** What a file in a new folder may not do, each a reason in words; empty: it keeps the rules. */
export function importFindings(file: string, text: string, big: ReadonlySet<string>): string[] {
  const at = rel(file);
  const found: string[] = [];
  const body = code(text);
  const targets = importsOf(body).map(({ spec, typeOnly }) => ({ spec, typeOnly, path: resolveImport(file, spec) }));
  const drawing = /^packages\/inbox\/(screens|parts)\//.test(at);
  if (drawing) {
    if (/(^|[^.\w])fetch\s*\(/.test(body)) found.push("calls fetch: screens and parts read data through packages/inbox/data");
    if (/\binboxApi\b/.test(body)) found.push("uses inboxApi: screens and parts read and write through packages/inbox/data");
  }
  for (const { spec, typeOnly, path } of targets) {
    // A type names a shape, never a copy of data: types may still come from a big file (api.ts holds the wire types).
    if (big.has(path) && !typeOnly) found.push(`imports ${spec}, a big file: move what it needs out of it first`);
    if (at.startsWith("packages/inbox/data/")) {
      if (path.endsWith(".tsx") || /^packages\/inbox\/(components|screens|parts)\//.test(path) || path === "packages/inbox/App") {
        found.push(`imports ${spec}: data/ holds no React components`);
      }
    }
  }
  return found;
}

describe("Inbox window structure", () => {
  const all = sources(inbox);
  const big = new Set(Object.keys(ceilings).filter((path) => !/\.test\.tsx?$/.test(path)));

  test(`every file under ${NEW_FOLDERS.join(", ")} is at most ${NEW_FILE_CAP} lines`, () => {
    const over = NEW_FOLDERS.flatMap((folder) => sources(join(inbox, folder)))
      .map((file) => ({ file: rel(file), n: lines(file) }))
      .filter(({ n }) => n > NEW_FILE_CAP)
      .map(({ file, n }) => `${file}: ${n} lines (cap ${NEW_FILE_CAP}: split it by job)`);
    expect(over).toEqual([]);
  });

  test("a big file never grows, and its ceiling follows it down", () => {
    const wrong: string[] = [];
    for (const [path, ceiling] of Object.entries(ceilings)) {
      const file = join(root, path);
      if (!existsSync(file)) {
        wrong.push(`${path}: gone; take it out of tests/inbox-size-ceilings.json`);
        continue;
      }
      const n = lines(file);
      if (n > ceiling) wrong.push(`${path}: ${n} lines, over its ceiling of ${ceiling}: move code out into data/, screens/ or parts/`);
      if (n < ceiling) wrong.push(`${path}: ${n} lines, under its ceiling of ${ceiling}: lower its ceiling in tests/inbox-size-ceilings.json to ${n}`);
    }
    expect(wrong).toEqual([]);
  });

  test(`no other file passes ${BIG_FILE_LINES} lines`, () => {
    const grown = all.map((file) => ({ file: rel(file), n: lines(file) })).filter(({ file, n }) => n > BIG_FILE_LINES && ceilings[file] === undefined);
    expect(grown.map(({ file, n }) => `${file}: ${n} lines`)).toEqual([]);
  });

  test("screens and parts never fetch or import a big file; data/ holds no components", () => {
    const files = NEW_FOLDERS.flatMap((folder) => sources(join(inbox, folder)));
    const findings = files.flatMap((file) => importFindings(file, readFileSync(file, "utf8"), big).map((why) => `${rel(file)}: ${why}`));
    expect(findings).toEqual([]);
  });

  test("the import rule catches what it names", () => {
    const bigSet = new Set(["packages/inbox/App.tsx", "packages/inbox/components/Thread.tsx"]);
    const part = join(inbox, "parts/Example.tsx");
    expect(importFindings(part, "const r = await fetch('/api/inbox/threads');", bigSet)).toHaveLength(1);
    expect(importFindings(part, "import { inboxApi } from '../api';", bigSet)).toHaveLength(1);
    expect(importFindings(part, "import { ThreadPane } from '../components/Thread';", bigSet)).toHaveLength(1);
    expect(importFindings(part, "import type { ThreadModel } from '../api';\n// never fetch( here", bigSet)).toEqual([]);
    const data = join(inbox, "data/example.ts");
    expect(importFindings(data, "import { ThreadPane } from '../components/Thread';", bigSet).length).toBeGreaterThan(0);
    expect(importFindings(data, "import { useQuery } from '@tanstack/react-query';", bigSet)).toEqual([]);
  });
});
