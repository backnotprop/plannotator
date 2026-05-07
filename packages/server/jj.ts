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

async function runJj(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
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

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timer) clearTimeout(timer);

    return { stdout, stderr, exitCode };
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
