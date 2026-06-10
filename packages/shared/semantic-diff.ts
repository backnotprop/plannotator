import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";
import type {
  SemanticDiffAvailability,
  SemanticDiffBinaryChange,
  SemanticDiffChange,
  SemanticDiffResponse,
  SemanticDiffSummary,
} from "./semantic-diff-types";

export const PLANNOTATOR_SEM_VERSION = "v0.8.0";

const SEM_TIMEOUT_MS = 20_000;
const SEM_VERSION_TIMEOUT_MS = 3_000;
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  timedOut?: boolean;
}

export interface SemanticDiffRuntime {
  runCommand: (
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  fileExists: (path: string) => boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  dataDir: string;
  pathDelimiter: string;
  platform: NodeJS.Platform;
}

interface SemCandidate {
  command: string;
  source: string;
  explicit: boolean;
}

export interface ResolvedSem {
  command: string;
  source: string;
  version: string;
}

type SemResolveFailure = Exclude<SemanticDiffResponse, { status: "ok" }>;

function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof spawn>;

    try {
      proc = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolveResult({
        stdout: "",
        stderr: "",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdinError: string | undefined;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Ignore kill failures; process close/error will settle if needed.
        }
        finish({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode: 1,
          error: `command timed out after ${options.timeoutMs}ms`,
          timedOut: true,
        });
      }, options.timeoutMs);
    }

    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (error) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: 1,
        error: error.message,
      });
    });
    proc.on("close", (code) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
        ...(stdinError && { error: stdinError }),
      });
    });

    proc.stdin?.on("error", (error) => {
      stdinError = error.message;
    });

    try {
      if (options.input !== undefined) {
        proc.stdin?.write(options.input);
      }
      proc.stdin?.end();
    } catch (error) {
      stdinError = error instanceof Error ? error.message : String(error);
    }
  });
}

export function createDefaultSemanticDiffRuntime(): SemanticDiffRuntime {
  return {
    runCommand: defaultRunCommand,
    fileExists: existsSync,
    env: process.env,
    cwd: process.cwd(),
    dataDir: getPlannotatorDataDir(),
    pathDelimiter: delimiter,
    platform: process.platform,
  };
}

function semBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "sem.exe" : "sem";
}

export function getManagedSemBinaryPath(
  dataDir = getPlannotatorDataDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(dataDir, "vendor", "sem", PLANNOTATOR_SEM_VERSION, semBinaryName(platform));
}

export function getSemanticDiffScratchCwd(dataDir = getPlannotatorDataDir()): string {
  const primary = join(dataDir, "semantic-diff", "patch-only");
  try {
    mkdirSync(primary, { recursive: true });
    return primary;
  } catch {
    const fallback = join(tmpdir(), "plannotator-semantic-diff");
    try {
      mkdirSync(fallback, { recursive: true });
      return fallback;
    } catch {
      return tmpdir();
    }
  }
}

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function pathCandidates(runtime: SemanticDiffRuntime): SemCandidate[] {
  if (runtime.platform === "win32") {
    const pathext = (runtime.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((ext) => ext.trim())
      .filter(Boolean);
    for (const dir of (runtime.env.PATH || "").split(runtime.pathDelimiter)) {
      for (const ext of pathext) {
        const candidate = join(dir, `sem${ext.toLowerCase()}`);
        if (runtime.fileExists(candidate)) {
          return [{ command: candidate, source: "path", explicit: false }];
        }
      }
    }
    return [];
  }

  return [{ command: "sem", source: "path", explicit: false }];
}

function semCandidates(runtime: SemanticDiffRuntime): SemCandidate[] {
  const candidates: SemCandidate[] = [];
  const explicit = runtime.env.PLANNOTATOR_SEM_PATH?.trim();

  if (explicit) {
    candidates.push({ command: explicit, source: "env", explicit: true });
    return candidates;
  }

  const managed = getManagedSemBinaryPath(runtime.dataDir, runtime.platform);
  if (runtime.fileExists(managed)) {
    candidates.push({ command: managed, source: "managed", explicit: false });
  }

  candidates.push(...pathCandidates(runtime));
  return candidates;
}

export function parseSemVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^sem\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][^\s]+)?)/);
  return match?.[1] ?? null;
}

