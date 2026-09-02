import { describe, expect, test } from "bun:test";
import {
  buildRgArgs,
  buildSignature,
  classifyMatch,
  classifyMatchDetailed,
  rankLocations,
  parseRgJsonOutput,
  resolveCodeNavHover,
  resetRgCache,
  scanDocComment,
  validateCodeNavRequest,
  extractChangedFiles,
  type CodeNavLocation,
  type CodeNavRuntime,
} from "./code-nav";

// ---------------------------------------------------------------------------
// classifyMatch
// ---------------------------------------------------------------------------

describe("classifyMatch", () => {
  describe("TypeScript/JavaScript", () => {
    const lang = "typescript";

    test("function declaration", () => {
      expect(classifyMatch("function startServer(", "startServer", lang)).toBe("definition");
    });

    test("async function declaration", () => {
      expect(classifyMatch("export async function startServer(", "startServer", lang)).toBe("definition");
    });

    test("export function", () => {
      expect(classifyMatch("export function handleRequest(", "handleRequest", lang)).toBe("definition");
    });

    test("const assignment", () => {
      expect(classifyMatch("const startServer = async () => {", "startServer", lang)).toBe("definition");
    });

    test("let assignment", () => {
      expect(classifyMatch("let counter = 0;", "counter", lang)).toBe("definition");
    });

    test("class declaration", () => {
      expect(classifyMatch("export class ReviewServer {", "ReviewServer", lang)).toBe("definition");
    });

    test("interface declaration", () => {
      expect(classifyMatch("export interface CodeNavRequest {", "CodeNavRequest", lang)).toBe("definition");
    });

    test("type declaration", () => {
      expect(classifyMatch("type DiffType = 'unified' | 'split';", "DiffType", lang)).toBe("definition");
    });

    test("enum declaration", () => {
      expect(classifyMatch("enum Status {", "Status", lang)).toBe("definition");
    });

    test("method in class/object", () => {
      expect(classifyMatch("  async handleRequest(", "handleRequest", lang)).toBe("definition");
    });

    test("plain reference (function call)", () => {
      expect(classifyMatch("  const result = startServer(config);", "startServer", lang)).toBe("reference");
    });

    test("bare indented call is not a definition", () => {
      expect(classifyMatch("  startServer(config);", "startServer", lang)).toBe("reference");
    });

    test("indented call in if/return is not a definition", () => {
      expect(classifyMatch("    return startServer(config);", "startServer", lang)).toBe("reference");
    });

    test("plain reference (import)", () => {
      expect(classifyMatch('import { startServer } from "./server";', "startServer", lang)).toBe("reference");
    });

    test("const with type annotation", () => {
      expect(classifyMatch("const runtime: CodeNavRuntime = {", "runtime", lang)).toBe("definition");
    });
  });

  describe("Python", () => {
    const lang = "python";

    test("def function", () => {
      expect(classifyMatch("def handle_request(self, req):", "handle_request", lang)).toBe("definition");
    });

    test("class declaration", () => {
      expect(classifyMatch("class ReviewServer:", "ReviewServer", lang)).toBe("definition");
    });

    test("top-level assignment", () => {
      expect(classifyMatch("DEFAULT_PORT = 8080", "DEFAULT_PORT", lang)).toBe("definition");
    });

    test("plain reference", () => {
      expect(classifyMatch("  server = ReviewServer()", "ReviewServer", lang)).toBe("reference");
    });
  });

  describe("Go", () => {
    const lang = "go";

    test("func declaration", () => {
      expect(classifyMatch("func StartServer(config Config) error {", "StartServer", lang)).toBe("definition");
    });

    test("method declaration", () => {
      expect(classifyMatch("func (s *Server) StartServer() error {", "StartServer", lang)).toBe("definition");
    });

    test("type declaration", () => {
      expect(classifyMatch("type Config struct {", "Config", lang)).toBe("definition");
    });

    test("plain reference", () => {
      expect(classifyMatch("  err := StartServer(cfg)", "StartServer", lang)).toBe("reference");
    });
  });

  describe("Rust", () => {
    const lang = "rust";

    test("fn declaration", () => {
      expect(classifyMatch("fn start_server() -> Result<()> {", "start_server", lang)).toBe("definition");
    });

    test("pub fn declaration", () => {
      expect(classifyMatch("pub fn start_server(config: Config) {", "start_server", lang)).toBe("definition");
    });

    test("struct declaration", () => {
      expect(classifyMatch("pub struct Config {", "Config", lang)).toBe("definition");
    });

    test("enum declaration", () => {
      expect(classifyMatch("pub enum Status {", "Status", lang)).toBe("definition");
    });

    test("trait declaration", () => {
      expect(classifyMatch("pub trait Handler {", "Handler", lang)).toBe("definition");
    });

    test("plain reference", () => {
      expect(classifyMatch("  let server = start_server(config);", "start_server", lang)).toBe("reference");
    });
  });

  describe("generic fallback", () => {
    test("function keyword (unknown language)", () => {
      expect(classifyMatch("function startServer(", "startServer")).toBe("definition");
    });

    test("class keyword (unknown language)", () => {
      expect(classifyMatch("class MyClass {", "MyClass")).toBe("definition");
    });

    test("const keyword (unknown language)", () => {
      expect(classifyMatch("const PORT = 8080;", "PORT")).toBe("definition");
    });

    test("no definition pattern matches", () => {
      expect(classifyMatch("  startServer(config);", "startServer")).toBe("reference");
    });
  });

  describe("edge cases", () => {
    test("regex metacharacter in symbol ($)", () => {
      expect(classifyMatch("const $el = document.querySelector('div');", "$el", "typescript")).toBe("definition");
    });

    test("regex metacharacter in symbol (.)", () => {
      expect(classifyMatch("  obj.method();", "obj.method")).toBe("reference");
    });
  });
});

