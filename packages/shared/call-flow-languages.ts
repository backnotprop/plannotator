import { parseDiffFilePathLines, parseDiffGitHeader } from "./diff-paths";

/** Stable identifier for one CallDiff language family. */
export type CallFlowLanguageId =
  | "javascript-typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "kotlin"
  | "swift"
  | "scala"
  | "lua"
  | "elixir"
  | "bash"
  | "haskell"
  | "zig"
  | "solidity"
  | "ocaml";

export const CALL_FLOW_CORE_LANGUAGE_ID: CallFlowLanguageId = "javascript-typescript";

export interface CallFlowLanguageDefinition {
  readonly id: CallFlowLanguageId;
  readonly label: string;
  readonly extensions: readonly string[];
  /** Core ships with CallDiff; packs are independently installable. */
  readonly kind: "core" | "pack";
  readonly packageName?: string;
  readonly packageVersion?: string;
  /** Measured, pruned installed bytes rounded up for honest UI estimates. */
  readonly installSizeBytes: number;
}

const MB = 1024 * 1024;

/**
 * CallDiff 0.4.1's supported extensions and pinned grammar packages.
 *
 * Size estimates describe Plannotator's pruned managed artifacts, not the
 * much larger npm tarball expansion. They are deliberately rounded up and
 * are re-measured whenever a grammar pin or pruning rule changes.
 */
export const CALL_FLOW_LANGUAGES = [
  { id: "javascript-typescript", label: "JavaScript and TypeScript", extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"], kind: "core", installSizeBytes: 5 * MB },
  { id: "python", label: "Python", extensions: [".py"], kind: "pack", packageName: "tree-sitter-python", packageVersion: "0.25.0", installSizeBytes: 1 * MB },
  { id: "go", label: "Go", extensions: [".go"], kind: "pack", packageName: "tree-sitter-go", packageVersion: "0.25.0", installSizeBytes: 1 * MB },
  { id: "rust", label: "Rust", extensions: [".rs"], kind: "pack", packageName: "tree-sitter-rust", packageVersion: "0.24.0", installSizeBytes: 2 * MB },
  { id: "java", label: "Java", extensions: [".java"], kind: "pack", packageName: "tree-sitter-java", packageVersion: "0.23.5", installSizeBytes: 1 * MB },
  { id: "ruby", label: "Ruby", extensions: [".rb"], kind: "pack", packageName: "tree-sitter-ruby", packageVersion: "0.23.1", installSizeBytes: 3 * MB },
  { id: "c", label: "C", extensions: [".c", ".h"], kind: "pack", packageName: "tree-sitter-c", packageVersion: "0.24.1", installSizeBytes: 1 * MB },
  { id: "cpp", label: "C++", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh"], kind: "pack", packageName: "tree-sitter-cpp", packageVersion: "0.23.4", installSizeBytes: 4 * MB },
  { id: "csharp", label: "C#", extensions: [".cs"], kind: "pack", packageName: "tree-sitter-c-sharp", packageVersion: "0.23.1", installSizeBytes: 6 * MB },
  { id: "php", label: "PHP", extensions: [".php"], kind: "pack", packageName: "tree-sitter-php", packageVersion: "0.24.2", installSizeBytes: 17 * MB },
  { id: "kotlin", label: "Kotlin", extensions: [".kt", ".kts"], kind: "pack", packageName: "tree-sitter-kotlin", packageVersion: "0.3.8", installSizeBytes: 4 * MB },
  { id: "swift", label: "Swift", extensions: [".swift"], kind: "pack", packageName: "tree-sitter-swift", packageVersion: "0.7.1", installSizeBytes: 4 * MB },
  { id: "scala", label: "Scala", extensions: [".scala"], kind: "pack", packageName: "tree-sitter-scala", packageVersion: "0.24.0", installSizeBytes: 4 * MB },
  { id: "lua", label: "Lua", extensions: [".lua"], kind: "pack", packageName: "@tree-sitter-grammars/tree-sitter-lua", packageVersion: "0.2.0", installSizeBytes: 1 * MB },
  { id: "elixir", label: "Elixir", extensions: [".ex", ".exs"], kind: "pack", packageName: "tree-sitter-elixir", packageVersion: "0.3.5", installSizeBytes: 2 * MB },
  { id: "bash", label: "Bash", extensions: [".sh", ".bash"], kind: "pack", packageName: "tree-sitter-bash", packageVersion: "0.25.1", installSizeBytes: 2 * MB },
  { id: "haskell", label: "Haskell", extensions: [".hs"], kind: "pack", packageName: "tree-sitter-haskell", packageVersion: "0.23.1", installSizeBytes: 4 * MB },
  { id: "zig", label: "Zig", extensions: [".zig"], kind: "pack", packageName: "@tree-sitter-grammars/tree-sitter-zig", packageVersion: "1.1.2", installSizeBytes: 1 * MB },
  { id: "solidity", label: "Solidity", extensions: [".sol"], kind: "pack", packageName: "tree-sitter-solidity", packageVersion: "1.2.13", installSizeBytes: 1 * MB },
  { id: "ocaml", label: "OCaml", extensions: [".ml"], kind: "pack", packageName: "tree-sitter-ocaml", packageVersion: "0.24.2", installSizeBytes: 15 * MB },
] as const satisfies readonly CallFlowLanguageDefinition[];

const LANGUAGE_BY_ID = new Map<CallFlowLanguageId, CallFlowLanguageDefinition>(
  CALL_FLOW_LANGUAGES.map((language) => [language.id, language]),
);
const LANGUAGE_BY_EXTENSION = new Map<string, CallFlowLanguageDefinition>(
  CALL_FLOW_LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)),
);

