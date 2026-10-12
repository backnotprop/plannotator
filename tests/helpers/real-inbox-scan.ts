/**
 * The source scan behind tests/never-touch-the-real-inbox.test.ts: pure
 * functions over one file's text, so the test can run them over every test
 * and dev script AND over fixtures in memory.
 *
 * Each finding is `<line>: <what>`. Comments are blanked before scanning (a
 * comment that names `~/.plannotator` or `kill -9` is documentation, not
 * code); string contents stay, because a shell command in a string runs.
 *
 * An own child may be signalled where the scan would object: put
 * `inbox-guard: own child` in a comment on that line or the line above, and
 * signal only a child process the test spawned itself, never a pid read from
 * a registry.
 */

/** The marker that lets one line signal a test's own (non-Inbox) child. */
export const OWN_CHILD_MARK = "inbox-guard: own child";

/** `text` with every comment replaced by spaces (newlines kept), strings left alone. */
export function stripComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

/** The argument list of the call whose `(` is at `open`, split at top-level commas. Comments must already be stripped. */
export function callArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args.filter((a) => a.length > 0);
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** A file that handles Inbox processes or their registries. */
export const HANDLES_INBOX = /inbox\.json|readInboxRegistry|inboxEntryOf|InboxRegistry|startInbox|inbox-world|inbox-scratch|["']inbox["'],\s*["']--background["']|\/api\/inbox\//;

/** The raw line, or the one above it, carries the own-child mark. */
function ownChild(raw: string[], line: number): boolean {
  return [raw[line - 1], raw[line - 2]].some((l) => l?.includes(OWN_CHILD_MARK));
}

/**
 * Signals in a file that handles Inbox processes: `process.kill` with any
 * signal but 0, a `kill`/`pkill`/`killall` run through spawn/exec or written
 * as a shell command in a string, and `kill` taken off `process`.
 */
export function signalFindings(source: string): string[] {
  if (!HANDLES_INBOX.test(source)) return [];
  const raw = source.split("\n");
  const text = stripComments(source);
  const found: string[] = [];
  const add = (index: number, what: string) => {
    const line = lineOf(text, index);
    if (!ownChild(raw, line)) found.push(`${line}: ${what}`);
  };
  for (const m of text.matchAll(/\bprocess\.kill\s*\(/g)) {
    const args = callArgs(text, m.index! + m[0].length - 1);
    if (args[1] === "0") continue; // An existence probe sends nothing.
    add(m.index!, `process.kill(${args.join(", ")})`);
  }
  // A shell command in a string or template literal, or an argv list: "kill -9 …", `kill ${pid}`, ["kill", …].
  for (const m of text.matchAll(/["'`]\s*(?:kill|pkill|killall)(?:\s|["'`])/g)) add(m.index!, `${m[0].trim()}…`);
  // spawn("kill", …) / execSync("pkill …") and friends.
  for (const m of text.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]\s*(?:kill|pkill|killall)\b/g)) add(m.index!, m[0]);
  // const { kill } = process; const kill = process.kill; process.kill.bind(…)
  for (const m of text.matchAll(/\{[^{}]*\bkill\b[^{}]*\}\s*=\s*(?:globalThis\.)?process\b|=\s*(?:globalThis\.)?process\.kill\b(?!\s*\()|\bprocess\.kill\.(?:bind|call|apply)\b/g)) add(m.index!, m[0]);
  return [...new Set(found)];
}

const HOME_EXPR = String.raw`(?:(?:os\.)?homedir\(\)|(?:os\.)?userInfo\(\)\.homedir|process\.env\.HOME!?|Bun\.env\.HOME!?)`;
const DOT_PLANNOTATOR = String.raw`\.plannotator(?![\w.-])`;

/**
 * A path from the home directory to `.plannotator`: on one line, through a
 * multi-line `join(` / `resolve(`, through a variable assigned from
 * `homedir()` (or $HOME), or the literal "~/.plannotator" where it is used as
 * a path (a data dir, an fs or path call; a UI string that shows it is fine).
 */
export function homePathFindings(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  const add = (index: number, what: string) => found.push(`${lineOf(text, index)}: ${what.replace(/\s+/g, " ").trim()}`);
  const sameLine = new RegExp(`${HOME_EXPR}[^\\n]*?["'\`/\\\\]${DOT_PLANNOTATOR}`, "g");
  for (const m of text.matchAll(sameLine)) add(m.index!, m[0]);
  const names = [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*(?::\\s*string\\s*)?=\\s*${HOME_EXPR}`, "g"))].map((m) => m[1]!);
  const home = names.length > 0 ? `(?:${HOME_EXPR}|\\b(?:${names.join("|")})\\b)` : HOME_EXPR;
  for (const m of text.matchAll(new RegExp(`\\b(?:join|resolve)\\(\\s*${home}\\s*,\\s*["'\`]${DOT_PLANNOTATOR}`, "g"))) add(m.index!, m[0]);
  if (names.length > 0) {
    for (const m of text.matchAll(new RegExp(`\\$\\{\\s*(?:${names.join("|")})\\s*\\}[/\\\\]${DOT_PLANNOTATOR}`, "g"))) add(m.index!, m[0]);
  }
  // The literal, where it is used as a path (a data dir, an fs or path call), not shown as text.
  const literalAsPath = new RegExp(`(?:PLANNOTATOR_DATA_DIR|dataDir|data-dir|\\b(?:join|resolve|readFileSync|writeFileSync|appendFileSync|rmSync|mkdirSync|existsSync|readdirSync|statSync|realpathSync|spawn|spawnSync|execSync)\\b)[^\\n]*["'\`]~[/\\\\]${DOT_PLANNOTATOR}`, "g");
  for (const m of text.matchAll(literalAsPath)) add(m.index!, m[0]);
  // One finding per line, whichever rule saw it first.
  const byLine = new Map<string, string>();
  for (const finding of found) {
    const line = finding.slice(0, finding.indexOf(":"));
    if (!byLine.has(line)) byLine.set(line, finding);
  }
  return [...byLine.values()];
}

/** The agents' own folders the Inbox writes to (packages/server/inbox-agents.ts, its notes). */
const AGENT_DIR = String.raw`(?:\.claude|\.codex|\.gemini|\.cursor|\.kiro|\.pi|\.vibe|\.copilot|\.config["'\`]?\s*,\s*["'\`](?:opencode|amp|devin|Claude)|\.config[/\\](?:opencode|amp|devin|Claude)|Library[/\\]Application Support[/\\]Claude|Library["'\`]\s*,\s*["'\`]Application Support)(?![\w.-])`;

/**
 * A path from the real home directory to an agent's own folder (`~/.codex`,
 * `~/.cursor`, `~/.config/opencode`, the Claude app's settings…): tests point
 * HOME at a scratch folder and use that, never `homedir()`. Same line, a
 * multi-line `join(`, a variable assigned from `homedir()`, or the literal
 * `~/.codex` used as a path.
 */
export function agentHomeFindings(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  const add = (index: number, what: string) => found.push(`${lineOf(text, index)}: ${what.replace(/\s+/g, " ").trim()}`);
  for (const m of text.matchAll(new RegExp(`${HOME_EXPR}[^\\n]*?["'\`/\\\\]${AGENT_DIR}`, "g"))) add(m.index!, m[0]);
  const names = [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*(?::\\s*string\\s*)?=\\s*${HOME_EXPR}`, "g"))].map((m) => m[1]!);
  const home = names.length > 0 ? `(?:${HOME_EXPR}|\\b(?:${names.join("|")})\\b)` : HOME_EXPR;
  for (const m of text.matchAll(new RegExp(`\\b(?:join|resolve)\\(\\s*${home}\\s*,\\s*["'\`]${AGENT_DIR}`, "g"))) add(m.index!, m[0]);
  const literalAsPath = new RegExp(`\\b(?:join|resolve|readFileSync|writeFileSync|appendFileSync|rmSync|mkdirSync|existsSync|readdirSync|statSync|realpathSync|symlinkSync)\\b[^\\n]*["'\`]~[/\\\\]${AGENT_DIR}`, "g");
  for (const m of text.matchAll(literalAsPath)) add(m.index!, m[0]);
  const byLine = new Map<string, string>();
  for (const finding of found) {
    const line = finding.slice(0, finding.indexOf(":"));
    if (!byLine.has(line)) byLine.set(line, finding);
  }
  return [...byLine.values()];
}

/**
 * Connecting agents (`connectInboxAgents`, an Inbox's `connectAgents`, the
 * `/api/inbox/control/connect` route) in a file that never gives an agent
 * environment: it would run the real agent CLIs against the real home.
 */
export function agentConnectFindings(source: string): string[] {
  const text = stripComments(source);
  if (/\b(?:agentEnvironment|environment)\s*:|createAgentEnvironmentFor\b|PLANNOTATOR_INBOX_CONNECT["'\`]?\s*:\s*["'\`]0/.test(text)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(/\bconnectInboxAgents\s*\(|\.connectAgents\s*\(|\/api\/inbox\/control\/connect/g)) {
    found.push(`${lineOf(text, m.index!)}: ${m[0]} with no agent environment`);
  }
  return found;
}

/**
 * `startInboxServer` calls that do not name `dataDir`. In a standalone script
 * (not a *.test / *.spec file, which runs under the preload's sandbox) the
 * file must ALSO point PLANNOTATOR_DATA_DIR at that folder, because the Inbox
 * reads and writes config.json through getPlannotatorDataDir() even when it is
 * given dataDir.
 */
export function inboxServerFindings(source: string, isStandaloneScript: boolean): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  for (const m of text.matchAll(/\bstartInboxServer\s*\(/g)) {
    const args = callArgs(text, m.index! + m[0].length - 1);
    if (!/\bdataDir\b/.test(args[0] ?? "")) {
      found.push(`${lineOf(text, m.index!)}: startInboxServer without dataDir`);
    } else if (isStandaloneScript && !/process\.env\.PLANNOTATOR_DATA_DIR\s*=[^=]|\bdataDir\s*:\s*getPlannotatorDataDir\(\)|=\s*getPlannotatorDataDir\(\)/.test(text)) {
      found.push(`${lineOf(text, m.index!)}: startInboxServer in a script that does not set PLANNOTATOR_DATA_DIR to its dataDir (config.json follows the env)`);
    }
  }
  return found;
}
