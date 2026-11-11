function validateFilePath(filePath: string): void {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    throw new Error("Invalid file path");
  }
}

export interface CodeNavRequest {
  symbol: string;
  filePath: string;
  line: number;
  charStart: number;
  side: "old" | "new";
  language?: string;
}

export interface CodeNavLocation {
  kind: "definition" | "reference";
  confidence: "likely" | "possible";
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface CodeNavResponse {
  backend: "search" | "unavailable";
  complete: boolean;
  definitions: CodeNavLocation[];
  references: CodeNavLocation[];
  stats: { elapsedMs: number; capped: boolean };
  searchScope: "head";
}

export interface CodeNavRuntime {
  runCommand: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Optional; without it hover degrades to the definition location plus references. Must return `null` (never throw) for a missing or unreadable file, or one larger than CODE_NAV_MAX_FILE_BYTES. */
  readFile?: (
    path: string,
    options?: { cwd?: string },
  ) => Promise<string | null>;
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "variable"
  | "struct"
  | "trait"
  | "module";

export interface CodeNavHoverLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface CodeNavHoverDefinition extends CodeNavHoverLocation {
  confidence: "likely" | "possible";
  symbolKind: SymbolKind | null;
  signature: string | null;
  signatureApproximate: boolean;
  doc: string | null;
  preview: { startLine: number; lines: string[] } | null;
  otherCandidateCount: number;
}

export interface CodeNavHoverReference {
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface CodeNavHoverResponse {
  backend: "search" | "unavailable";
  source: "search";
  symbol: string;
  definition: CodeNavHoverDefinition | null;
  /** Present only when the search found exactly two candidates; with three or more the extras belong in the References panel. */
  alternateDefinition: CodeNavHoverLocation | null;
  references: CodeNavHoverReference[];
  referenceCount: number;
  capped: boolean;
  stats: { elapsedMs: number };
}

/**
 * A glob with no slash matches a path segment at any depth, so `--glob !vendor` would also prune a first-party package like `src/main/java/com/example/vendor/app/`.
 * ALWAYS_IGNORED names are only ever tool output and are excluded at any depth; ROOT_ONLY names are ambiguous and excluded only at the search root (`--glob !/vendor`).
 */
const CODE_NAV_ALWAYS_IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "__pycache__",
  ".turbo",
  ".cache",
  ".venv",
  ".pytest_cache",
];

const CODE_NAV_ROOT_ONLY_IGNORED_DIRS = [
  "vendor",
  "target",
  "build",
  "dist",
  "coverage",
];

const RG_TYPE_MAP: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  go: "go",
  rust: "rust",
  java: "java",
  ruby: "ruby",
  cpp: "cpp",
  c: "c",
};

/** Each pattern carries the kind it proves; alternations spanning several kinds are split one per kind (their union is unchanged). */
interface DefinitionPattern {
  pattern: string;
  kind: SymbolKind;
}

interface DefinitionPatternSet {
  languages: string[];
  patterns: DefinitionPattern[];
}

const DEFINITION_PATTERNS: DefinitionPatternSet[] = [
  {
    languages: ["typescript", "javascript"],
    patterns: [
      { pattern: String.raw`(?:export\s+)?(?:async\s+)?function\s+SYMBOL\b`, kind: "function" },
      { pattern: String.raw`(?:export\s+)?const\s+SYMBOL\s*[=:]`, kind: "const" },
      { pattern: String.raw`(?:export\s+)?(?:let|var)\s+SYMBOL\s*[=:]`, kind: "variable" },
      { pattern: String.raw`(?:export\s+)?class\s+SYMBOL\b`, kind: "class" },
      { pattern: String.raw`(?:export\s+)?interface\s+SYMBOL\b`, kind: "interface" },
      { pattern: String.raw`(?:export\s+)?type\s+SYMBOL\b`, kind: "type" },
      { pattern: String.raw`(?:export\s+)?enum\s+SYMBOL\b`, kind: "enum" },
      {
        pattern: String.raw`^\s+(?:(?:async|static|readonly|get|set|private|protected|public)\s+)+SYMBOL\s*[(<:]`,
        kind: "method",
      },
    ],
  },
  {
    languages: ["python"],
    patterns: [
      { pattern: String.raw`(?:^|\s)def\s+SYMBOL\s*\(`, kind: "function" },
      { pattern: String.raw`(?:^|\s)class\s+SYMBOL\b`, kind: "class" },
      { pattern: String.raw`^SYMBOL\s*=`, kind: "variable" },
    ],
  },
  {
    languages: ["go"],
    patterns: [
      { pattern: String.raw`func\s+\([^)]+\)\s+SYMBOL\s*\(`, kind: "method" },
      { pattern: String.raw`func\s+SYMBOL\s*\(`, kind: "function" },
      { pattern: String.raw`type\s+SYMBOL\s`, kind: "type" },
      { pattern: String.raw`var\s+SYMBOL\s`, kind: "variable" },
    ],
  },
  {
    languages: ["rust"],
    patterns: [
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?fn\s+SYMBOL\b`, kind: "function" },
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?struct\s+SYMBOL\b`, kind: "struct" },
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?enum\s+SYMBOL\b`, kind: "enum" },
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?trait\s+SYMBOL\b`, kind: "trait" },
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?type\s+SYMBOL\b`, kind: "type" },
      { pattern: String.raw`(?:pub(?:\([^)]*\))?\s+)?mod\s+SYMBOL\b`, kind: "module" },
    ],
  },
];

const GENERIC_DEFINITION_PATTERNS: DefinitionPattern[] = [
  { pattern: String.raw`(?:function|def|func|fn)\s+SYMBOL\b`, kind: "function" },
  { pattern: String.raw`class\s+SYMBOL\b`, kind: "class" },
  { pattern: String.raw`struct\s+SYMBOL\b`, kind: "struct" },
  { pattern: String.raw`enum\s+SYMBOL\b`, kind: "enum" },
  { pattern: String.raw`trait\s+SYMBOL\b`, kind: "trait" },
  { pattern: String.raw`interface\s+SYMBOL\b`, kind: "interface" },
  { pattern: String.raw`type\s+SYMBOL\b`, kind: "type" },
  { pattern: String.raw`const\s+SYMBOL\s*[=:]`, kind: "const" },
  { pattern: String.raw`(?:let|var|val)\s+SYMBOL\s*[=:]`, kind: "variable" },
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameDirectory(a: string, b: string): boolean {
  const dirA = a.lastIndexOf("/");
  const dirB = b.lastIndexOf("/");
  if (dirA === -1 && dirB === -1) return true;
  return a.slice(0, dirA) === b.slice(0, dirB);
}

function isTestFile(filePath: string): boolean {
  return /(?:test|spec|__tests__|_test\.|\.test\.|\.spec\.)/i.test(filePath);
}

function pathSegments(filePath: string): Set<string> {
  return new Set(splitPath(filePath));
}

function splitPath(filePath: string): string[] {
  return filePath.split(/[/\\]/).filter((segment) => segment && segment !== ".");
}

/** Whether `matchPath` is allowed for a request from `originFilePath`. The origin exemption lifts an exclusion only for the directory instance the origin lives under: a match under an excluded directory is kept only when that same directory is an ancestor of the origin file. Root-only names are considered only at the search root. */
export function isCodeNavPathAllowed(
  matchPath: string,
  originFilePath?: string,
): boolean {
  const segments = splitPath(matchPath);
  const origin = originFilePath ? splitPath(originFilePath) : [];
  // Only directory segments can be excluded; the last segment is the file.
  for (let i = 0; i < segments.length - 1; i++) {
    const name = segments[i]!;
    const excluded =
      CODE_NAV_ALWAYS_IGNORED_DIRS.includes(name) ||
      (i === 0 && CODE_NAV_ROOT_ONLY_IGNORED_DIRS.includes(name));
    if (!excluded) continue;
    if (!isAncestorOfOrigin(segments, origin, i)) return false;
  }
  return true;
}

function isAncestorOfOrigin(
  segments: string[],
  origin: string[],
  i: number,
): boolean {
  if (origin.length <= i + 1) return false;
  for (let j = 0; j <= i; j++) {
    if (origin[j] !== segments[j]) return false;
  }
  return true;
}

export function buildRgArgs(
  symbol: string,
  language?: string,
  originFilePath?: string,
): string[] {
  const args: string[] = [
    "--json",
    "--line-number",
    "--column",
    "--max-count",
    "50",
    "--max-filesize",
    "1M",
    "--no-messages",
  ];

  const originSegments = originFilePath
    ? pathSegments(originFilePath)
    : new Set<string>();
  // Which directory the origin file sits at the top of: a root-only glob prunes the search root alone, so only an origin under that root directory needs the exclusion lifted.
  const originRoot = originFilePath ? (splitPath(originFilePath)[0] ?? "") : "";

  for (const dir of CODE_NAV_ALWAYS_IGNORED_DIRS) {
    if (originSegments.has(dir)) continue;
    args.push("--glob", `!${dir}`);
  }

  for (const dir of CODE_NAV_ROOT_ONLY_IGNORED_DIRS) {
    if (originRoot === dir) continue;
    // Leading slash anchors the glob to the search root, so only a top-level
    // `vendor/` (etc.) is pruned — not a same-named package deeper in the tree.
    args.push("--glob", `!/${dir}`);
  }

  if (language) {
    const rgType = RG_TYPE_MAP[language];
    if (rgType) args.push("--type", rgType);
  }

  args.push("--word-regexp", "--", escapeRegex(symbol), ".");

  return args;
}

interface RgMatchData {
  path: { text: string };
  lines: { text: string };
  line_number: number;
  submatches: Array<{ start: number; end: number }>;
}

const PARSE_CAP = 500;

export function parseRgJsonOutput(
  stdout: string,
  symbol: string,
  language?: string,
): CodeNavLocation[] {
  const locations: CodeNavLocation[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    if (locations.length >= PARSE_CAP) break;
    if (!line.trim()) continue;

    let parsed: { type: string; data: RgMatchData };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== "match") continue;

    const d = parsed.data;
    const snippet = d.lines.text.trimEnd();
    const column = d.submatches?.[0]?.start ?? 0;
    const kind = classifyMatch(snippet, symbol, language);
    const filePath = d.path.text.startsWith("./")
      ? d.path.text.slice(2)
      : d.path.text;

    locations.push({
      kind,
      confidence: kind === "definition" ? "likely" : "possible",
      filePath,
      line: d.line_number,
      column,
      snippet: snippet.length > 200 ? snippet.slice(0, 200) + "…" : snippet,
    });
  }

  return locations;
}

export function classifyMatchDetailed(
  snippet: string,
  symbol: string,
  language?: string,
): { kind: "definition" | "reference"; symbolKind: SymbolKind | null } {
  const escaped = escapeRegex(symbol);

  if (language) {
    const langPatterns = DEFINITION_PATTERNS.find((p) =>
      p.languages.includes(language),
    );
    if (langPatterns) {
      for (const { pattern, kind } of langPatterns.patterns) {
        const re = new RegExp(pattern.replace("SYMBOL", escaped));
        if (re.test(snippet)) return { kind: "definition", symbolKind: kind };
      }
    }
  }

  for (const { pattern, kind } of GENERIC_DEFINITION_PATTERNS) {
    const re = new RegExp(pattern.replace("SYMBOL", escaped));
    if (re.test(snippet)) return { kind: "definition", symbolKind: kind };
  }

  return { kind: "reference", symbolKind: null };
}

export function classifyMatch(
  snippet: string,
  symbol: string,
  language?: string,
): "definition" | "reference" {
  return classifyMatchDetailed(snippet, symbol, language).kind;
}

export function rankLocations(
  locations: CodeNavLocation[],
  context: {
    sourceFilePath: string;
    changedFiles: string[];
    isTestFile: boolean;
  },
  cap = 50,
): { definitions: CodeNavLocation[]; references: CodeNavLocation[]; capped: boolean } {
  const capped = locations.length > cap;
  const changedSet = new Set(context.changedFiles);

  function score(loc: CodeNavLocation): number {
    let s = 0;

    if (loc.filePath === context.sourceFilePath) s += 1000;
    else if (changedSet.has(loc.filePath)) s += 500;
    else if (sameDirectory(loc.filePath, context.sourceFilePath)) s += 200;

    if (isTestFile(loc.filePath) && !context.isTestFile) s -= 300;

    if (loc.kind === "definition") s += 100;
    if (loc.confidence === "likely") s += 50;

    return s;
  }

  const sorted = [...locations].sort((a, b) => score(b) - score(a));
  const truncated = sorted.slice(0, cap);

  return {
    definitions: truncated.filter((l) => l.kind === "definition"),
    references: truncated.filter((l) => l.kind === "reference"),
    capped,
  };
}

export function extractChangedFiles(patch: string | null): string[] {
  if (!patch) return [];
  const set = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    set.add(m[1]);
    set.add(m[2]);
  }
  return [...set];
}

export function validateCodeNavRequest(
  body: unknown,
): string | null {
  if (!body || typeof body !== "object") return "Invalid request body";
  const b = body as Record<string, unknown>;

  if (typeof b.symbol !== "string" || !b.symbol.trim()) {
    return "Missing or empty symbol";
  }
  if (typeof b.filePath !== "string" || !b.filePath.trim()) {
    return "Missing filePath";
  }
  try {
    validateFilePath(b.filePath as string);
  } catch {
    return "Invalid filePath";
  }
  if (b.side !== "old" && b.side !== "new") {
    return "side must be 'old' or 'new'";
  }

  return null;
}

let rgAvailable: boolean | null = null;

export async function resolveCodeNav(
  runtime: CodeNavRuntime,
  request: CodeNavRequest,
  cwd: string,
  changedFiles: string[],
  /** Hover passes a shorter timeout than Cmd+click's 5s. */
  options?: { timeoutMs?: number },
): Promise<CodeNavResponse> {
  const start = Date.now();

  if (rgAvailable === null) {
    const check = await runtime.runCommand("rg", ["--version"], {
      cwd,
      timeoutMs: 2000,
    });
    rgAvailable = check.exitCode === 0;
  }

  if (!rgAvailable) {
    return {
      backend: "unavailable",
      complete: true,
      definitions: [],
      references: [],
      searchScope: "head",
      stats: { elapsedMs: Date.now() - start, capped: false },
    };
  }

  const args = buildRgArgs(request.symbol, request.language, request.filePath);

  const result = await runtime.runCommand("rg", args, {
    cwd,
    timeoutMs: options?.timeoutMs ?? 5000,
  });

  // Exit code 1 = no matches (normal), exit code 2 = error
  if (result.exitCode === 2) {
    return {
      backend: "search",
      complete: true,
      definitions: [],
      references: [],
      searchScope: "head",
      stats: { elapsedMs: Date.now() - start, capped: false },
    };
  }

  const locations = parseRgJsonOutput(
    result.stdout,
    request.symbol,
    request.language,
  ).filter((loc) => isCodeNavPathAllowed(loc.filePath, request.filePath));

  const ranked = rankLocations(locations, {
    sourceFilePath: request.filePath,
    changedFiles,
    isTestFile: isTestFile(request.filePath),
  });

  return {
    backend: "search",
    complete: true,
    definitions: ranked.definitions,
    references: ranked.references,
    searchScope: "head",
    stats: { elapsedMs: Date.now() - start, capped: ranked.capped },
  };
}

export function resetRgCache(): void {
  rgAvailable = null;
}

/** Mirrors rg's own `--max-filesize 1M`: never read what rg would not search. */
export const CODE_NAV_MAX_FILE_BYTES = 1024 * 1024;

/** A hover answer that arrives after this is worse than no answer at all. */
const HOVER_RG_TIMEOUT_MS = 3000;
const HOVER_REFERENCE_LIMIT = 5;
const SIGNATURE_MAX_CHARS = 300;
const SIGNATURE_READ_AHEAD_LINES = 2;
const DOC_MAX_LINES = 10;
const DOC_MAX_CHARS = 600;

function parenBalance(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

export function buildSignature(
  lines: string[],
  defLineIdx: number,
): { text: string; approximate: true } | null {
  const first = lines[defLineIdx];
  if (first === undefined) return null;

  let text = first.trim();
  if (!text) return null;

  for (
    let ahead = 1;
    ahead <= SIGNATURE_READ_AHEAD_LINES && parenBalance(text) > 0;
    ahead++
  ) {
    const next = lines[defLineIdx + ahead];
    if (next === undefined) break;
    text = `${text} ${next.trim()}`.trim();
  }

  if (text.length > SIGNATURE_MAX_CHARS) {
    text = text.slice(0, SIGNATURE_MAX_CHARS).trimEnd() + "…";
  }
  return { text, approximate: true };
}

function scanLineCommentRun(
  lines: string[],
  defLineIdx: number,
  prefixes: string[],
  skip: (trimmed: string) => boolean,
): string[] {
  let i = defLineIdx - 1;
  while (i >= 0 && skip(lines[i].trim())) i--;

  const collected: string[] = [];
  while (i >= 0 && collected.length < DOC_MAX_LINES + 1) {
    const trimmed = lines[i].trim();
    const prefix = prefixes.find((p) => trimmed.startsWith(p));
    if (!prefix) break;
    collected.unshift(trimmed.slice(prefix.length).trim());
    i--;
  }
  return collected;
}

function scanJsDocComment(lines: string[], defLineIdx: number): string[] {
  const above = lines[defLineIdx - 1];
  if (above === undefined) return [];

  if (above.trim().endsWith("*/")) {
    const block: string[] = [];
    let j = defLineIdx - 1;
    while (j >= 0 && block.length <= DOC_MAX_LINES + 2) {
      block.unshift(lines[j]);
      if (lines[j].trim().startsWith("/*")) break;
      j--;
    }
    // Only a real doc block (`/** … */`) counts; a plain `/* … */` is as
    // likely to be commented-out code as documentation.
    if (j < 0 || !block[0]?.trim().startsWith("/**")) return [];
    return block.map((line) =>
      line
        .trim()
        .replace(/^\/\*\*+/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*+/, "")
        .trim(),
    );
  }

  return scanLineCommentRun(lines, defLineIdx, ["//"], () => false);
}

function scanPythonDocstring(lines: string[], defLineIdx: number): string[] {
  const defLine = lines[defLineIdx] ?? "";
  if (/^\s*(?:async\s+)?(?:def|class)\b/.test(defLine)) {
    let i = defLineIdx + 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    const opening = lines[i]?.trim() ?? "";
    const quote = opening.startsWith('"""')
      ? '"""'
      : opening.startsWith("'''")
        ? "'''"
        : null;
    if (quote) {
      const head = opening.slice(quote.length);
      if (head.endsWith(quote)) {
        return [head.slice(0, -quote.length)];
      }
      const collected = [head];
      for (
        let j = i + 1;
        j < lines.length && collected.length <= DOC_MAX_LINES;
        j++
      ) {
        const closeAt = lines[j].indexOf(quote);
        if (closeAt >= 0) {
          collected.push(lines[j].slice(0, closeAt));
          break;
        }
        collected.push(lines[j]);
      }
      return collected;
    }
  }
  return scanLineCommentRun(lines, defLineIdx, ["#"], (t) => t.startsWith("@"));
}

/** Lines a linter, formatter or type checker addresses to a tool, never to a reader. */
const TOOLING_DIRECTIVE_PREFIXES = [
  "eslint-disable",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "prettier-ignore",
  "biome-ignore",
  "istanbul ignore",
  "noqa",
  "type: ignore",
];

function isToolingDirective(line: string): boolean {
  if (TOOLING_DIRECTIVE_PREFIXES.some((p) => line.startsWith(p))) return true;
  // Triple-slash directives survive `//` stripping as `/ <reference … />`.
  return /^\/*\s*<reference\b/.test(line);
}

/** Drop directives from both ends of the run, never the middle: the commonest position is the line directly above the definition (the trailing end), and cutting inside prose would mean interpreting it. */
function stripEdgeDirectives(lines: string[]): string[] {
  const isDroppable = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed === "" || isToolingDirective(trimmed);
  };