async function resolveSem(runtime: SemanticDiffRuntime): Promise<ResolvedSem | SemResolveFailure> {
  for (const candidate of semCandidates(runtime)) {
    if (candidate.explicit && isPathLike(candidate.command) && !runtime.fileExists(candidate.command)) {
      return {
        status: "unavailable",
        reason: "sem-path-missing",
        message: `PLANNOTATOR_SEM_PATH points to a missing file: ${candidate.command}`,
      };
    }

    const versionResult = await runtime.runCommand(candidate.command, ["--version"], {
      timeoutMs: SEM_VERSION_TIMEOUT_MS,
    });
    const version = parseSemVersion(versionResult.stdout);
    if (versionResult.exitCode === 0 && version) {
      return { command: candidate.command, source: candidate.source, version };
    }

    if (candidate.explicit) {
      return {
        status: "unavailable",
        reason: "invalid-sem-binary",
        message: `PLANNOTATOR_SEM_PATH did not resolve to the Ataraxy sem CLI.`,
      };
    }
  }

  return {
    status: "unavailable",
    reason: "sem-not-found",
    message: "Semantic diff is unavailable because the Ataraxy sem CLI was not found.",
  };
}

export async function getSemanticDiffAvailability(
  runtime: SemanticDiffRuntime = createDefaultSemanticDiffRuntime(),
): Promise<SemanticDiffAvailability> {
  const resolved = await resolveSem(runtime);
  if ("command" in resolved) {
    return {
      available: true,
      semVersion: resolved.version,
      semSource: resolved.source,
    };
  }

  return {
    available: false,
    reason: resolved.reason,
    message: resolved.message,
  };
}

function valueAsNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function valueAsString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function valueAsBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function summaryFromJson(value: unknown): SemanticDiffSummary {
  const summary = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    fileCount: valueAsNumber(summary.fileCount) ?? 0,
    added: valueAsNumber(summary.added) ?? 0,
    modified: valueAsNumber(summary.modified) ?? 0,
    deleted: valueAsNumber(summary.deleted) ?? 0,
    moved: valueAsNumber(summary.moved) ?? 0,
    renamed: valueAsNumber(summary.renamed) ?? 0,
    reordered: valueAsNumber(summary.reordered) ?? 0,
    binary: valueAsNumber(summary.binary) ?? 0,
    orphan: valueAsNumber(summary.orphan) ?? 0,
    total: valueAsNumber(summary.total) ?? 0,
  };
}

function changeFromJson(value: unknown): SemanticDiffChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as Record<string, unknown>;
  const changeType = valueAsString(change.changeType);
  const entityType = valueAsString(change.entityType);
  const entityName = valueAsString(change.entityName);
  const filePath = valueAsString(change.filePath);
  if (!changeType || !entityType || !entityName || !filePath) return null;

  return {
    entityId: valueAsString(change.entityId),
    changeType,
    entityType,
    entityName,
    oldEntityName: valueAsString(change.oldEntityName),
    filePath,
    oldFilePath: valueAsString(change.oldFilePath),
    startLine: valueAsNumber(change.startLine),
    endLine: valueAsNumber(change.endLine),
    oldStartLine: valueAsNumber(change.oldStartLine),
    oldEndLine: valueAsNumber(change.oldEndLine),
    structuralChange: valueAsBoolean(change.structuralChange),
  };
}

function binaryChangeFromJson(value: unknown): SemanticDiffBinaryChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as Record<string, unknown>;
  const filePath = valueAsString(change.filePath);
  if (!filePath) return null;
  return {
    changeType: "binary",
    filePath,
    oldFilePath: valueAsString(change.oldFilePath),
    fileStatus: valueAsString(change.fileStatus),
  };
}

export function parseSemanticDiffJson(stdout: string, sem: ResolvedSem): SemanticDiffResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      status: "error",
      reason: "invalid-json",
      message: "sem returned invalid JSON.",
      semVersion: sem.version,
      semSource: sem.source,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      status: "error",
      reason: "invalid-json-shape",
      message: "sem returned an unexpected JSON payload.",
      semVersion: sem.version,
      semSource: sem.source,
    };
  }

  const payload = parsed as Record<string, unknown>;
  const changes = Array.isArray(payload.changes)
    ? payload.changes.map(changeFromJson).filter((change): change is SemanticDiffChange => !!change)
    : [];
  const binaryChanges = Array.isArray(payload.binaryChanges)
    ? payload.binaryChanges.map(binaryChangeFromJson).filter((change): change is SemanticDiffBinaryChange => !!change)
    : [];

  return {
    status: "ok",
    summary: summaryFromJson(payload.summary),
    changes,
    binaryChanges,
    semVersion: sem.version,
    semSource: sem.source,
  };
}