/** Return the pinned definition for a trusted language id. */
export function getCallFlowLanguage(id: CallFlowLanguageId): CallFlowLanguageDefinition {
  const language = LANGUAGE_BY_ID.get(id);
  if (!language) throw new Error(`Unknown CallDiff language: ${id}`);
  return language;
}

/** Parse an untrusted language identifier at an HTTP/process boundary. */
export function parseCallFlowLanguageId(value: unknown): CallFlowLanguageId | null {
  return typeof value === "string" && LANGUAGE_BY_ID.has(value as CallFlowLanguageId)
    ? value as CallFlowLanguageId
    : null;
}

/** Resolve a repository-relative path to the language CallDiff would load. */
export function getCallFlowLanguageForPath(filePath: string): CallFlowLanguageDefinition | null {
  const slash = filePath.lastIndexOf("/");
  const dot = filePath.lastIndexOf(".");
  if (dot <= slash) return null;
  return LANGUAGE_BY_EXTENSION.get(filePath.slice(dot).toLowerCase()) ?? null;
}

/** Extract both sides of every patch file, including quoted and renamed paths. */
export function getCallFlowPatchFiles(rawPatch: string): string[] {
  const files = new Set<string>();
  for (const chunk of rawPatch.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const lines = chunk.split("\n");
    const header = parseDiffGitHeader(lines[0]);
    const fileLines = parseDiffFilePathLines(lines);
    for (const filePath of [fileLines.oldPath ?? header.oldPath, fileLines.newPath ?? header.newPath]) {
      if (filePath) files.add(filePath.replaceAll("\\", "/"));
    }
  }
  return [...files];
}

export interface CallFlowPatchLanguageUsage {
  readonly language: CallFlowLanguageDefinition;
  readonly files: readonly string[];
}

/** Group supported changed paths by the grammar family they require. */
export function getCallFlowPatchLanguageUsage(rawPatch: string): CallFlowPatchLanguageUsage[] {
  const filesByLanguage = new Map<CallFlowLanguageId, string[]>();
  for (const filePath of getCallFlowPatchFiles(rawPatch)) {
    const language = getCallFlowLanguageForPath(filePath);
    if (!language) continue;
    const files = filesByLanguage.get(language.id) ?? [];
    files.push(filePath);
    filesByLanguage.set(language.id, files);
  }
  return CALL_FLOW_LANGUAGES.flatMap((language) => {
    const files = filesByLanguage.get(language.id);
    return files ? [{ language, files }] : [];
  });
}

/** Strict request body for POST /api/call-flow/install. */
export function parseCallFlowInstallRequest(value: unknown): { languageIds?: CallFlowLanguageId[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "languageIds")) return null;
  if (record.languageIds === undefined) return {};
  if (!Array.isArray(record.languageIds) || record.languageIds.length === 0 || record.languageIds.length > CALL_FLOW_LANGUAGES.length) return null;
  const parsed = record.languageIds.map(parseCallFlowLanguageId);
  if (parsed.some((id) => id === null)) return null;
  return { languageIds: [...new Set(parsed as CallFlowLanguageId[])] };
}

/**
 * Resolve an install POST without mixing the current review's default packs
 * into an explicit Languages-list request. A missing core is the only target
 * the server prepends to an explicit request.
 */
export function resolveCallFlowInstallTargets(
  requestedIds: readonly CallFlowLanguageId[] | undefined,
  defaultPlanIds: readonly CallFlowLanguageId[] | undefined,
  runtimeAvailable: boolean,
): CallFlowLanguageId[] {
  if (requestedIds === undefined) return [...(defaultPlanIds ?? [])];
  const needsCore = !runtimeAvailable && defaultPlanIds?.includes(CALL_FLOW_CORE_LANGUAGE_ID);
  return [...new Set(needsCore ? [CALL_FLOW_CORE_LANGUAGE_ID, ...requestedIds] : requestedIds)];
}
