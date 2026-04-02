/**
 * Runtime-agnostic code-review core shared by Bun runtimes and Pi.
 *
 * Pi consumes a build-time copy of this file so its published package stays
 * self-contained while review diff logic remains sourced from one module.
 */

import { resolve as resolvePath } from "node:path";

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch"
  | `worktree:${string}`
  | "p4-default"
  | `p4-changelist:${string}`;

export interface DiffOption {
  id: string;
  label: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
  worktrees: WorktreeInfo[];
  cwd?: string;
  vcsType?: "git" | "p4";
}

export interface DiffResult {
  patch: string;
  label: string;
  error?: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ReviewGitRuntime {
  runGit: (
    args: string[],
    options?: { cwd?: string },
  ) => Promise<GitCommandResult>;
  readTextFile: (path: string) => Promise<string | null>;
}

export async function getCurrentBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  return result.exitCode === 0 ? result.stdout.trim() || "HEAD" : "HEAD";
}

export async function getDefaultBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const remoteHead = await runtime.runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  if (remoteHead.exitCode === 0) {
    const ref = remoteHead.stdout.trim();
    if (ref) return ref.replace("refs/remotes/origin/", "");
  }

  const mainBranch = await runtime.runGit(
    ["show-ref", "--verify", "refs/heads/main"],
    { cwd },
  );
  if (mainBranch.exitCode === 0) return "main";

  return "master";
}

export async function getWorktrees(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<WorktreeInfo[]> {
  const result = await runtime.runGit(["worktree", "list", "--porcelain"], { cwd });
  if (result.exitCode !== 0) return [];

  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        entries.push({
          path: current.path,
          head: current.head || "",
          branch: current.branch ?? null,
        });
      }
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }

  if (current.path) {
    entries.push({
      path: current.path,
      head: current.head || "",
      branch: current.branch ?? null,
    });
  }

  return entries;
}

export async function getGitContext(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<GitContext> {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(runtime, cwd),
    getDefaultBranch(runtime, cwd),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  const [worktrees, currentTreePathResult] = await Promise.all([
    getWorktrees(runtime, cwd),
    runtime.runGit(["rev-parse", "--show-toplevel"], { cwd }),
  ]);

  const currentTreePath =
    currentTreePathResult.exitCode === 0
      ? currentTreePathResult.stdout.trim()
      : null;

  return {
    currentBranch,
    defaultBranch,
    diffOptions,
    worktrees: worktrees.filter((wt) => wt.path !== currentTreePath),
    cwd,
  };
}

async function getUntrackedFileDiffs(
  runtime: ReviewGitRuntime,
  srcPrefix = "a/",
  dstPrefix = "b/",
  cwd?: string,
): Promise<string> {
  // git ls-files scopes to the CWD subtree and returns CWD-relative paths,
  // unlike git diff HEAD which always covers the full repo with root-relative
  // paths.  Resolve the repo root so untracked files from the entire repo are
  // included and their paths match the tracked-diff output.
  const toplevelResult = await runtime.runGit(
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  const rootCwd =
    toplevelResult.exitCode === 0 ? toplevelResult.stdout.trim() : cwd;

  const lsResult = await runtime.runGit(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: rootCwd },
  );
  if (lsResult.exitCode !== 0) return "";

  const files = lsResult.stdout
    .trim()
    .split("\n")
    .filter((file) => file.length > 0);

  if (files.length === 0) return "";

  const diffs = await Promise.all(
    files.map(async (file) => {
      const diffResult = await runtime.runGit(
        [
          "diff",
          "--no-ext-diff",
          "--no-index",
          `--src-prefix=${srcPrefix}`,
          `--dst-prefix=${dstPrefix}`,
          "/dev/null",
          file,
        ],
        { cwd: rootCwd },
      );
      return diffResult.stdout;
    }),
  );

  return diffs.join("");
}

function assertGitSuccess(
  result: GitCommandResult,
  args: string[],
): GitCommandResult {
  if (result.exitCode === 0) return result;

  const command = `git ${args.join(" ")}`;
  const stderr = result.stderr.trim();
  throw new Error(
    stderr
      ? `${command} failed: ${stderr}`
      : `${command} failed with exit code ${result.exitCode}`,
  );
}

const WORKTREE_SUB_TYPES = new Set([
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
]);

export function parseWorktreeDiffType(
  diffType: string,
): { path: string; subType: string } | null {
  if (!diffType.startsWith("worktree:")) return null;

  const rest = diffType.slice("worktree:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1) {
    const maybeSub = rest.slice(lastColon + 1);
    if (WORKTREE_SUB_TYPES.has(maybeSub)) {
      return { path: rest.slice(0, lastColon), subType: maybeSub };
    }
  }

  return { path: rest, subType: "uncommitted" };
}

export async function runGitDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string = "main",
  externalCwd?: string,
): Promise<DiffResult> {
  let patch = "";
  let label = "";
  let cwd: string | undefined = externalCwd;
  let effectiveDiffType = diffType as string;

  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) {
      return {
        patch: "",
        label: "Worktree error",
        error: "Could not parse worktree diff type",
      };
    }
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  try {
    switch (effectiveDiffType) {
      case "uncommitted": {
        const trackedDiffArgs = [
          "diff",
          "--no-ext-diff",
          "HEAD",
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ];
        const hasHead =
          (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd }))
            .exitCode === 0;
        const trackedPatch = hasHead
          ? assertGitSuccess(
              await runtime.runGit(trackedDiffArgs, { cwd }),
              trackedDiffArgs,
            ).stdout
          : "";
        const untrackedDiff = await getUntrackedFileDiffs(
          runtime,
          "a/",
          "b/",
          cwd,
        );
        patch = trackedPatch + untrackedDiff;
        label = "Uncommitted changes";
        break;
      }

      case "staged": {
        const stagedDiffArgs = [
          "diff",
          "--no-ext-diff",
          "--staged",
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ];
        const stagedDiff = assertGitSuccess(
          await runtime.runGit(stagedDiffArgs, { cwd }),
          stagedDiffArgs,
        );
        patch = stagedDiff.stdout;
        label = "Staged changes";
        break;
      }

      case "unstaged": {
        const trackedDiffArgs = ["diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
        const trackedDiff = assertGitSuccess(
          await runtime.runGit(trackedDiffArgs, { cwd }),
          trackedDiffArgs,
        );
        const untrackedDiff = await getUntrackedFileDiffs(
          runtime,
          "a/",
          "b/",
          cwd,
        );
        patch = trackedDiff.stdout + untrackedDiff;
        label = "Unstaged changes";
        break;
      }

      case "last-commit": {
        const hasParent = await runtime.runGit(
          ["rev-parse", "--verify", "HEAD~1"],
          { cwd },
        );
        const args =
          hasParent.exitCode === 0
            ? ["diff", "--no-ext-diff", "HEAD~1..HEAD", "--src-prefix=a/", "--dst-prefix=b/"]
            : ["diff", "--no-ext-diff", "--root", "HEAD", "--src-prefix=a/", "--dst-prefix=b/"];
        const lastCommitDiff = assertGitSuccess(
          await runtime.runGit(args, { cwd }),
          args,
        );
        patch = lastCommitDiff.stdout;
        label = "Last commit";
        break;
      }

      case "branch": {
        const branchDiffArgs = [
          "diff",
          "--no-ext-diff",
          `${defaultBranch}..HEAD`,
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ];
        const branchDiff = assertGitSuccess(
          await runtime.runGit(branchDiffArgs, { cwd }),
          branchDiffArgs,
        );
        patch = branchDiff.stdout;
        label = `Changes vs ${defaultBranch}`;
        break;
      }

      default:
        return { patch: "", label: "Unknown diff type" };
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Git dumps its entire --help output on some failures; keep only the
    // first meaningful line so the UI doesn't vomit a wall of text.
    const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? raw;
    const message = firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
    return {
      patch: "",
      label: cwd ? "Worktree error" : `Error: ${diffType}`,
      error: message,
    };
  }

  if (cwd) {
    const branch = await getCurrentBranch(runtime, cwd);
    label =
      branch && branch !== "HEAD"
        ? `${branch}: ${label}`
        : `${cwd.split("/").pop()}: ${label}`;
  }

  return { patch, label };
}

