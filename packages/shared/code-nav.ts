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

interface DefinitionPatternSet {
  languages: string[];
  patterns: string[];
}

const DEFINITION_PATTERNS: DefinitionPatternSet[] = [
  {
    languages: ["typescript", "javascript"],
    patterns: [
      String.raw`(?:export\s+)?(?:async\s+)?function\s+SYMBOL\b`,
      String.raw`(?:export\s+)?(?:const|let|var)\s+SYMBOL\s*[=:]`,
      String.raw`(?:export\s+)?class\s+SYMBOL\b`,
      String.raw`(?:export\s+)?(?:interface|type)\s+SYMBOL\b`,
      String.raw`(?:export\s+)?enum\s+SYMBOL\b`,
      String.raw`^\s+(?:(?:async|static|readonly|get|set|private|protected|public)\s+)+SYMBOL\s*[(<:]`,
    ],
  },
  {
    languages: ["python"],
    patterns: [
      String.raw`(?:^|\s)def\s+SYMBOL\s*\(`,
      String.raw`(?:^|\s)class\s+SYMBOL\b`,
      String.raw`^SYMBOL\s*=`,
    ],
  },
  {
    languages: ["go"],
    patterns: [
      String.raw`func\s+(?:\([^)]+\)\s+)?SYMBOL\s*\(`,
      String.raw`type\s+SYMBOL\s`,
      String.raw`var\s+SYMBOL\s`,
    ],
  },
  {
    languages: ["rust"],
    patterns: [
      String.raw`(?:pub(?:\([^)]*\))?\s+)?fn\s+SYMBOL\b`,
      String.raw`(?:pub(?:\([^)]*\))?\s+)?struct\s+SYMBOL\b`,
      String.raw`(?:pub(?:\([^)]*\))?\s+)?enum\s+SYMBOL\b`,
      String.raw`(?:pub(?:\([^)]*\))?\s+)?trait\s+SYMBOL\b`,
      String.raw`(?:pub(?:\([^)]*\))?\s+)?type\s+SYMBOL\b`,
      String.raw`(?:pub(?:\([^)]*\))?\s+)?mod\s+SYMBOL\b`,
    ],
  },
];

const GENERIC_DEFINITION_PATTERNS: string[] = [
  String.raw`(?:function|def|func|fn|class|struct|enum|trait|interface|type)\s+SYMBOL\b`,
  String.raw`(?:const|let|var|val)\s+SYMBOL\s*[=:]`,
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

export function classifyMatch(
  snippet: string,
  symbol: string,
  language?: string,
): "definition" | "reference" {
  const escaped = escapeRegex(symbol);

  if (language) {
    const langPatterns = DEFINITION_PATTERNS.find((p) =>
      p.languages.includes(language),
    );
    if (langPatterns) {
      for (const pattern of langPatterns.patterns) {
        const re = new RegExp(pattern.replace("SYMBOL", escaped));
        if (re.test(snippet)) return "definition";
      }
    }
  }

  for (const pattern of GENERIC_DEFINITION_PATTERNS) {
    const re = new RegExp(pattern.replace("SYMBOL", escaped));
    if (re.test(snippet)) return "definition";
  }

  return "reference";
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
    timeoutMs: 5000,
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
