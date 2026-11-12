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

    if (j + 1 < segments.length && segments[j + 1].type === "ws") {
      keep[j + 1] = false;
    } else if (j > 0 && segments[j - 1].type === "ws") {
      keep[j - 1] = false;
    }
  }

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
