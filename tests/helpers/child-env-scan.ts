/**
 * The source scan behind tests/child-env-guard.test.ts: pure functions over
 * one file's text, so the test can run them over the production trees AND
 * over fixtures in memory.
 *
 * Why: on Bun, `Bun.spawn`, `Bun.spawnSync` and node:child_process's
 * synchronous calls (`spawnSync`, `execFileSync`, `execSync`) hand a child
 * the STARTUP environment when their `env` option is missing or `undefined`,
 * so variables the CLI deleted from `process.env` (the pull bridge token, the
 * host result file, …) reach git, gh and agent CLIs. `Bun.which` without a
 * `PATH` option likewise searches the startup PATH. See
 * packages/shared/child-env.ts.
 *
 * Each finding is `<line>: <what>`. Comments are blanked before scanning.
 * A call the scan cannot read (its options are a variable, or spread) is a
 * finding too: write the options inline, or put `child-env-guard: <why>` in a
 * comment on the call's line or the line above, saying why the env is safe.
 */
import { callArgs, stripComments } from "./real-inbox-scan";

/** The marker that lets one call through: `child-env-guard: <why the env is safe>`. */
export const CHILD_ENV_EXEMPT_MARK = "child-env-guard:";

/** node:child_process calls that read the startup env under Bun. The async ones read the live env. */
const SYNC_CALLS = new Set(["spawnSync", "execFileSync", "execSync"]);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function exempt(rawLines: string[], line: number): boolean {
  return [line, line - 1].some((n) => (rawLines[n - 1] ?? "").includes(CHILD_ENV_EXEMPT_MARK));
}

/** Local names (and namespace names) bound to node:child_process's synchronous calls. */
function childProcessBindings(text: string): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const importRe = /import\s+([^;]*?)\s+from\s+["'](?:node:)?child_process["']/g;
  for (const m of text.matchAll(importRe)) {
    const clause = m[1]!.replace(/\btype\b\s+/g, "");
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const [orig, alias] = part.trim().split(/\s+as\s+/);
        if (orig && SYNC_CALLS.has(orig.trim())) names.add((alias ?? orig).trim());
      }
    }
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) namespaces.add(ns[1]!);
    const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, " ").trim();
    if (/^[\w$]+$/.test(def)) namespaces.add(def);
  }
  const requireRe = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g;
  for (const m of text.matchAll(requireRe)) {
    const target = m[1]!;
    if (target.startsWith("{")) {
      for (const part of target.slice(1, -1).split(",")) {
        const [orig, alias] = part.trim().split(/\s*:\s*/);
        if (orig && SYNC_CALLS.has(orig.trim())) names.add((alias ?? orig).trim());
      }
    } else namespaces.add(target);
  }
  return { names, namespaces };
}

/** The top-level properties of an object literal's source text (`{ a: 1, ...b, c }`). */
function objectProperties(literal: string): string[] {
  // callArgs splits the contents of a bracketed list at its top-level commas.
  return callArgs(literal, 0);
}

type EnvVerdict = "ok" | "missing" | "unreadable" | "undefined";

/** What an options object literal says about `env`. */
function envOf(literal: string): EnvVerdict {
  // Properties apply in order, so the LAST `env` decides, and a spread after
  // it may replace it (`{ env: childEnv(), ...options }`): unreadable.
  let verdict: EnvVerdict | null = null;
  let spread = false;
  for (const prop of objectProperties(literal)) {
    if (prop.startsWith("...")) {
      spread = true;
      if (verdict !== null) verdict = "unreadable";
      continue;
    }
    const m = prop.match(/^(?:env|"env"|'env')\s*(?::\s*([\s\S]*))?$/);
    if (!m) continue;
    const value = (m[1] ?? "env").trim();
    if (value === "undefined") verdict = "undefined";
    // `command.env` / `opts?.env`: an optional field, undefined when unset.
    else if (value !== "process.env" && /^[\w$]+(?:\??\.[\w$]+)*\??\.env$/.test(value)) verdict = "undefined";
    else verdict = "ok";
  }
  return verdict ?? (spread ? "unreadable" : "missing");
}

/** Whether `Bun.which`'s options literal names a `PATH` (a spread after it: no). */
function namesPath(literal: string | undefined): boolean {
  if (!literal?.startsWith("{")) return false;
  let named = false;
  for (const prop of objectProperties(literal)) {
    if (prop.startsWith("...")) named = false;
    else if (/^(?:PATH|"PATH"|'PATH')\s*(?::|$)/.test(prop)) named = true;
  }
  return named;
}

/**
 * Findings for one file: a Bun or synchronous child_process spawn with no
 * `env` (or one that may be undefined), and a `Bun.which` whose options name
 * no `PATH`.
 */
export function childEnvFindings(source: string): string[] {
  const text = stripComments(source);
  const rawLines = source.split("\n");
  const findings: string[] = [];
  const { names, namespaces } = childProcessBindings(text);

  const calls: { index: number; open: number; kind: string }[] = [];
  for (const m of text.matchAll(/\bBun\s*\.\s*(spawn|spawnSync|which)\s*\(/g)) {
    calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: `Bun.${m[1]}` });
  }
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      // Skip the import itself (`{ spawnSync }` has no paren) and declarations.
      if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: name });
    }
  }
  for (const ns of namespaces) {
    const re = new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, "\\$")}\\s*\\.\\s*(spawnSync|execFileSync|execSync)\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      calls.push({ index: m.index!, open: m.index! + m[0].length - 1, kind: `${ns}.${m[1]}` });
    }
  }

  for (const call of calls) {
    const line = lineOf(text, call.index);
    if (exempt(rawLines, line)) continue;
    const args = callArgs(text, call.open);

    if (call.kind === "Bun.which") {
      if (!namesPath(args[1])) findings.push(`${line}: Bun.which without { PATH } searches the startup PATH`);
      continue;
    }

    // Bun.spawn({ cmd, … }) takes one options object; every other form takes
    // the options after the command (and, for spawnSync/execFileSync, after
    // an args array).
    const candidates = call.kind.startsWith("Bun.") && args[0]?.startsWith("{") ? [args[0]] : args.slice(1);
    const literal = candidates.find((a) => a.startsWith("{"));
    let verdict: EnvVerdict;
    if (literal) verdict = envOf(literal);
    else {
      // Only arrays (or nothing) after the command: no options at all.
      const others = candidates.filter((a) => !a.startsWith("["));
      verdict = others.length === 0 ? "missing" : "unreadable";
    }
    if (verdict === "ok") continue;
    const what = {
      missing: "passes no env, so the child gets Bun's startup environment",
      undefined: "passes an env that may be undefined, so the child may get Bun's startup environment",
      unreadable: "passes options the scan cannot read; write them inline with an env",
    }[verdict];
    findings.push(`${line}: ${call.kind} ${what}`);
  }
  return findings.sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
}
