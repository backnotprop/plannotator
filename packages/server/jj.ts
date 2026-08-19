import {
  type DiffResult,
  type DiffType,
  type GitCommandResult,
  type GitContext,
  type GitDiffOptions,
} from "@plannotator/shared/review-core";
import {
  type ReviewJjRuntime,
  detectJjWorkspace as detectJjWorkspaceCore,
  getJjContext as getJjContextCore,
  getJjFileContentsForDiff as getJjFileContentsForDiffCore,
  runJjDiff as runJjDiffCore,
} from "@plannotator/shared/jj-core";

export {
  JJ_TRUNK_REVSET,
  getJjDiffArgs,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseJjBookmarkList,
  parseJjRemoteBookmarkList,
  parseRemoteBookmark,
  selectDefaultJjCompareTarget,
} from "@plannotator/shared/jj-core";

/**
 * Read stdout with a byte ceiling, killing the command the moment it is passed.
 *
 * Reading the whole stream and measuring it afterwards would let a command that
 * can emit an entire repository tree (a `--from root()` snapshot diff) grow
 * memory without limit before anything rejected it.
 */
async function readCappedStdout(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
  maxOutputBytes: number | undefined,
): Promise<{ stdout: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let bytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (maxOutputBytes !== undefined && bytes > maxOutputBytes) {
        truncated = true;
        break;
      }
      stdout += decoder.decode(value, { stream: true });
    }
  } finally {
    if (truncated) {
      reader.cancel().catch(() => {});
      kill();
    }
    stdout += decoder.decode();
  }

  return { stdout, truncated };
}

async function runJj(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
): Promise<GitCommandResult> {
  try {
    const proc = Bun.spawn(["jj", ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs) {
      timer = setTimeout(() => proc.kill(), options.timeoutMs);
    }

    const [captured, stderr, exitCode] = await Promise.all([
      readCappedStdout(
        proc.stdout as ReadableStream<Uint8Array>,
        () => proc.kill(),
        options?.maxOutputBytes,
      ),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timer) clearTimeout(timer);

    return captured.truncated
      ? { stdout: captured.stdout, stderr, exitCode, truncated: true }
      : { stdout: captured.stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "jj not found", exitCode: 1 };
  }
}

export const runtime: ReviewJjRuntime = {
  runJj,
};

export function detectJjWorkspace(cwd?: string): Promise<string | null> {
  return detectJjWorkspaceCore(runtime, cwd);
}

export function getJjContext(cwd?: string): Promise<GitContext> {
  return getJjContextCore(runtime, cwd);
}

export function runJjDiff(
  diffType: DiffType,
  defaultBranch: string,
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runJjDiffCore(runtime, diffType, defaultBranch, cwd, options);
}

export function getJjFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  return getJjFileContentsForDiffCore(runtime, diffType, defaultBranch, filePath, oldPath, cwd);
}