  let start = 0;
  while (start < lines.length && isDroppable(lines[start])) start++;

  let end = lines.length;
  while (end > start && isDroppable(lines[end - 1])) end--;

  return lines.slice(start, end);
}

function finishDoc(collectedLines: string[]): string | null {
  const collected = stripEdgeDirectives(collectedLines);
  const kept = collected.map((l) => l.trim()).filter((l) => l.length > 0);
  if (kept.length === 0) return null;
  // Rule bars, boxes and other decoration carry no letters. Returning nothing
  // always beats returning garbage.
  if (!kept.some((l) => /[A-Za-z]/.test(l))) return null;

  let truncated = kept.length > DOC_MAX_LINES;
  let text = kept.slice(0, DOC_MAX_LINES).join("\n");
  if (text.length > DOC_MAX_CHARS) {
    text = text.slice(0, DOC_MAX_CHARS).trimEnd();
    truncated = true;
  }
  return truncated ? `${text}…` : text;
}

/** Only the five languages `DEFINITION_PATTERNS` covers are scanned: a generic "comment characters above the line" rule reads shell here-docs, SQL banners and C preprocessor lines as prose, and a wrong doc paragraph is worse than none. Unknown languages return null. */
export function scanDocComment(
  lines: string[],
  defLineIdx: number,
  language?: string,
): string | null {
  if (defLineIdx < 0 || defLineIdx >= lines.length) return null;

  switch (language) {
    case "typescript":
    case "javascript":
      return finishDoc(scanJsDocComment(lines, defLineIdx));
    case "python":
      return finishDoc(scanPythonDocstring(lines, defLineIdx));
    case "go":
      return finishDoc(scanLineCommentRun(lines, defLineIdx, ["//"], () => false));
    case "rust":
      return finishDoc(
        scanLineCommentRun(lines, defLineIdx, ["///", "//!"], (t) =>
          t.startsWith("#["),
        ),
      );
    default:
      return null;
  }
}

