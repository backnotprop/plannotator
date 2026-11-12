/**
 * The source scan behind tests/windows-hide-guard.test.ts: pure functions over
 * one file's text, so the test can run them over the runtime trees AND over
 * fixtures in memory.
 *
 * Why: on Windows, a console program (git, gh, glab, tailscale, an agent CLI,
 * cmd, PowerShell) started by a process that has no console of its own, such
 * as the Inbox running in the background, opens a new console window for as
 * long as it runs. `windowsHide: true` stops that, and both Bun and Node
 * default it to false. Bun Shell (`$` from "bun") takes no such option.
 *
 * Each finding is `<line>: <what>`. Comments are blanked before scanning.
 * A call whose options the scan cannot read (a variable, or a spread after
 * `windowsHide`) is a finding too: write the options inline, or put
 * `windows-hide-guard: <why>` in a comment on the call's line or the line
 * above (for example: macOS only).
 */
import { callArgs, stripComments } from "./real-inbox-scan";
import { childProcessBindings, lineOf, objectProperties } from "./child-env-scan";

/** The marker that lets one call through: `windows-hide-guard: <why no console window can open>`. */
export const WINDOWS_HIDE_EXEMPT_MARK = "windows-hide-guard:";

/** Every node:child_process call that starts a process. */
const NODE_CALLS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

function exempt(rawLines: string[], line: number): boolean {
  return [line, line - 1].some((n) => (rawLines[n - 1] ?? "").includes(WINDOWS_HIDE_EXEMPT_MARK));
}

type HideVerdict = "ok" | "missing" | "unreadable";

/** Index of the first top-level `token` in `text` (outside brackets and strings), or -1. A `?` must be a conditional: not `?.` or `??`. */
function topLevelIndex(text: string, token: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && text.startsWith(token, i)) {
      if (token === "?" && (text[i + 1] === "." || text[i + 1] === "?" || text[i - 1] === "?")) continue;
      return i;
    }
  }
  return -1;
}

const isObjectLiteral = (text: string) => text.startsWith("{") && text.endsWith("}");

/**
 * A spread that only adds inline object literals naming no `windowsHide`
 * (`...(cwd ? { cwd } : {})`, `...(opts?.cwd && { cwd: opts.cwd })`): it
 * cannot replace a `windowsHide` written before it.
 */
function harmlessSpread(prop: string): boolean {
  if (/\bwindowsHide\b/.test(prop)) return false;
  const body = prop.slice(3).trim();
  if (isObjectLiteral(body)) return true;
  if (!body.startsWith("(") || !body.endsWith(")")) return false;
  const inner = body.slice(1, -1).trim();
  const question = topLevelIndex(inner, "?");
  if (question !== -1) {
    const branches = inner.slice(question + 1);
    const colon = topLevelIndex(branches, ":");
    return colon !== -1 && isObjectLiteral(branches.slice(0, colon).trim()) && isObjectLiteral(branches.slice(colon + 1).trim());
  }
  const and = topLevelIndex(inner, "&&");
  return and !== -1 && isObjectLiteral(inner.slice(and + 2).trim());
}

/** What an options object literal says about `windowsHide`: the last one decides, and a spread after it may replace it. */
function hideOf(literal: string): HideVerdict {
  let verdict: HideVerdict | null = null;
  let spread = false;
  for (const prop of objectProperties(literal)) {
    if (prop.startsWith("...")) {
      if (harmlessSpread(prop)) continue;
      spread = true;
      if (verdict !== null) verdict = "unreadable";
      continue;
    }
    const m = prop.match(/^(?:windowsHide|"windowsHide"|'windowsHide')\s*(?::\s*([\s\S]*))?$/);
    if (!m) continue;
    verdict = (m[1] ?? "").trim() === "true" ? "ok" : "missing";
  }
  return verdict ?? (spread ? "unreadable" : "missing");
}

/** Local names bound to Bun Shell's `$` (`import { $ } from "bun"`). */
function bunShellNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s+\{([^}]*)\}\s+from\s+["']bun["']/g)) {
    for (const part of m[1]!.split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig?.trim() === "$") names.add((alias ?? orig).trim());
    }
  }
  return names;
}

/**
 * Findings for one file: a Bun or node:child_process call that starts a
 * process without `windowsHide: true`, and any Bun Shell command.
 */
export function windowsHideFindings(source: string): string[] {
  const text = stripComments(source);
  const rawLines = source.split("\n");
  const findings: string[] = [];
  const { names, namespaces } = childProcessBindings(text, NODE_CALLS);

  const calls: { index: number; open: number; kind: string }[] = [];
  for (const m of text.matchAll(/\bBun\s*\.\s*(spawn|spawnSync)\s*\(/g)) {
    calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: `Bun.${m[1]}` });
  }
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      // A declaration, not a call: `function spawn(`, or a method `async spawn(…) {`.
      if (/(?:function|async)\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: name });
    }
  }
  for (const ns of namespaces) {
    const re = new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, "\\$")}\\s*\\.\\s*(${[...NODE_CALLS].join("|")})\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: `${ns}.${m[1]}` });
    }
  }

  const shells: number[] = [...text.matchAll(/\bBun\s*\.\s*\$\s*`/g)].map((m) => m.index!);
  for (const name of bunShellNames(text)) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\``, "g");
    for (const m of text.matchAll(re)) shells.push(m.index!);
  }
  for (const index of shells) {
    const line = lineOf(text, index);
    if (!exempt(rawLines, line)) findings.push(`${line}: Bun Shell cannot hide a console window; use Bun.spawn with windowsHide: true`);
  }

  for (const call of calls) {
    const line = lineOf(text, call.index);
    if (exempt(rawLines, line)) continue;
    const args = callArgs(text, call.open);
    // Bun.spawn({ cmd, … }) takes one options object; every other form takes
    // the options after the command (and after an args array).
    const candidates = call.kind.startsWith("Bun.") && args[0]?.startsWith("{") ? [args[0]] : args.slice(1);
    const literal = candidates.find((a) => a.startsWith("{"));
    let verdict: HideVerdict;
    if (literal) verdict = hideOf(literal);
    else {
      // Only arrays or a callback after the command: no options at all.
      const others = candidates.filter((a) => !a.startsWith("[") && !/^(?:\([^)]*\)|[\w$]+)\s*=>/.test(a) && !a.startsWith("function"));
      verdict = others.length === 0 ? "missing" : "unreadable";
    }
    if (verdict === "ok") continue;
    findings.push(`${line}: ${call.kind} ${verdict === "missing"
      ? "has no windowsHide: true, so on Windows it can open a console window"
      : "passes options the scan cannot read; write them inline with windowsHide: true"}`);
  }
  return findings.sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
}
