import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseDiffFilePathLines, parseDiffGitHeader } from "./diff-paths";
import { listPatchFiles } from "./review-core";
import type {
  EslintCheckAdvert,
  EslintCheckResponse,
  EslintDiagnostic,
} from "./eslint-check-types";

const ESLINT_TIMEOUT_MS = 30_000;
const ESLINT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ESLINT_MAX_FILES = 500;
const LINTABLE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
]);
const CONFIG_FILENAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

export interface EslintCheckFile {
  path: string;
  displayPath?: string;
}

export interface EslintCheckRoot {
  cwd: string;
  files: EslintCheckFile[];
}

export interface EslintCheckInput {
  roots: EslintCheckRoot[];
  rawPatch: string;
}

export interface EslintWorkspaceRoot {
  label: string;
  cwd: string;
}

export function isEslintCheckCompatibleReviewView(options: {
  isPRMode: boolean;
  isWorkspaceMode: boolean;
  diffType: string;
}): boolean {
  if (options.isPRMode) return false;
  if (options.isWorkspaceMode) return options.diffType === "workspace-current";

  const worktreeSeparator = options.diffType.lastIndexOf(":");
  const type = options.diffType.startsWith("worktree:") && worktreeSeparator !== -1
    ? options.diffType.slice(worktreeSeparator + 1)
    : options.diffType;

  return type === "since-base"
    || type === "uncommitted"
    || type === "unstaged"
    || type === "gitbutler:workspace"
    || type === "jj-current"
    || type === "p4-default";
}

export interface EslintCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export interface EslintCheckRuntime {
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
  runCommand: (
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
  ) => Promise<EslintCommandResult>;
  nodePath: string;
  now: () => number;
}

interface EslintPackage {
  entryPath: string;
  version: string;
}

interface PreparedFile {
  absolutePath: string;
  relativePath: string;
  displayPath: string;
  configRoot: string;
}

interface PreparedGroup {
  cwd: string;
  eslint: EslintPackage;
  files: PreparedFile[];
}

interface RawEslintMessage {
  ruleId?: unknown;
  severity?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  fix?: unknown;
  suggestions?: unknown;
}

interface RawEslintResult {
  filePath?: unknown;
  messages?: unknown;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
): Promise<EslintCommandResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let proc: ReturnType<typeof spawn>;

    const finish = (result: EslintCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    try {
      proc = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      resolveResult({
        stdout: "",
        stderr: "",
        exitCode: 2,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      proc.kill();
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: 2,
        timedOut: true,
      });
    }, options.timeoutMs);

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) {
        proc.kill();
        finish({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode: 2,
          outputLimitExceeded: true,
        });
        return;
      }
      chunks.push(chunk);
    };

    proc.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    proc.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
    proc.on("error", (error) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: 2,
        error: error.message,
      });
    });
    proc.on("close", (code) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 2,
      });
    });
  });
}

export function createDefaultEslintCheckRuntime(): EslintCheckRuntime {
  const runningUnderBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

  return {
    fileExists: existsSync,
    readTextFile: (path) => readFileSync(path, "utf-8"),
    runCommand: defaultRunCommand,
    nodePath: runningUnderBun ? "node" : process.execPath,
    now: () => performance.now(),
  };
}

