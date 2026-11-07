/**
 * Every Plannotator process an e2e spec starts gets a scratch HOME. The
 * Playwright runner keeps the caller's HOME (tests/e2e/global-setup.ts sets
 * none), so a spawn env that names a data dir but no HOME, or a HOME taken from
 * the runner (`process.env.HOME`, `homedir()`), starts Plannotator on the
 * account's home. A static scan of tests/e2e: it reads files and starts nothing.
 *
 * Known gaps, left on purpose: an env with no data-dir key at all, the
 * `{ PLANNOTATOR_DATA_DIR }` shorthand, `env.PLANNOTATOR_DATA_DIR = …`, and the
 * helpers outside tests/e2e. A spread of a helper's env (which may hold HOME)
 * fails closed: name HOME in the literal or spread `scratchEnv()`
 * (tests/e2e/inbox-scratch.ts).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments blanked out, so a commented-out env never counts; line numbers stay. */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])(\/\/[^\n]*)/g, (_, before: string, comment: string) => before + blank(comment));
}

/** The object literal around `at`: from its unmatched `{` to the matching `}`. */
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

/** The runner's own home, as a spec could pass it on. */
const RUNNER_HOME = /^(process\.env\.HOME|process\.env\[\s*["']HOME["']\s*\]|(os\.)?homedir\(\))!?$/;

/** Whether an env literal gives its process a scratch HOME (named, shorthand, or by `...scratchEnv(`). */
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

/** `file:line` of each env literal in `source` that sets a data dir without a scratch HOME, and how many it checked. */
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
    // A matcher that stopped matching would pass forever: the specs hold about 200 of these envs.
    expect(scanned).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
