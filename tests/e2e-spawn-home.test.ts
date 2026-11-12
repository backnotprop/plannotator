import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])(\/\/[^\n]*)/g, (_, before: string, comment: string) => before + blank(comment));
}

function enclosingLiteral(source: string, at: number): string {
  let depth = 0;
  let open = 0;
  for (let i = at; i >= 0; i--) {
    if (source[i] === "}") depth++;
    else if (source[i] === "{" && depth-- === 0) {
      open = i;
      break;
    }
  }
  depth = 0;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && depth-- === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

const RUNNER_HOME = /^(process\.env\.HOME|process\.env\[\s*["']HOME["']\s*\]|(os\.)?homedir\(\))!?$/;

function hasScratchHome(literal: string): boolean {
  if (/\.\.\.\s*scratchEnv\(/.test(literal)) return true;
  let named = false;
  for (const m of literal.matchAll(/(?:^|[\s{,])["']?HOME["']?\s*(?::\s*([^,}\n]+?))?\s*(?=[,}\n])/g)) {
    const value = m[1]?.trim();
    if (value !== undefined && RUNNER_HOME.test(value)) return false;
    named = true;
  }
  return named;
}

function unguardedEnvs(name: string, source: string): { missing: string[]; scanned: number } {
  const text = withoutComments(source);
  const missing: string[] = [];
  let scanned = 0;
  for (const match of text.matchAll(/(^|[\s{,])["']?PLANNOTATOR_DATA_DIR["']?\s*:/g)) {
    scanned++;
    const at = match.index! + match[1]!.length;
    if (!hasScratchHome(enclosingLiteral(text, at))) missing.push(`${name}:${text.slice(0, at).split("\n").length}`);
  }
  return { missing, scanned };
}

describe("an e2e spawn env", () => {
  test("the matcher: a named scratch HOME or scratchEnv() passes; none, or the runner's, fails", () => {
    const flagged = (literal: string) => unguardedEnvs("x.ts", `const env = ${literal};`).missing.length === 1;
    expect(flagged("{ PATH: p, PLANNOTATOR_DATA_DIR: d }")).toBe(true);
    expect(flagged("{ 'PLANNOTATOR_DATA_DIR': d, PATH: p }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME: process.env.HOME! }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME: process.env['HOME'] }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME: homedir() }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME: os.homedir() }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, // HOME: root\n }")).toBe(true);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME: join(root, 'home') }")).toBe(false);
    expect(flagged("{ PLANNOTATOR_DATA_DIR: d, HOME }")).toBe(false);
    expect(flagged("{ ...scratchEnv(root), PLANNOTATOR_DATA_DIR: d }")).toBe(false);
  });

  test("in tests/e2e that sets PLANNOTATOR_DATA_DIR also sets a scratch HOME, or spreads scratchEnv()", () => {
    const dir = join(import.meta.dir, "e2e");
    let scanned = 0;
    const missing: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
      const found = unguardedEnvs(`tests/e2e/${name}`, readFileSync(join(dir, name), "utf8"));
      scanned += found.scanned;
      missing.push(...found.missing);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