export async function runGitDiffWithContext(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  gitContext: GitContext,
): Promise<DiffResult> {
  return runGitDiff(runtime, diffType, gitContext.defaultBranch, gitContext.cwd);
}

export async function getFileContentsForDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  const oldFilePath = oldPath || filePath;

  let effectiveDiffType = diffType as string;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) return { oldContent: null, newContent: null };
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  async function gitShow(ref: string, path: string): Promise<string | null> {
    const result = await runtime.runGit(["show", `${ref}:${path}`], { cwd });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async function readWorkingTree(path: string): Promise<string | null> {
    const fullPath = cwd ? resolvePath(cwd, path) : path;
    return runtime.readTextFile(fullPath);
  }

  switch (effectiveDiffType) {
    case "uncommitted":
      return {
        oldContent: await gitShow("HEAD", oldFilePath),
        newContent: await readWorkingTree(filePath),
      };
    case "staged":
      return {
        oldContent: await gitShow("HEAD", oldFilePath),
        newContent: await gitShow(":0", filePath),
      };
    case "unstaged":
      return {
        oldContent: await gitShow(":0", oldFilePath),
        newContent: await readWorkingTree(filePath),
      };
    case "last-commit":
      return {
        oldContent: await gitShow("HEAD~1", oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    case "branch":
      return {
        oldContent: await gitShow(defaultBranch, oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    default:
      return { oldContent: null, newContent: null };
  }
}

export function validateFilePath(filePath: string): void {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    throw new Error("Invalid file path");
  }
}

async function ensureGitSuccess(
  runtime: ReviewGitRuntime,
  args: string[],
  cwd?: string,
): Promise<void> {
  const result = await runtime.runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

export async function gitAddFile(
  runtime: ReviewGitRuntime,
  filePath: string,
  cwd?: string,
): Promise<void> {
  validateFilePath(filePath);
  await ensureGitSuccess(runtime, ["add", "--", filePath], cwd);
}

export async function gitResetFile(
  runtime: ReviewGitRuntime,
  filePath: string,
  cwd?: string,
): Promise<void> {
  validateFilePath(filePath);
  await ensureGitSuccess(runtime, ["reset", "HEAD", "--", filePath], cwd);
}

export function parseP4DiffType(
  diffType: string,
): { changelist: string | "default" } | null {
  if (diffType === "p4-default") return { changelist: "default" };
  if (diffType.startsWith("p4-changelist:")) {
    return { changelist: diffType.slice("p4-changelist:".length) };
  }
  return null;
}

export function isP4DiffType(diffType: string): boolean {
  return parseP4DiffType(diffType) !== null;
}
