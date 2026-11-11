import { childEnv } from "@plannotator/shared/child-env";
import { readFileCapped } from "@plannotator/shared/repo-file";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  type DiffOption,
  type DiffResult,
  type DiffType,
  type GitBytesCommandResult,
  type GitCommandResult,
  type GitCommandOptions,
  type GitContext,
  type GitDiffOptions,
  type ReviewGitRuntime,
  type WorktreeInfo,
  getCurrentBranch as getCurrentBranchCore,
  getDefaultBranch as getDefaultBranchCore,
  getWorktrees as getWorktreesCore,
  getGitContext as getGitContextCore,
  getFileContentsForDiff as getFileContentsForDiffCore,
  gitAddFile as gitAddFileCore,
  gitResetFile as gitResetFileCore,
  parseWorktreeDiffType,
  prepareGitCommand,
  runGitDiff as runGitDiffCore,
  runGitDiffWithContext as runGitDiffWithContextCore,
  validateFilePath,
} from "@plannotator/shared/review-core";

export type {
  DiffOption,
  DiffType,
  DiffResult,
  GitContext,
  GitDiffOptions,
  WorktreeInfo,
} from "@plannotator/shared/review-core";

/**
 * Process-group leaders of git commands started with `interaction: "forbid"`: detached in their own group so a timeout kills the whole transport tree, and reaped on exit because the parent-side timer dies with the parent.
 * POSIX only: the negative-pid group signal has no Windows equivalent.
 */
const isolatedGitGroups = new Set<number>();
let isolatedGitExitHookInstalled = false;

function reapIsolatedGitGroups(): void {
  for (const pid of isolatedGitGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, or the group leader exited between the last read and here.
    }
  }
  isolatedGitGroups.clear();
}

export function trackIsolatedGitGroup(pid: number): () => void {
  if (process.platform === "win32") return () => {};
  if (!isolatedGitExitHookInstalled) {
    isolatedGitExitHookInstalled = true;
    // "exit" only: it runs on every process.exit(), and the callback must be synchronous, as process.kill is.
    process.on("exit", reapIsolatedGitGroups);
  }
  isolatedGitGroups.add(pid);
  return () => isolatedGitGroups.delete(pid);
}

/** Stop a git command and, when it runs in its own group (`isolateProcessGroup`), everything it started (ssh, git-remote-https, fetch-pack): SIGKILL to the group on POSIX, `taskkill /t` on Windows. */
export function killGitTree(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }, isolated: boolean): void {
  if (isolated && process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the process exited between the timer and signal.
    }
  }
  if (isolated && process.platform === "win32") {
    const killed = Bun.spawnSync(
      ["taskkill.exe", "/pid", String(proc.pid), "/t", "/f"],
      { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
    );
    if (killed.exitCode === 0) return;
  }
  proc.kill("SIGKILL");
}

async function runGit(
  args: string[],
  options?: GitCommandOptions,
): Promise<GitCommandResult> {
  const command = prepareGitCommand(args, options, childEnv());
  const proc = Bun.spawn(["git", ...command.args], {
    cwd: options?.cwd,
    detached: command.isolateProcessGroup,
    env: command.env ?? childEnv(),
    stdin: options?.stdin === undefined
      ? "ignore"
      : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const untrack = command.isolateProcessGroup
    ? trackIsolatedGitGroup(proc.pid)
    : undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) {
    timer = setTimeout(() => killGitTree(proc, command.isolateProcessGroup), options.timeoutMs);
  }

  // try/finally so a rejected stream read cannot leave the group leader in the exit reaper's set: a stale pid there could be recycled before the process exits.
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
    untrack?.();
  }
}

export async function readCappedBytes(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
  maxBytes: number | undefined,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) {
      reader.cancel().catch(() => {});
      kill();
    }
  }
  if (truncated) return { bytes: new Uint8Array(0), truncated };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

async function runGitBytes(
  args: string[],
  options?: GitCommandOptions,
): Promise<GitBytesCommandResult> {
  const command = prepareGitCommand(args, options, childEnv());
  const proc = Bun.spawn(["git", ...command.args], {
    cwd: options?.cwd,
    env: command.env ?? childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) timer = setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs);
  try {
    const [captured, stderr, exitCode] = await Promise.all([
      readCappedBytes(proc.stdout, () => proc.kill("SIGKILL"), options?.maxOutputBytes),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return captured.truncated
      ? { stdout: captured.bytes, stderr, exitCode, truncated: true }
      : { stdout: captured.bytes, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read at most `maxBytes + 1` bytes, so a caller can tell "over the cap". */
export async function readFileBytesCapped(path: string, maxBytes: number): Promise<Uint8Array | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const buffer = new Uint8Array(Math.min(size, maxBytes) + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Decode bytes as `Bun.file(path).text()` does: a UTF-8 BOM is stripped, a UTF-16LE BOM switches to UTF-16. */
export function decodeBunText(bytes: Uint8Array): Promise<string> {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]).text();
}

export const runtime: ReviewGitRuntime = {
  runGit,
  runGitBytes,
  readFileBytes: readFileBytesCapped,
  async realPath(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
  async readTextFile(path: string): Promise<string | null> {
    // Capped and non-blocking (repo-file.ts): a FIFO swapped in after the
    // caller's lstat cannot hang the request.
    const read = await readFileCapped(path, { decode: decodeBunText });
    return read.ok ? read.content : null;
  },
  async getFileInfo(basePath, path) {
    const fullPath = resolvePath(basePath ?? "", path);
    try {
      const fileStat = await lstat(fullPath);
      return {
        path: fullPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        isFile: fileStat.isFile(),
        isSymbolicLink: fileStat.isSymbolicLink(),
        isExecutable: (fileStat.mode & 0o111) !== 0,
      };
    } catch {
      return null;
    }
  },
  async readLink(path: string): Promise<string | null> {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  },
};

export function getCurrentBranch(): Promise<string> {
  return getCurrentBranchCore(runtime);
}

export function getDefaultBranch(): Promise<string> {
  return getDefaultBranchCore(runtime);
}

export function getWorktrees(): Promise<WorktreeInfo[]> {
  return getWorktreesCore(runtime);
}

export function getGitContext(cwd?: string): Promise<GitContext> {
  return getGitContextCore(runtime, cwd);
}

export function runGitDiff(
  diffType: DiffType,
  defaultBranch: string = "main",
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiffCore(runtime, diffType, defaultBranch, cwd, options);
}

export function runGitDiffWithContext(
  diffType: DiffType,
  gitContext: GitContext,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiffWithContextCore(runtime, diffType, gitContext, options);
}

export function getFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  return getFileContentsForDiffCore(
    runtime,
    diffType,
    defaultBranch,
    filePath,
    oldPath,
    cwd,
  );
}

export function gitAddFile(
  filePath: string,
  cwd?: string,
): Promise<void> {
  return gitAddFileCore(runtime, filePath, cwd);
}

export function gitResetFile(
  filePath: string,
  cwd?: string,
): Promise<void> {
  return gitResetFileCore(runtime, filePath, cwd);
}

export { parseWorktreeDiffType, validateFilePath };
