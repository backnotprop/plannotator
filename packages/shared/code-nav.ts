/**
 * Search-based code navigation — shared types and pure logic.
 *
 * Runtime-agnostic: both Bun and Node servers provide their own
 * CodeNavRuntime implementation to run subprocess commands.
 */

function validateFilePath(filePath: string): void {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    throw new Error("Invalid file path");
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /**
   * Read one repo-relative file for hover enrichment. Optional so the vendored
   * type stays backward compatible and `/resolve` callers never provide it —
   * without it hover degrades to the definition location plus references.
   *
   * Implementations must return `null` (never throw) for a missing or
   * unreadable file, and for one larger than CODE_NAV_MAX_FILE_BYTES — the
   * ceiling rg itself searches under (`--max-filesize 1M`).
   */
  readFile?: (
    path: string,
    options?: { cwd?: string },
  ) => Promise<string | null>;
}

/**
 * What a definition regex matched. Tier 0 reads it off the pattern that fired;
 * later tiers fill it from an AST or an index.
 */
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
  /** Tier 0: from the matched def-regex. Tier 1+: AST / SCIP. */
  symbolKind: SymbolKind | null;
  /** Tier 0: the matched line plus a short read-ahead. Tier 1+: exact. */
  signature: string | null;
  /** True in Tier 0 — the card renders a "matched line" cue. */
  signatureApproximate: boolean;
  /** Tier 0: heuristic comment scan. Tier 1+: the real doc node. */
  doc: string | null;
  preview: { startLine: number; lines: string[] } | null;
  /** Ranked definitions beyond this one, within the search caps. */
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
  /** Tier 1 widens this to 'syntax', Tier 2 to 'index'. */
  source: "search";
  symbol: string;
  definition: CodeNavHoverDefinition | null;
  /**
   * The runner-up definition, present only when the search found EXACTLY two
   * candidates. Three or more means the top match is too weak to name a second
   * on the card, and the extras belong in the References panel.
   */
  alternateDefinition: CodeNavHoverLocation | null;
  references: CodeNavHoverReference[];
  referenceCount: number;
  capped: boolean;
  stats: { elapsedMs: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_NAV_IGNORED_GLOBS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "coverage",
  ".venv",
  ".pytest_cache",
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

// ---------------------------------------------------------------------------
// Definition patterns
// ---------------------------------------------------------------------------

/**
 * Each pattern carries the kind it proves. Alternations that used to span
 * several kinds (`const|let|var`, `interface|type`, go's optional receiver)
 * are split one-per-kind: the union of the patterns is unchanged, so
 * definition-vs-reference classification is identical, but a match now also
 * names WHAT was defined.
 */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// rg argument construction
// ---------------------------------------------------------------------------

export function buildRgArgs(symbol: string, language?: string): string[] {
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

  for (const dir of CODE_NAV_IGNORED_GLOBS) {
    args.push("--glob", `!${dir}`);
  }

  if (language) {
    const rgType = RG_TYPE_MAP[language];
    if (rgType) args.push("--type", rgType);
  }

  args.push("--word-regexp", "--", escapeRegex(symbol), ".");

  return args;
}

// ---------------------------------------------------------------------------
// rg JSON output parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Match classification
// ---------------------------------------------------------------------------

/**
 * Same decision as {@link classifyMatch}, but it also reports WHICH pattern
 * fired. The kind is free information the classifier already computed and
 * used to throw away; the hover card renders it as a badge.
 */
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

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Changed files extraction from unified diff patch
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

let rgAvailable: boolean | null = null;

export async function resolveCodeNav(
  runtime: CodeNavRuntime,
  request: CodeNavRequest,
  cwd: string,
  changedFiles: string[],
  /**
   * Additive: hover passes a shorter timeout than Cmd+click's 5s, because a
   * 5s hover answer is useless. `/resolve` keeps the original default.
   */
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

  const args = buildRgArgs(request.symbol, request.language);

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
  );

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

// ---------------------------------------------------------------------------
// Hover enrichment (Tier 0)
// ---------------------------------------------------------------------------

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

/**
 * The matched definition line, extended by a short balanced-paren read-ahead
 * when the signature obviously continues. Always approximate in Tier 0: it is
 * a line of source, not a parsed declaration.
 */
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

/** Contiguous run of line comments directly above the def, skipping `skip` lines. */
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
    // A blank line (or anything that is not a comment) breaks the association.
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
  // No docstring: fall back to a `#` run above, looking through decorators.
  return scanLineCommentRun(lines, defLineIdx, ["#"], (t) => t.startsWith("@"));
}

/**
 * Lines a linter, formatter or type checker addresses to a tool, never to a
 * reader. A comment run that opens with these is machine bookkeeping that
 * happens to sit above a definition, and rendering it as documentation is
 * exactly the "garbage over nothing" failure the scan exists to avoid.
 */
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

/**
 * Drop directives from BOTH ENDS of the run, never from the middle.
 *
 * Both ends, because the commonest real position for a directive is the line
 * immediately above the definition — which is the TRAILING end of the run as
 * collected — and a leading-only strip would leak it onto the end of the
 * paragraph. Never the middle, because a directive surrounded by prose sits
 * inside documentation whose shape we would have to interpret to cut safely.
 */
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

/**
 * Heuristic doc-comment scan around a definition line. Per-language and
 * deliberately narrow: an unknown language returns null rather than guessing,
 * and so does anything that scans to decoration or to tooling directives.
 *
 * Only the five languages `DEFINITION_PATTERNS` covers are scanned at all.
 * That is accepted, not an oversight: a generic "comment characters above the
 * line" rule reads shell here-docs, SQL banners and C preprocessor lines as
 * prose, and a wrong doc paragraph on the card is worse than none. Widening
 * this set means adding a language's real comment rules, not loosening these.
 */
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
      // godoc convention: the comment run directly above the declaration.
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

/**
 * The hover answer: the search pipeline `/resolve` already runs, plus the
 * three cheap enrichments the card needs. Every enrichment degrades to null on
 * its own — a definition location with no readable file still makes a card.
 */
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
      // Declared for a later tier, populated when a consumer exists: the card
      // renders the signature, so shipping source lines nothing reads is cost.
      preview: null,
      otherCandidateCount: Math.max(0, resolved.definitions.length - 1),
    };
  }

  return {
    ...base,
    backend: "search",
    definition,
    // Exactly two candidates: name the runner-up. Three or more and the top
    // match is too weak to name a second, so the extras stay in the panel.
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
