export const OWN_CHILD_MARK = "inbox-guard: own child";

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

export const HANDLES_INBOX = /inbox\.json|readInboxRegistry|inboxEntryOf|InboxRegistry|startInbox|inbox-world|inbox-scratch|["']inbox["'],\s*["']--background["']|\/api\/inbox\//;

function ownChild(raw: string[], line: number): boolean {
  return [raw[line - 1], raw[line - 2]].some((l) => l?.includes(OWN_CHILD_MARK));
}

function killZeroProbe(text: string, quote: number): boolean {
  const q = text[quote]!;
  const close = text.indexOf(q, quote + 1);
  if (close < 0) return false;
  const inner = text.slice(quote + 1, close);
  if (/^\s*kill\s+-0(?![\w-])/.test(inner)) return !/\b(?:kill|pkill|killall)\b/.test(inner.replace(/\bkill\s+-0(?![\w-])/g, ""));
  return inner.trim() === "kill" && /^\s*,\s*\[?\s*(["'`])-0\1/.test(text.slice(close + 1));
}

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
    if (args[1] === "0") continue;
    add(m.index!, `process.kill(${args.join(", ")})`);
  }
  for (const m of text.matchAll(/["'`]\s*(?:kill|pkill|killall)(?:\s|["'`])/g)) {
    if (!killZeroProbe(text, m.index!)) add(m.index!, `${m[0].trim()}…`);
  }
  for (const m of text.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(["'`])\s*(?:kill|pkill|killall)\b/g)) {
    if (!killZeroProbe(text, m.index! + m[0].lastIndexOf(m[1]!))) add(m.index!, m[0]);
  }
  for (const m of text.matchAll(/\{[^{}]*\bkill\b[^{}]*\}\s*=\s*(?:globalThis\.)?process\b|=\s*(?:globalThis\.)?process\.kill\b(?!\s*\()|\bprocess\.kill\.(?:bind|call|apply)\b/g)) add(m.index!, m[0]);
  return [...new Set(found)];
}

const HOME_EXPR = String.raw`(?:(?:os\.)?homedir\(\)|(?:os\.)?userInfo\(\)\.homedir|process\.env\.HOME!?|Bun\.env\.HOME!?)`;
const DOT_PLANNOTATOR = String.raw`\.plannotator(?![\w.-])`;

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
  const literalAsPath = new RegExp(`(?:PLANNOTATOR_DATA_DIR|dataDir|data-dir|\\b(?:join|resolve|readFileSync|writeFileSync|appendFileSync|rmSync|mkdirSync|existsSync|readdirSync|statSync|realpathSync|spawn|spawnSync|execSync)\\b)[^\\n]*["'\`]~[/\\\\]${DOT_PLANNOTATOR}`, "g");
  for (const m of text.matchAll(literalAsPath)) add(m.index!, m[0]);
  const byLine = new Map<string, string>();
  for (const finding of found) {
    const line = finding.slice(0, finding.indexOf(":"));
    if (!byLine.has(line)) byLine.set(line, finding);
  }
  return [...byLine.values()];
}

const AGENT_DIR = String.raw`(?:\.claude|\.codex|\.gemini|\.qwen|\.cursor|\.kiro|\.pi|\.vibe|\.copilot|\.config["'\`]?\s*,\s*["'\`](?:opencode|amp|devin|Claude)|\.config[/\\](?:opencode|amp|devin|Claude)|Library[/\\]Application Support[/\\]Claude|Library["'\`]\s*,\s*["'\`]Application Support)(?![\w.-])`;

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

export function agentConnectFindings(source: string): string[] {
  const text = stripComments(source);
  if (/\b(?:agentEnvironment|environment)\s*:|createAgentEnvironmentFor\b|PLANNOTATOR_INBOX_CONNECT["'\`]?\s*:\s*["'\`]0/.test(text)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(/\bconnectInboxAgents\s*\(|\.connectAgents\s*\(|\/api\/inbox\/control\/connect/g)) {
    found.push(`${lineOf(text, m.index!)}: ${m[0]} with no agent environment`);
  }
  return found;
}

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