export function normalizeSemanticDiffFileExts(fileExts: string[] | undefined): string[] {
  return Array.from(new Set((fileExts ?? [])
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => ext.startsWith(".") ? ext : `.${ext}`)));
}

export function semanticDiffFileExtsFromSearchParams(params: URLSearchParams): string[] {
  const requested = [
    ...params.getAll("fileExt"),
    ...params.getAll("fileExts").flatMap((value) => value.split(",")),
  ];
  return normalizeSemanticDiffFileExts(requested);
}

export function semanticDiffCacheKey(input: {
  rawPatch: string;
  cwd?: string;
  fileExts?: string[];
}): string {
  const hash = createHash("sha256");
  hash.update(input.rawPatch);
  hash.update("\0");
  hash.update(input.cwd ?? "");
  hash.update("\0");
  hash.update(normalizeSemanticDiffFileExts(input.fileExts).join("\0"));
  return hash.digest("hex");
}

export class SemanticDiffResponseCache {
  private readonly cache = new Map<string, SemanticDiffResponse>();
  private rawPatch: string | null = null;

  constructor(private readonly maxEntries = 8) {}

  get(cacheKey: string, rawPatch: string): SemanticDiffResponse | undefined {
    this.syncPatch(rawPatch);
    return this.cache.get(cacheKey);
  }

  set(cacheKey: string, rawPatch: string, response: SemanticDiffResponse): void {
    this.syncPatch(rawPatch);

    if (!this.cache.has(cacheKey) && this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(cacheKey, response);
  }

  private syncPatch(rawPatch: string): void {
    if (this.rawPatch === rawPatch) return;
    this.cache.clear();
    this.rawPatch = rawPatch;
  }
}

export async function runSemanticDiff(
  options: {
    rawPatch: string;
    cwd?: string;
    fileExts?: string[];
    timeoutMs?: number;
  },
  runtime: SemanticDiffRuntime = createDefaultSemanticDiffRuntime(),
): Promise<SemanticDiffResponse> {
  if (!options.rawPatch.trim()) {
    return {
      status: "ok",
      summary: {
        fileCount: 0,
        added: 0,
        modified: 0,
        deleted: 0,
        moved: 0,
        renamed: 0,
        reordered: 0,
        binary: 0,
        orphan: 0,
        total: 0,
      },
      changes: [],
      binaryChanges: [],
      semVersion: "not-run",
      semSource: "empty-patch",
    };
  }

  const cwd = options.cwd || runtime.cwd || getSemanticDiffScratchCwd(runtime.dataDir);
  const effectiveRuntime = cwd === runtime.cwd ? runtime : { ...runtime, cwd };
  const resolved = await resolveSem(effectiveRuntime);
  if (!("command" in resolved)) return resolved;

  const fileExts = normalizeSemanticDiffFileExts(options.fileExts);
  const args = ["diff", "--patch", "--format", "json"];
  if (fileExts.length > 0) {
    args.push("--file-exts", ...fileExts);
  }

  const result = await effectiveRuntime.runCommand(resolved.command, args, {
    cwd,
    input: options.rawPatch,
    timeoutMs: options.timeoutMs ?? SEM_TIMEOUT_MS,
  });

  if (result.timedOut) {
    return {
      status: "error",
      reason: "sem-timeout",
      message: result.error ?? "sem timed out while analyzing the diff.",
      semVersion: resolved.version,
      semSource: resolved.source,
    };
  }

  if (result.exitCode !== 0) {
    return {
      status: "error",
      reason: "sem-exit",
      message: result.stderr.trim() || result.error || `sem exited with code ${result.exitCode}.`,
      exitCode: result.exitCode,
      stderr: result.stderr.trim() || undefined,
      semVersion: resolved.version,
      semSource: resolved.source,
    };
  }

  return parseSemanticDiffJson(result.stdout, resolved);
}