export function buildEslintCheckInput(
  rawPatch: string,
  cwd: string,
  workspaceRoots?: EslintWorkspaceRoot[],
): EslintCheckInput {
  const patchFiles = listPatchFiles(rawPatch);

  if (!workspaceRoots?.length) {
    return {
      rawPatch,
      roots: [{ cwd, files: patchFiles.map((file) => ({ path: file.path })) }],
    };
  }

  const sortedRoots = [...workspaceRoots].sort((a, b) => b.label.length - a.label.length);
  const grouped = new Map<string, EslintCheckRoot>();

  for (const file of patchFiles) {
    const root = sortedRoots.find((candidate) => file.path.startsWith(`${candidate.label}/`));
    if (!root) continue;

    const relativePath = file.path.slice(root.label.length + 1);
    if (!relativePath) continue;

    const group = grouped.get(root.cwd) ?? { cwd: root.cwd, files: [] };

    group.files.push({ path: relativePath, displayPath: file.path });
    grouped.set(root.cwd, group);
  }

  return { rawPatch, roots: [...grouped.values()] };
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");

  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readJson(runtime: EslintCheckRuntime, path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(runtime.readTextFile(path));

    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function directoryHasConfig(runtime: EslintCheckRuntime, directory: string): boolean {
  if (CONFIG_FILENAMES.some((name) => runtime.fileExists(join(directory, name)))) return true;

  const packageJson = join(directory, "package.json");
  if (!runtime.fileExists(packageJson)) return false;

  return readJson(runtime, packageJson)?.eslintConfig !== undefined;
}

function findConfigRoot(runtime: EslintCheckRuntime, filePath: string, root: string): string | null {
  let current = dirname(filePath);

  while (isWithinRoot(root, current)) {
    if (directoryHasConfig(runtime, current)) return current;
    if (current === root) break;

    const parent = dirname(current);
    if (parent === current) break;

    current = parent;
  }

  return null;
}

function resolveEslintPackage(
  runtime: EslintCheckRuntime,
  start: string,
  root: string,
): EslintPackage | null {
  let current = start;

  while (isWithinRoot(root, current)) {
    const packagePath = join(current, "node_modules", "eslint", "package.json");

    if (runtime.fileExists(packagePath)) {
      const packageJson = readJson(runtime, packagePath);
      const packageRoot = dirname(packagePath);
      const bin = packageJson?.bin;
      const binPath = typeof bin === "string"
        ? bin
        : bin && typeof bin === "object" && !Array.isArray(bin) && typeof (bin as Record<string, unknown>).eslint === "string"
          ? (bin as Record<string, string>).eslint
          : "bin/eslint.js";
      const entryPath = resolve(packageRoot, binPath);

      if (isWithinRoot(packageRoot, entryPath) && runtime.fileExists(entryPath)) {
        return {
          entryPath,
          version: typeof packageJson?.version === "string" ? packageJson.version : "unknown",
        };
      }
    }

    if (current === root) break;

    const parent = dirname(current);
    if (parent === current) break;

    current = parent;
  }

  return null;
}

function prepareGroups(input: EslintCheckInput, runtime: EslintCheckRuntime): PreparedGroup[] {
  const groups = new Map<string, PreparedGroup>();
  let preparedCount = 0;

  for (const rootInput of input.roots) {
    const root = resolve(rootInput.cwd);

    for (const file of rootInput.files) {
      if (preparedCount >= ESLINT_MAX_FILES) break;
      if (!LINTABLE_EXTENSIONS.has(extensionOf(file.path))) continue;

      const absolutePath = resolve(root, file.path);
      if (!isWithinRoot(root, absolutePath) || !runtime.fileExists(absolutePath)) continue;

      const configRoot = findConfigRoot(runtime, absolutePath, root);
      if (!configRoot) continue;

      const eslint = resolveEslintPackage(runtime, configRoot, root);
      if (!eslint) continue;

      const key = `${configRoot}\0${eslint.entryPath}`;
      const group = groups.get(key) ?? { cwd: configRoot, eslint, files: [] };

      group.files.push({
        absolutePath,
        relativePath: relative(configRoot, absolutePath),
        displayPath: file.displayPath ?? file.path,
        configRoot,
      });

      groups.set(key, group);
      preparedCount += 1;
    }
  }

  return [...groups.values()];
}

export function getEslintCheckAvailability(
  input: EslintCheckInput,
  runtime: EslintCheckRuntime = createDefaultEslintCheckRuntime(),
): EslintCheckAdvert {
  const lintableCount = input.roots.reduce(
    (count, root) => count + root.files.filter((file) => LINTABLE_EXTENSIONS.has(extensionOf(file.path))).length,
    0,
  );

  if (lintableCount === 0) return { available: false, reason: "no-lintable-files" };

  const groups = prepareGroups(input, runtime);

  if (groups.length === 0) return { available: false, reason: "eslint-not-configured" };

  return {
    available: true,
    fileCount: groups.reduce((count, group) => count + group.files.length, 0),
    projectCount: groups.length,
  };
}

export function extractChangedLines(rawPatch: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  const chunkStarts = [...rawPatch.matchAll(/^diff --git /gm)];

  for (let index = 0; index < chunkStarts.length; index += 1) {
    const start = chunkStarts[index].index ?? 0;
    const end = chunkStarts[index + 1]?.index ?? rawPatch.length;
    const lines = rawPatch.slice(start, end).split("\n");
    const fileLines = parseDiffFilePathLines(lines);
    const header = parseDiffGitHeader(lines[0] ?? "");
    const path = fileLines.newPath ?? header.newPath;

    if (!path) continue;

    const changed = result.get(path) ?? new Set<number>();
    let newLine = 0;

    for (const line of lines) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

      if (hunk) {
        newLine = Number.parseInt(hunk[1], 10);
        continue;
      }

      if (newLine === 0) continue;

      if (line.startsWith("+") && !line.startsWith("+++")) {
        changed.add(newLine);
        newLine += 1;
      } else if (!line.startsWith("-")) {
        newLine += 1;
      }
    }

    result.set(path, changed);
  }

  return result;
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDiagnostics(
  stdout: string,
  group: PreparedGroup,
  changedLines: Map<string, Set<number>>,
): EslintDiagnostic[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const filesByAbsolutePath = new Map(group.files.map((file) => [resolve(file.absolutePath), file]));
  const diagnostics: EslintDiagnostic[] = [];

  for (const rawResult of parsed as RawEslintResult[]) {
    if (!rawResult || typeof rawResult !== "object" || typeof rawResult.filePath !== "string") continue;

    const rawAbsolutePath = resolve(rawResult.filePath);
    const normalizedRawPath = rawAbsolutePath.replaceAll("\\", "/");
    const file = filesByAbsolutePath.get(rawAbsolutePath)
      ?? group.files.find((candidate) => normalizedRawPath.endsWith(`/${candidate.relativePath.replaceAll("\\", "/")}`));

    if (!file || !Array.isArray(rawResult.messages)) continue;

    for (const rawMessage of rawResult.messages as RawEslintMessage[]) {
      if (!rawMessage || typeof rawMessage !== "object") continue;

      const severity = rawMessage.severity === 2 ? 2 : rawMessage.severity === 1 ? 1 : null;
      if (!severity || typeof rawMessage.message !== "string") continue;

      const line = numeric(rawMessage.line, 1);
      const fileChangedLines = changedLines.get(file.displayPath);

      diagnostics.push({
        filePath: file.displayPath,
        line,
        column: numeric(rawMessage.column, 1),
        ...(typeof rawMessage.endLine === "number" && { endLine: rawMessage.endLine }),
        ...(typeof rawMessage.endColumn === "number" && { endColumn: rawMessage.endColumn }),
        severity,
        ruleId: typeof rawMessage.ruleId === "string" ? rawMessage.ruleId : null,
        message: rawMessage.message,
        fixable: rawMessage.fix !== undefined || (Array.isArray(rawMessage.suggestions) && rawMessage.suggestions.length > 0),
        onChangedLine: fileChangedLines?.has(line) ?? false,
      });
    }
  }

  return diagnostics;
}

export async function runEslintCheck(
  input: EslintCheckInput,
  runtime: EslintCheckRuntime = createDefaultEslintCheckRuntime(),
): Promise<EslintCheckResponse> {
  const groups = prepareGroups(input, runtime);

  if (groups.length === 0) {
    return {
      status: "unavailable",
      reason: "eslint-not-configured",
      message: "No reviewed files have both an ESLint configuration and a project-local ESLint installation.",
    };
  }

  const changedLines = extractChangedLines(input.rawPatch);
  const diagnostics: EslintDiagnostic[] = [];
  const deadline = runtime.now() + ESLINT_TIMEOUT_MS;

  for (const group of groups) {
    const remainingMs = deadline - runtime.now();

    if (remainingMs <= 0) {
      return { status: "error", reason: "timeout", message: "ESLint did not finish within 30 seconds." };
    }

    const command = await runtime.runCommand(
      runtime.nodePath,
      [group.eslint.entryPath, "--format", "json", "--no-color", "--", ...group.files.map((file) => file.relativePath)],
      { cwd: group.cwd, timeoutMs: remainingMs, maxOutputBytes: ESLINT_MAX_OUTPUT_BYTES },
    );

    if (command.timedOut) {
      return { status: "error", reason: "timeout", message: "ESLint did not finish within 30 seconds." };
    }
    if (command.outputLimitExceeded) {
      return { status: "error", reason: "output-limit", message: "ESLint produced more than 10 MB of output." };
    }
    if (command.error) {
      return { status: "error", reason: "spawn-failed", message: command.error };
    }
    if (command.exitCode !== 0 && command.exitCode !== 1) {
      return {
        status: "error",
        reason: "eslint-exit",
        message: command.stderr.trim() || "ESLint could not run because of a configuration or internal error.",
        exitCode: command.exitCode,
        ...(command.stderr.trim() && { stderr: command.stderr.trim() }),
      };
    }

    const groupDiagnostics = parseDiagnostics(command.stdout, group, changedLines);

    if (!groupDiagnostics) {
      return {
        status: "error",
        reason: "invalid-json",
        message: command.stderr.trim() || "ESLint returned invalid JSON output.",
      };
    }

    diagnostics.push(...groupDiagnostics);
  }

  diagnostics.sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column || b.severity - a.severity,
  );

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 2).length;
  const warnings = diagnostics.length - errors;
  const changedLineDiagnostics = diagnostics.filter((diagnostic) => diagnostic.onChangedLine);
  const changedLineErrors = changedLineDiagnostics.filter((diagnostic) => diagnostic.severity === 2).length;

  return {
    status: "ok",
    summary: {
      files: new Set(diagnostics.map((diagnostic) => diagnostic.filePath)).size,
      errors,
      warnings,
      changedLineErrors,
      changedLineWarnings: changedLineDiagnostics.length - changedLineErrors,
    },
    diagnostics,
    eslintVersions: [...new Set(groups.map((group) => group.eslint.version))],
  };
}
