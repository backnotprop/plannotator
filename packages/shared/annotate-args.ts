/**
 * Parses CLI-style args arriving as one whitespace-delimited string (OpenCode, Pi), removing known flags and a leading `@`.
 * Whitespace runs inside paths are preserved; a path with a known flag as a standalone token has it stripped.
 */

import { stripAtPrefix } from "./at-reference";
import { stripWrappingQuotes } from "./resolve-file";

export interface ParsedAnnotateArgs {
  filePath: string;
  rawFilePath: string;
  gate: boolean;
  json: boolean;
  hook: boolean;
  renderHtml: boolean;
  renderMarkdown: boolean;
  noJina: boolean;
  app: boolean;
  static: boolean;
}

type Segment = { type: "ws" | "tok"; text: string };

const FLAG_MAP = {
  "--gate": "gate",
  "--json": "json",
  "--hook": "hook",
  "--render-html": "renderHtml",
  "--markdown": "renderMarkdown",
  "--no-jina": "noJina",
} as const satisfies Record<string, keyof Omit<ParsedAnnotateArgs, "filePath" | "rawFilePath">>;

/** Recognized only where the host supports live app sessions; otherwise leaving --app in the path keeps the honest "File not found" error. */
const LIVE_FLAG_MAP = {
  "--app": "app",
  "--static": "static",
} as const satisfies Record<string, keyof Omit<ParsedAnnotateArgs, "filePath" | "rawFilePath">>;

export interface ParseAnnotateArgsOptions {
  liveFlags?: boolean;
}

export function parseAnnotateArgs(raw: string, opts?: ParseAnnotateArgsOptions): ParsedAnnotateArgs {
  const s = (raw ?? "").trim();
  const flags = { gate: false, json: false, hook: false, renderHtml: false, renderMarkdown: false, noJina: false, app: false, static: false };
  const flagMap: Record<string, keyof typeof flags> = opts?.liveFlags
    ? { ...FLAG_MAP, ...LIVE_FLAG_MAP }
    : { ...FLAG_MAP };

  const segments: Segment[] = [];
  for (let i = 0; i < s.length;) {
    const isWs = /\s/.test(s[i]);
    const start = i;
    while (i < s.length && /\s/.test(s[i]) === isWs) i++;
    segments.push({ type: isWs ? "ws" : "tok", text: s.slice(start, i) });
  }

  const keep = segments.map(() => true);
  for (let j = 0; j < segments.length; j++) {
    const seg = segments[j];
    if (seg.type !== "tok") continue;
    const key = flagMap[seg.text];
    if (!key) continue;

    flags[key] = true;
    keep[j] = false;

    // Drop one adjacent whitespace run so removed flags leave no dangling spaces.
    if (j + 1 < segments.length && segments[j + 1].type === "ws") {
      keep[j + 1] = false;
    } else if (j > 0 && segments[j - 1].type === "ws") {
      keep[j - 1] = false;
    }
  }

  // Trim: two adjacent flags both claim the whitespace between them. Wrapping quotes (users quoting paths with spaces) are stripped here.
  const rawFilePath = stripWrappingQuotes(
    segments
      .filter((_, j) => keep[j])
      .map((seg) => seg.text)
      .join("")
      .trim(),
  );

  if (flags.hook) flags.gate = true;

  return { filePath: stripAtPrefix(rawFilePath), rawFilePath, ...flags };
}

/**
 * The target words of a slash command's raw annotate args, known flags dropped, for hosts that pass them to the CLI as separate arguments.
 * A quote groups only when it opens a word and closes at a word's end, so prose apostrophes stay ordinary; an open quote splits on whitespace alone.
 */
export function annotateTargetWords(raw: string, opts?: ParseAnnotateArgsOptions): string[] {
  const text = (raw ?? "").trim();
  const scanned = scanAnnotateWords(text);
  const words = scanned.unterminated ? text.split(/\s+/) : scanned.words;
  const flags = new Set<string>([...Object.keys(FLAG_MAP), ...(opts?.liveFlags ? Object.keys(LIVE_FLAG_MAP) : [])]);
  return words.filter((word) => word && !flags.has(word));
}

function scanAnnotateWords(text: string): { words: string[]; unterminated: boolean } {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote && isSpace(text[i + 1])) {
        quote = undefined;
        if (current) words.push(current);
        current = "";
      } else {
        current += char;
      }
      continue;
    }
    if ((char === "'" || char === "\"") && !current && isSpace(text[i - 1])) {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return { words, unterminated: quote !== undefined };
}