async function readDefinitionFile(
  runtime: CodeNavRuntime,
  filePath: string,
  cwd: string,
): Promise<string[] | null> {
  if (!runtime.readFile) return null;
  try {
    validateFilePath(filePath);
  } catch {
    return null;
  }
  let content: string | null = null;
  try {
    content = await runtime.readFile(filePath, { cwd });
  } catch {
    return null;
  }
  if (content === null || content.length > CODE_NAV_MAX_FILE_BYTES) return null;
  return content.split("\n");
}

export async function resolveCodeNavHover(
  runtime: CodeNavRuntime,
  request: CodeNavRequest,
  cwd: string,
  changedFiles: string[],
): Promise<CodeNavHoverResponse> {
  const resolved = await resolveCodeNav(runtime, request, cwd, changedFiles, {
    timeoutMs: HOVER_RG_TIMEOUT_MS,
  });

  const base = {
    source: "search" as const,
    symbol: request.symbol,
    stats: { elapsedMs: resolved.stats.elapsedMs },
  };

  if (resolved.backend === "unavailable") {
    return {
      ...base,
      backend: "unavailable",
      definition: null,
      alternateDefinition: null,
      references: [],
      referenceCount: 0,
      capped: false,
    };
  }

  const references: CodeNavHoverReference[] = resolved.references
    .slice(0, HOVER_REFERENCE_LIMIT)
    .map(({ filePath, line, column, snippet }) => ({
      filePath,
      line,
      column,
      snippet,
    }));

  const [top, runnerUp] = resolved.definitions;
  let definition: CodeNavHoverDefinition | null = null;

  if (top) {
    const fileLines = await readDefinitionFile(runtime, top.filePath, cwd);
    const defLineIdx = top.line - 1;
    const signature = fileLines ? buildSignature(fileLines, defLineIdx) : null;

    definition = {
      filePath: top.filePath,
      line: top.line,
      column: top.column,
      confidence: top.confidence,
      symbolKind: classifyMatchDetailed(
        top.snippet,
        request.symbol,
        request.language,
      ).symbolKind,
      signature: signature?.text ?? null,
      signatureApproximate: signature !== null,
      doc: fileLines
        ? scanDocComment(fileLines, defLineIdx, request.language)
        : null,
      preview: null,
      otherCandidateCount: Math.max(0, resolved.definitions.length - 1),
    };
  }

  return {
    ...base,
    backend: "search",
    definition,
    alternateDefinition:
      resolved.definitions.length === 2 && runnerUp
        ? {
            filePath: runnerUp.filePath,
            line: runnerUp.line,
            column: runnerUp.column,
          }
        : null,
    references,
    referenceCount: resolved.references.length,
    capped: resolved.stats.capped,
  };
}
