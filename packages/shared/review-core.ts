/**
 * Runtime-agnostic code-review core shared by Bun runtimes and Pi.
 *
 * Pi consumes a build-time copy of this file so its published package stays
 * self-contained while review diff logic remains sourced from one module.
 */

import { resolve as resolvePath } from "node:path";

export const JJ_TRUNK_REVSET = "trunk()";

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "jj-current"
  | "jj-last"
  | "jj-line"
  | "jj-all"
  | "branch"
  | "merge-base"
  | "all"
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

export interface AvailableBranches {
  local: string[];
  remote: string[];
}

export interface CompareTargetPickerCopy {
  rowLabel: string;
  triggerLabel: string;
  triggerTitlePrefix: string;
  searchPlaceholder: string;
  emptyText: string;
  localGroupLabel: string;
  remoteGroupLabel: string;
}

export interface CompareTargetConfig {
  diffTypes: string[];
  fallback: string;
  picker: CompareTargetPickerCopy;
}

export interface RepositoryContext {
  displayFallback?: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
  worktrees: WorktreeInfo[];
  availableBranches: AvailableBranches;
  compareTarget?: CompareTargetConfig;
  repository?: RepositoryContext;
  cwd?: string;
  vcsType?: "git" | "jj" | "p4";
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
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<GitCommandResult>;
  readTextFile: (path: string) => Promise<string | null>;
}

export interface GitDiffOptions {
  hideWhitespace?: boolean;
}

export function parseRemoteBookmark(target: string): { name: string; remote: string } | null {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  return { name: target.slice(0, at), remote: target.slice(at + 1) };
}

export function jjCompareTargetRevset(target: string): string {
  const remoteBookmark = parseRemoteBookmark(target);
  if (remoteBookmark) {
    return `remote_bookmarks(exact:${quoteJjString(remoteBookmark.name)}, exact:${quoteJjString(remoteBookmark.remote)})`;
  }

  const localBookmark = parseJjBookmarkName(target);
  return localBookmark ? `bookmarks(exact:${quoteJjString(localBookmark)})` : target;
}

export function jjLineBaseRevset(target: string): string {
  const compareTarget = jjCompareTargetRevset(target);
  return `heads(::@ & ::(${compareTarget}))`;
}

function parseJjBookmarkName(target: string): string | null {
  if (!target || target.startsWith("@") || /[()\s]/.test(target)) return null;
  return target;
}

function quoteJjString(value: string): string {
  return JSON.stringify(value);
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
  // Prefer the remote tracking ref (e.g. `origin/main`) so diffs run against
  // the upstream tip, not a potentially stale local copy. Only fall back to
  // a local ref when there's no remote configured at all.
  const remoteHead = await runtime.runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  if (remoteHead.exitCode === 0) {
    const ref = remoteHead.stdout.trim();
    if (ref) {
      // `symbolic-ref` only tells us what origin/HEAD *points at* — it does
      // not guarantee that the target ref was actually fetched. In narrow
      // or partial clones the pointer can be set while the target is
      // missing, in which case a later `git diff origin/main..HEAD` would
      // error. Verify the target exists before trusting it.
      const verify = await runtime.runGit(
        ["show-ref", "--verify", "--quiet", ref],
        { cwd },
      );
      if (verify.exitCode === 0) return ref.replace("refs/remotes/", "");
    }
  }

  const mainBranch = await runtime.runGit(
    ["show-ref", "--verify", "refs/heads/main"],
    { cwd },
  );
  if (mainBranch.exitCode === 0) return "main";

  return "master";
}

/**
 * Query the remote for its default branch via `ls-remote --symref`. Returns
 * `origin/<name>` if the remote answers and the tracking ref exists locally,
 * otherwise `null`. Designed to run in the background at server startup — the
 * caller fires it with `.then()` and uses the result if/when it arrives.
 *
 * Timeout-guarded: if the network is slow or absent, the promise resolves
 * (with `null`) once the timeout fires. Never throws.
 */