// ---------------------------------------------------------------------------
// rankLocations
// ---------------------------------------------------------------------------

describe("rankLocations", () => {
  function loc(overrides: Partial<CodeNavLocation>): CodeNavLocation {
    return {
      kind: "reference",
      confidence: "possible",
      filePath: "src/other.ts",
      line: 1,
      column: 0,
      snippet: "some code",
      ...overrides,
    };
  }

  test("same file ranks first", () => {
    const locations = [
      loc({ filePath: "src/other.ts", line: 10 }),
      loc({ filePath: "src/main.ts", line: 5 }),
    ];
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: [],
      isTestFile: false,
    });
    expect(result.references[0].filePath).toBe("src/main.ts");
  });

  test("changed files rank above non-changed", () => {
    const locations = [
      loc({ filePath: "lib/utils.ts" }),
      loc({ filePath: "src/changed.ts" }),
    ];
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: ["src/changed.ts"],
      isTestFile: false,
    });
    expect(result.references[0].filePath).toBe("src/changed.ts");
  });

  test("definitions rank above references in same tier", () => {
    const locations = [
      loc({ filePath: "src/a.ts", kind: "reference" }),
      loc({ filePath: "src/a.ts", kind: "definition", confidence: "likely" }),
    ];
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: [],
      isTestFile: false,
    });
    expect(result.definitions).toHaveLength(1);
    expect(result.references).toHaveLength(1);
  });

  test("test files demoted when source is not a test", () => {
    const locations = [
      loc({ filePath: "src/__tests__/main.test.ts", kind: "reference" }),
      loc({ filePath: "src/utils.ts", kind: "reference" }),
    ];
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: [],
      isTestFile: false,
    });
    expect(result.references[0].filePath).toBe("src/utils.ts");
  });

  test("test files NOT demoted when source is a test", () => {
    const locations = [
      loc({ filePath: "src/__tests__/main.test.ts", kind: "reference" }),
      loc({ filePath: "src/utils.ts", kind: "reference" }),
    ];
    const result = rankLocations(locations, {
      sourceFilePath: "src/__tests__/other.test.ts",
      changedFiles: [],
      isTestFile: true,
    });
    expect(result.references[0].filePath).toBe("src/__tests__/main.test.ts");
  });

  test("caps results", () => {
    const locations = Array.from({ length: 100 }, (_, i) =>
      loc({ filePath: `src/file${i}.ts`, line: i }),
    );
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: [],
      isTestFile: false,
    }, 10);
    expect(result.references).toHaveLength(10);
    expect(result.capped).toBe(true);
  });

  test("not capped when under limit", () => {
    const locations = [loc({}), loc({})];
    const result = rankLocations(locations, {
      sourceFilePath: "src/main.ts",
      changedFiles: [],
      isTestFile: false,
    });
    expect(result.capped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRgArgs
// ---------------------------------------------------------------------------

describe("buildRgArgs", () => {
  test("includes --json flag", () => {
    const args = buildRgArgs("mySymbol");
    expect(args).toContain("--json");
  });

  test("includes --word-regexp", () => {
    const args = buildRgArgs("mySymbol");
    expect(args).toContain("--word-regexp");
  });

  test("includes glob exclusions for node_modules", () => {
    const args = buildRgArgs("mySymbol");
    const nodeModulesIdx = args.indexOf("!node_modules");
    expect(nodeModulesIdx).toBeGreaterThan(-1);
  });

  test("escapes regex metacharacters", () => {
    const args = buildRgArgs("$scope");
    const patternIdx = args.indexOf("--") + 1;
    expect(args[patternIdx]).toContain("\\$scope");
  });

  test("includes max-count", () => {
    const args = buildRgArgs("x");
    const idx = args.indexOf("--max-count");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("50");
  });

  test("searches from current directory", () => {
    const args = buildRgArgs("x");
    expect(args[args.length - 1]).toBe(".");
  });

  test("adds --type filter for known language", () => {
    const args = buildRgArgs("x", "typescript");
    const typeIdx = args.indexOf("--type");
    expect(typeIdx).toBeGreaterThan(-1);
    expect(args[typeIdx + 1]).toBe("ts");
  });

  test("no --type filter for unknown language", () => {
    const args = buildRgArgs("x", "brainfuck");
    expect(args).not.toContain("--type");
  });

  test("no --type filter when language is undefined", () => {
    const args = buildRgArgs("x");
    expect(args).not.toContain("--type");
  });
});

// ---------------------------------------------------------------------------
// parseRgJsonOutput
// ---------------------------------------------------------------------------

describe("parseRgJsonOutput", () => {
  test("parses match lines", () => {
    const lines = [
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/server.ts" },
          lines: { text: "export function startServer() {\n" },
          line_number: 42,
          submatches: [{ start: 16, end: 27, match: { text: "startServer" } }],
        },
      }),
      JSON.stringify({ type: "summary", data: {} }),
    ].join("\n");

    const result = parseRgJsonOutput(lines, "startServer", "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/server.ts");
    expect(result[0].line).toBe(42);
    expect(result[0].column).toBe(16);
    expect(result[0].kind).toBe("definition");
    expect(result[0].confidence).toBe("likely");
  });

  test("classifies references correctly", () => {
    const lines = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/index.ts" },
        lines: { text: "  const s = startServer();\n" },
        line_number: 10,
        submatches: [{ start: 14, end: 25, match: { text: "startServer" } }],
      },
    });

    const result = parseRgJsonOutput(lines, "startServer", "typescript");
    expect(result[0].kind).toBe("reference");
    expect(result[0].confidence).toBe("possible");
  });

  test("skips non-JSON lines", () => {
    const result = parseRgJsonOutput("not json\n\n", "x");
    expect(result).toHaveLength(0);
  });

  test("strips leading ./ from file paths", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "./src/server.ts" },
        lines: { text: "  startServer();\n" },
        line_number: 10,
        submatches: [{ start: 2, end: 13, match: { text: "startServer" } }],
      },
    });
    const result = parseRgJsonOutput(line, "startServer");
    expect(result[0].filePath).toBe("src/server.ts");
  });

  test("skips non-match type lines", () => {
    const line = JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } });
    const result = parseRgJsonOutput(line, "x");
    expect(result).toHaveLength(0);
  });

  test("truncates long snippets", () => {
    const longLine = "x".repeat(300);
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "a.ts" },
        lines: { text: longLine },
        line_number: 1,
        submatches: [{ start: 0, end: 1 }],
      },
    });
    const result = parseRgJsonOutput(line, "x");
    expect(result[0].snippet.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// validateCodeNavRequest
// ---------------------------------------------------------------------------

describe("validateCodeNavRequest", () => {
  const valid = {
    symbol: "startServer",
    filePath: "src/server.ts",
    line: 42,
    charStart: 10,
    side: "new" as const,
    language: "typescript",
  };

  test("accepts valid request", () => {
    expect(validateCodeNavRequest(valid)).toBeNull();
  });

  test("rejects null body", () => {
    expect(validateCodeNavRequest(null)).toBe("Invalid request body");
  });

  test("rejects empty symbol", () => {
    expect(validateCodeNavRequest({ ...valid, symbol: "" })).toBe("Missing or empty symbol");
  });

  test("rejects missing filePath", () => {
    expect(validateCodeNavRequest({ ...valid, filePath: "" })).toBe("Missing filePath");
  });

  test("rejects directory traversal", () => {
    expect(validateCodeNavRequest({ ...valid, filePath: "../etc/passwd" })).toBe("Invalid filePath");
  });

  test("rejects absolute path", () => {
    expect(validateCodeNavRequest({ ...valid, filePath: "/etc/passwd" })).toBe("Invalid filePath");
  });

  test("rejects invalid side", () => {
    expect(validateCodeNavRequest({ ...valid, side: "both" })).toBe("side must be 'old' or 'new'");
  });
});

// ---------------------------------------------------------------------------
// extractChangedFiles
// ---------------------------------------------------------------------------

describe("extractChangedFiles", () => {
  test("extracts paths from unified diff", () => {
    const patch = `diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,3 @@
diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts`;

    const result = extractChangedFiles(patch);
    expect(result).toEqual(["src/server.ts", "src/utils.ts"]);
  });

  test("extracts both old and new paths for renames", () => {
    const patch = `diff --git a/src/oldName.ts b/src/newName.ts
similarity index 95%
rename from src/oldName.ts
rename to src/newName.ts`;

    const result = extractChangedFiles(patch);
    expect(result).toContain("src/oldName.ts");
    expect(result).toContain("src/newName.ts");
  });

  test("deduplicates when paths are the same", () => {
    const patch = `diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts`;

    const result = extractChangedFiles(patch);
    expect(result).toEqual(["src/server.ts"]);
  });

  test("returns empty for null patch", () => {
    expect(extractChangedFiles(null)).toEqual([]);
  });

  test("returns empty for empty string", () => {
    expect(extractChangedFiles("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyMatchDetailed — the kind the classifier used to discard
// ---------------------------------------------------------------------------

describe("classifyMatchDetailed", () => {
  // One case per kind the tables can produce. A pattern-table edit that
  // silently reclassifies (splitting `const|let|var` the wrong way, dropping
  // go's receiver form) fails here rather than shipping a wrong badge.
  const cases: Array<[string, string, string | undefined, string | null]> = [
    ["export function charge(amount) {", "charge", "typescript", "function"],
    ["const MAX_ATTEMPTS = 3;", "MAX_ATTEMPTS", "typescript", "const"],
    ["let attempts = 0;", "attempts", "typescript", "variable"],
    ["export class Gateway {", "Gateway", "typescript", "class"],
    ["export interface Payment {", "Payment", "typescript", "interface"],
    ["export type Money = number;", "Money", "typescript", "type"],
    ["enum Status {", "Status", "typescript", "enum"],
    ["  private charge(amount: number) {", "charge", "typescript", "method"],
    ["def charge(amount):", "charge", "python", "function"],
    ["class Gateway:", "Gateway", "python", "class"],
    ["MAX_ATTEMPTS = 3", "MAX_ATTEMPTS", "python", "variable"],
    ["func Charge(amount int) error {", "Charge", "go", "function"],
    ["func (g *Gateway) Charge(amount int) error {", "Charge", "go", "method"],
    ["type Gateway struct {", "Gateway", "go", "type"],
    ["pub fn charge(amount: u64) {", "charge", "rust", "function"],
    ["pub struct Gateway {", "Gateway", "rust", "struct"],
    ["pub trait Payable {", "Payable", "rust", "trait"],
    ["pub mod retry;", "retry", "rust", "module"],
    // Generic fallback keeps working for languages with no table.
    ["fn charge(amount) {", "charge", undefined, "function"],
    ["charge(42);", "charge", "typescript", null],
  ];

  for (const [snippet, symbol, language, symbolKind] of cases) {
    test(`${language ?? "generic"}: ${snippet.trim()}`, () => {
      const result = classifyMatchDetailed(snippet, symbol, language);
      expect(result.symbolKind).toBe(symbolKind as never);
      expect(result.kind).toBe(symbolKind === null ? "reference" : "definition");
      // The thin wrapper must keep agreeing with the detailed classifier.
      expect(classifyMatch(snippet, symbol, language)).toBe(result.kind);
    });
  }
});

// ---------------------------------------------------------------------------
// scanDocComment — conservative by construction
// ---------------------------------------------------------------------------

describe("scanDocComment", () => {
  test("typescript: JSDoc block directly above the definition", () => {
    const lines = [
      "/**",
      " * Charges the card.",
      " * Idempotent when a key is supplied.",
      " */",
      "export function charge(amount, key) {",
    ];
    expect(scanDocComment(lines, 4, "typescript")).toBe(
      "Charges the card.\nIdempotent when a key is supplied.",
    );
  });

  test("typescript: contiguous // run directly above", () => {
    const lines = ["// Charges the card.", "// Retries on 5xx.", "function charge() {}"];
    expect(scanDocComment(lines, 2, "javascript")).toBe(
      "Charges the card.\nRetries on 5xx.",
    );
  });

  test("typescript: a plain /* */ block is not documentation", () => {
    const lines = ["/*", " * charge(1)", " */", "function charge() {}"];
    expect(scanDocComment(lines, 3, "typescript")).toBeNull();
  });

  test("python: the docstring below wins over a # run above", () => {
    const lines = [
      "# internal helper",
      "def charge(amount):",
      '    """Charge the card."""',
      "    pass",
    ];
    expect(scanDocComment(lines, 1, "python")).toBe("Charge the card.");
  });

  test("python: decorators between a # run and the def do not break it", () => {
    const lines = ["# Charge the card.", "@retry(3)", "@traced", "def charge(amount):", "    pass"];
    expect(scanDocComment(lines, 3, "python")).toBe("Charge the card.");
  });

  test("python: multi-line docstring is collected to its closing quotes", () => {
    const lines = [
      "def charge(amount):",
      "    '''",
      "    Charge the card.",
      "    Raises on decline.",
      "    '''",
      "    pass",
    ];
    expect(scanDocComment(lines, 0, "python")).toBe(
      "Charge the card.\nRaises on decline.",
    );
  });

  test("go: the godoc run above the declaration", () => {
    const lines = ["// Charge bills the card.", "func Charge(amount int) error {"];
    expect(scanDocComment(lines, 1, "go")).toBe("Charge bills the card.");
  });

  test("rust: /// run above, looking through #[attr] lines", () => {
    const lines = [
      "/// Charge the card.",
      "#[inline]",
      "#[allow(dead_code)]",
      "pub fn charge(amount: u64) {",
    ];
    expect(scanDocComment(lines, 3, "rust")).toBe("Charge the card.");
  });

  test("rust: a plain // comment is not a doc comment", () => {
    const lines = ["// scratch note", "pub fn charge(amount: u64) {"];
    expect(scanDocComment(lines, 1, "rust")).toBeNull();
  });

  test("a blank line between comment and definition breaks the association", () => {
    const lines = ["// Charges the card.", "", "function charge() {}"];
    expect(scanDocComment(lines, 2, "typescript")).toBeNull();
  });

  test("unknown or absent language never guesses", () => {
    const lines = ["// Charges the card.", "sub charge {"];
    expect(scanDocComment(lines, 1, "perl")).toBeNull();
    expect(scanDocComment(lines, 1, undefined)).toBeNull();
  });

  // Tooling directives are addressed to a linter, never to a reader. Left in,
  // they become the card's doc paragraph — the exact "garbage over nothing"
  // failure this scan exists to prevent, and the most common comment line
  // sitting directly above a definition in a real codebase.
  test("a lone tooling directive is not documentation", () => {
    const cases: Array<[string[], string | undefined]> = [
      [["// eslint-disable-next-line no-console", "function charge() {}"], "typescript"],
      [["// eslint-disable-line @typescript-eslint/no-explicit-any", "function charge() {}"], "typescript"],
      [["// @ts-expect-error upstream types are wrong", "function charge() {}"], "typescript"],
      [["// @ts-ignore", "function charge() {}"], "typescript"],
      [["// @ts-nocheck", "function charge() {}"], "typescript"],
      [["// prettier-ignore", "function charge() {}"], "typescript"],
      [["// biome-ignore lint/suspicious/noExplicitAny: legacy", "function charge() {}"], "typescript"],
      [["/* istanbul ignore next */", "function charge() {}"], "typescript"],
      [["/// <reference types=\"node\" />", "function charge() {}"], "typescript"],
      [["# noqa: E501", "def charge(amount):", "    pass"], "python"],
      [["# type: ignore[arg-type]", "def charge(amount):", "    pass"], "python"],
      [["// istanbul ignore next", "func Charge() {}"], "go"],
    ];
    for (const [lines, language] of cases) {
      expect(scanDocComment(lines, lines.length - (language === "python" ? 2 : 1), language)).toBeNull();
    }
  });

  test("a directive above real prose is dropped, the prose survives", () => {
    const lines = [
      "// eslint-disable-next-line no-console",
      "// @ts-expect-error",
      "// Charges the card.",
      "// Retries on 5xx.",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 4, "typescript")).toBe(
      "Charges the card.\nRetries on 5xx.",
    );
  });

  test("a directive below the prose is dropped too, and only it", () => {
    // The commonest real position: the directive sits on the line directly
    // above the definition, which is the TRAILING end of the collected run.
    // A leading-only strip would leak it onto the end of the paragraph.
    const lines = [
      "// Charges the card.",
      "// Retries on 5xx.",
      "// eslint-disable-next-line no-console",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 3, "typescript")).toBe(
      "Charges the card.\nRetries on 5xx.",
    );
  });

  test("directives at both ends are dropped, prose between them survives", () => {
    const lines = [
      "// @ts-nocheck",
      "// Charges the card.",
      "// prettier-ignore",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 3, "typescript")).toBe("Charges the card.");
  });

  test("a directive between two sentences is left alone", () => {
    // Only the ends are trimmed: cutting inside prose would mean deciding
    // what the surrounding sentences meant.
    const lines = [
      "// Charges the card.",
      "// eslint-disable-next-line no-console",
      "// Retries on 5xx.",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 3, "typescript")).toBe(
      "Charges the card.\neslint-disable-next-line no-console\nRetries on 5xx.",
    );
  });

  test("a JSDoc block whose body is only directives yields nothing", () => {
    const lines = [
      "/**",
      " * eslint-disable no-console",
      " * @ts-nocheck",
      " */",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 4, "typescript")).toBeNull();
  });

  test("prose that merely mentions a directive is untouched", () => {
    // Only a LEADING run of directives is stripped, and only lines that ARE
    // one: a sentence about eslint is still documentation.
    const lines = [
      "// Callers must keep the eslint-disable in sync with this list.",
      "function charge() {}",
    ];
    expect(scanDocComment(lines, 1, "typescript")).toBe(
      "Callers must keep the eslint-disable in sync with this list.",
    );
  });

  test("decoration with no letters is rejected", () => {
    const lines = ["// ----------------", "// ================", "function charge() {}"];
    expect(scanDocComment(lines, 2, "typescript")).toBeNull();
  });

  test("caps at 10 lines and marks the truncation", () => {
    const comment = Array.from({ length: 14 }, (_, i) => `// line ${i + 1}`);
    const result = scanDocComment([...comment, "function charge() {}"], 14, "typescript");
    expect(result).not.toBeNull();
    expect(result!.split("\n")).toHaveLength(10);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("caps at 600 characters", () => {
    const lines = [`// ${"a".repeat(900)}`, "function charge() {}"];
    const result = scanDocComment(lines, 1, "typescript");
    expect(result!.length).toBe(601); // 600 + the truncation marker
  });

  test("an out-of-range definition line scans nothing", () => {
    expect(scanDocComment(["function charge() {}"], 9, "typescript")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSignature — bounded read-ahead
// ---------------------------------------------------------------------------

describe("buildSignature", () => {
  test("a balanced line is the signature on its own", () => {
    const lines = ["export function charge(amount, key) {", "  return 1;"];
    expect(buildSignature(lines, 0)).toEqual({
      text: "export function charge(amount, key) {",
      approximate: true,
    });
  });

  test("reads ahead until the parens balance", () => {
    const lines = ["function charge(", "  amount,", ") {"];
    expect(buildSignature(lines, 0)?.text).toBe("function charge( amount, ) {");
  });

  test("stops after two read-ahead lines even when unbalanced", () => {
    const lines = ["function charge(", "  a,", "  b,", "  c,", ") {"];
    // Unbounded read-ahead would swallow the rest of the file.
    expect(buildSignature(lines, 0)?.text).toBe("function charge( a, b,");
  });

  test("caps at 300 characters", () => {
    const result = buildSignature([`const x = "${"y".repeat(500)}";`], 0);
    expect(result!.text.length).toBe(301); // 300 + the truncation marker
  });

  test("a blank or missing line has no signature", () => {
    expect(buildSignature(["   "], 0)).toBeNull();
    expect(buildSignature([], 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveCodeNavHover
// ---------------------------------------------------------------------------

function rgMatch(filePath: string, line: number, text: string, start = 0): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: filePath },
      lines: { text },
      line_number: line,
      submatches: [{ start, end: start + 6 }],
    },
  });
}

function stubRuntime(stdout: string, files?: Record<string, string>): CodeNavRuntime {
  return {
    async runCommand(_command, args) {
      if (args[0] === "--version") return { stdout: "rg 14", stderr: "", exitCode: 0 };
      return { stdout, stderr: "", exitCode: 0 };
    },
    ...(files ? { readFile: async (path: string) => files[path] ?? null } : {}),
  };
}

const HOVER_REQUEST = {
  symbol: "charge",
  filePath: "src/pay.js",
  line: 4,
  charStart: 16,
  side: "new" as const,
  language: "javascript",
};

describe("resolveCodeNavHover", () => {
  test("enriches the top definition from the file the runtime reads", async () => {
    resetRgCache();
    const source = [
      "// Charges the card.",
      "export function charge(amount, key) {",
      "  return 1;",
      "}",
    ].join("\n");
    const runtime = stubRuntime(
      [
        rgMatch("./src/pay.js", 2, "export function charge(amount, key) {", 16),
        rgMatch("./src/checkout.js", 12, "  charge(total);", 2),
        rgMatch("./src/queue.js", 19, "  charge(total);", 2),
      ].join("\n"),
      { "src/pay.js": source },
    );

    const result = await resolveCodeNavHover(runtime, HOVER_REQUEST, "/repo", []);

    expect(result.backend).toBe("search");
    expect(result.source).toBe("search");
    expect(result.symbol).toBe("charge");
    expect(result.definition).not.toBeNull();
    expect(result.definition!.filePath).toBe("src/pay.js");
    expect(result.definition!.line).toBe(2);
    expect(result.definition!.symbolKind).toBe("function");
    expect(result.definition!.signature).toBe("export function charge(amount, key) {");
    expect(result.definition!.signatureApproximate).toBe(true);
    expect(result.definition!.doc).toBe("Charges the card.");
    // Declared in the shape for a later tier, deliberately unpopulated: the
    // card renders the signature, so source lines nothing reads are pure cost.
    expect(result.definition!.preview).toBeNull();
    expect(result.definition!.otherCandidateCount).toBe(0);
    expect(result.alternateDefinition).toBeNull();
    expect(result.references).toHaveLength(2);
    expect(result.referenceCount).toBe(2);
    expect(result.capped).toBe(false);
  });

  test("a runtime without readFile keeps the definition and drops the enrichments", async () => {
    resetRgCache();
    const runtime = stubRuntime(
      rgMatch("./src/pay.js", 2, "export function charge(amount, key) {", 16),
    );

    const result = await resolveCodeNavHover(runtime, HOVER_REQUEST, "/repo", []);

    expect(result.definition!.line).toBe(2);
    expect(result.definition!.symbolKind).toBe("function");
    expect(result.definition!.signature).toBeNull();
    expect(result.definition!.signatureApproximate).toBe(false);
    expect(result.definition!.doc).toBeNull();
    expect(result.definition!.preview).toBeNull();
  });

  test("names the runner-up at exactly two candidates, and never beyond", async () => {
    resetRgCache();
    const two = stubRuntime(
      [
        rgMatch("./src/pay.js", 2, "function charge(a) {", 9),
        rgMatch("./src/legacy.js", 31, "function charge(a) {", 9),
      ].join("\n"),
    );
    const twoResult = await resolveCodeNavHover(two, HOVER_REQUEST, "/repo", []);
    expect(twoResult.alternateDefinition).toEqual({
      filePath: "src/legacy.js",
      line: 31,
      column: 9,
    });
    expect(twoResult.definition!.otherCandidateCount).toBe(1);

    resetRgCache();
    const three = stubRuntime(
      [
        rgMatch("./src/pay.js", 2, "function charge(a) {", 9),
        rgMatch("./src/legacy.js", 31, "function charge(a) {", 9),
        rgMatch("./src/old.js", 7, "function charge(a) {", 9),
      ].join("\n"),
    );
    const threeResult = await resolveCodeNavHover(three, HOVER_REQUEST, "/repo", []);
    expect(threeResult.definition).not.toBeNull();
    expect(threeResult.alternateDefinition).toBeNull();
    expect(threeResult.definition!.otherCandidateCount).toBe(2);
  });

  test("references are sampled at five while the count stays honest", async () => {
    resetRgCache();
    const refs = Array.from({ length: 8 }, (_, i) =>
      rgMatch(`./src/f${i}.js`, i + 1, "  charge(total);", 2),
    );
    const runtime = stubRuntime(refs.join("\n"));

    const result = await resolveCodeNavHover(runtime, HOVER_REQUEST, "/repo", []);

    expect(result.definition).toBeNull();
    expect(result.references).toHaveLength(5);
    expect(result.referenceCount).toBe(8);
  });

  test("an unavailable backend answers empty rather than failing", async () => {
    resetRgCache();
    const runtime: CodeNavRuntime = {
      async runCommand() {
        return { stdout: "", stderr: "not found", exitCode: 1 };
      },
    };

    const result = await resolveCodeNavHover(runtime, HOVER_REQUEST, "/repo", []);

    expect(result.backend).toBe("unavailable");
    expect(result.source).toBe("search");
    expect(result.definition).toBeNull();
    expect(result.references).toEqual([]);
    expect(result.referenceCount).toBe(0);
    resetRgCache();
  });
});