export async function detectRemoteDefaultBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | null> {
  try {
    const lsRemote = await runtime.runGit(
      ["ls-remote", "--symref", "origin", "HEAD"],
      { cwd, timeoutMs: 5000 },
    );
    if (lsRemote.exitCode !== 0) return null;
    const match = lsRemote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (!match) return null;
    const remoteBranch = `origin/${match[1]}`;
    const refExists = await runtime.runGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
      { cwd },
    );
    return refExists.exitCode === 0 ? remoteBranch : null;
  } catch {
    return null;
  }
}

export async function listBranches(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<AvailableBranches> {
  // Emit `<full-refname>\t<short-name>` so we can classify by ref prefix
  // without guessing from the short form — local branches can contain `/`
  // (e.g. `feature/foo`), so `name.includes("/")` would misclassify them.
  const result = await runtime.runGit(
    [
      "for-each-ref",
      "--format=%(refname)\t%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ],
    { cwd },
  );
  if (result.exitCode !== 0) return { local: [], remote: [] };

  const local: string[] = [];
  const remote: string[] = [];

  for (const line of result.stdout.split("\n")) {
    const [fullRef, shortName] = line.split("\t");
    if (!fullRef || !shortName) continue;
    if (shortName.endsWith("/HEAD")) continue;
    if (fullRef.startsWith("refs/heads/")) {
      local.push(shortName);
    } else if (fullRef.startsWith("refs/remotes/")) {
      remote.push(shortName);
    }
  }

  // Keep both local and remote refs — they can point to different commits
  // (stale local tracking branches are common) and users need to be able to
  // pick either explicitly. The picker groups them separately for clarity.
  local.sort();
  remote.sort();

  return { local, remote };
}

/**
 * Pick a safe base branch. Trusts the caller verbatim if they supplied one,
 * otherwise falls back to the detected default. Shared by Bun (`review.ts`)
 * and Pi (`serverReview.ts`) so both runtimes behave identically.
 *
 * Why trust the caller: the UI picker only ever sends refs from the known
 * list, and external/programmatic callers may pass tags, SHAs, or refs under
 * non-`origin` remotes that we must not silently rewrite (a tag `release` is
 * not the same commit as a branch `origin/release`). Invalid refs surface as
 * git errors on the next diff call, which is better than silently producing
 * a patch against the wrong commit.
 */
export function resolveBaseBranch(
  requested: string | undefined,
  detected: string,
): string {
  return requested || detected;
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
  const [currentBranch, defaultBranch, availableBranches] = await Promise.all([
    getCurrentBranch(runtime, cwd),
    getDefaultBranch(runtime, cwd),
    listBranches(runtime, cwd),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  // Always offer Branch diff / PR Diff when a default branch exists. The
  // older guard hid them when the reviewer was on the default branch (the
  // `vs <default>` diff from the default branch itself is always empty), but
  // the base picker now lets reviewers compare against any branch from any
  // branch, so there's no meaningless-by-construction option. Also: preserving
  // diff mode across worktree switches and Pi's `initialBase` can land the
  // reviewer on the default branch with branch/merge-base already active — the
  // old guard hid the active mode's option, trapping them. Unconditional
  // emission keeps the active option reachable in every flow.
  if (defaultBranch) {
    diffOptions.push({ id: "merge-base", label: "Committed changes" });
  }

  diffOptions.push({ id: "all", label: "All files (HEAD)" });

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
    availableBranches,
    compareTarget: {
      diffTypes: ["branch", "merge-base"],
      fallback: "main",
      picker: {
        rowLabel: "compare against",
        triggerLabel: "base",
        triggerTitlePrefix: "Review base",
        searchPlaceholder: "Search branches…",
        emptyText: "No branches match.",
        localGroupLabel: "Local",
        remoteGroupLabel: "Remote",
      },
    },
    cwd,
    vcsType: "git",
  };
}

async function getUntrackedFileDiffs(
  runtime: ReviewGitRuntime,
  srcPrefix = "a/",
  dstPrefix = "b/",
  cwd?: string,
  options?: GitDiffOptions,
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
          ...(options?.hideWhitespace ? ["-w"] : []),
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
  "merge-base",
  "all",
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
  options?: GitDiffOptions,
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

  const wFlag = options?.hideWhitespace ? ["-w"] : [];

  try {
    switch (effectiveDiffType) {
      case "uncommitted": {
        const trackedDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
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
          options,
        );
        patch = trackedPatch + untrackedDiff;
        label = "Uncommitted changes";
        break;
      }

      case "staged": {
        const stagedDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
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
        const trackedDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ];
        const trackedDiff = assertGitSuccess(
          await runtime.runGit(trackedDiffArgs, { cwd }),
          trackedDiffArgs,
        );
        const untrackedDiff = await getUntrackedFileDiffs(
          runtime,
          "a/",
          "b/",
          cwd,
          options,
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
            ? ["diff", "--no-ext-diff", ...wFlag, "HEAD~1..HEAD", "--src-prefix=a/", "--dst-prefix=b/"]
            : ["diff", "--no-ext-diff", ...wFlag, "--root", "HEAD", "--src-prefix=a/", "--dst-prefix=b/"];
        const lastCommitDiff = assertGitSuccess(
          await runtime.runGit(args, { cwd }),
          args,
        );
        patch = lastCommitDiff.stdout;
        label = "Last commit";
        break;
      }

      case "branch": {
        // `--end-of-options` hardens against a caller-supplied `defaultBranch`
        // that starts with `-` being parsed as a git flag (e.g. `--output=...`
        // would redirect diff output to an attacker-chosen path). Same pattern
        // applied wherever user-controlled refs flow into a git argv.
        const branchDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--end-of-options",
          `${defaultBranch}..HEAD`,
        ];
        const branchDiff = assertGitSuccess(
          await runtime.runGit(branchDiffArgs, { cwd }),
          branchDiffArgs,
        );
        patch = branchDiff.stdout;
        label = `Changes vs ${defaultBranch}`;
        break;
      }

      case "merge-base": {
        const mergeBaseLookupArgs = ["merge-base", "--end-of-options", defaultBranch, "HEAD"];
        const mergeBaseResult = assertGitSuccess(
          await runtime.runGit(mergeBaseLookupArgs, { cwd }),
          mergeBaseLookupArgs,
        );
        const mergeBase = mergeBaseResult.stdout.trim();
        const mergeBaseDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--end-of-options",
          `${mergeBase}..HEAD`,
        ];
        const mergeBaseDiff = assertGitSuccess(
          await runtime.runGit(mergeBaseDiffArgs, { cwd }),
          mergeBaseDiffArgs,
        );
        patch = mergeBaseDiff.stdout;
        label = `PR diff vs ${defaultBranch}`;
        break;
      }

      case "all": {
        // Diff from the empty tree to HEAD — shows every tracked file as an addition.
        const emptyTreeResult = await runtime.runGit(["hash-object", "-t", "tree", "/dev/null"], { cwd });
        const emptyTree = emptyTreeResult.exitCode === 0
          ? emptyTreeResult.stdout.trim()
          : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        const allDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--end-of-options",
          `${emptyTree}..HEAD`,
        ];
        const allDiff = assertGitSuccess(
          await runtime.runGit(allDiffArgs, { cwd }),
          allDiffArgs,
        );
        patch = allDiff.stdout;
        label = "All files";
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
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiff(runtime, diffType, gitContext.defaultBranch, gitContext.cwd, options);
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
    // `--end-of-options` hardens against user-supplied refs starting with `-`.
    const result = await runtime.runGit(["show", "--end-of-options", `${ref}:${path}`], { cwd });
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
    case "merge-base": {
      const mbResult = await runtime.runGit(["merge-base", "--end-of-options", defaultBranch, "HEAD"], { cwd });
      const mb = mbResult.exitCode === 0 ? mbResult.stdout.trim() : defaultBranch;
      return {
        oldContent: await gitShow(mb, oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    }
    case "all":
      return {
        oldContent: null,
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
