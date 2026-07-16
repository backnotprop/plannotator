/**
 * Runtime-agnostic code-review core shared by Bun runtimes and Pi.
 *
 * Pi consumes a build-time copy of this file so its published package stays
 * self-contained while review diff logic remains sourced from one module.
 */

import { resolve as resolvePath } from "node:path";
import { unquoteGitPath, parsePatchPathToken, parseDiffFilePathLines, parseDiffGitHeader } from "./diff-paths";

export const JJ_TRUNK_REVSET = "trunk()";

export type DiffType =
  | "since-base"
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "jj-current"
  | "jj-last"
  | "jj-line"
  | "jj-all"
  | "jj-evolog"
  | "branch"
  | "merge-base"
  | "all"
  | `commit:${string}`
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

export interface JjEvoLogEntry {
  /** Short commit ID (12 hex chars) */
  commitId: string;
  /** First line of the commit message */
  description: string;
  /** Human-readable age string, e.g. "2 hours ago" */
  age?: string;
}

export interface RecentCommit {
  /** Full SHA — sent back as the diff base. */
  sha: string;
  /** Abbreviated SHA for display. */
  shortSha: string;
  /** First line of the commit message. */
  subject: string;
  /** Human-readable age string, e.g. "2 hours ago". */
  relativeDate: string;
  /** Committer-name; shown after the subject in the picker. */
  author: string;
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
  /** Evolution log entries for the current jj change (jj only). */
  jjEvologs?: JjEvoLogEntry[];
  /** HEAD ancestry, newest first. Powers the commit-based baseline picker (#709). */
  recentCommits?: RecentCommit[];
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

  // origin/HEAD is often unset (feature-only clones, CI checkouts, extra
  // worktrees, `clone --branch X`). Those setups routinely have NO local
  // main/master either — but the remote-tracking ref is fetched and diffable.
  // Check it before the local names (matching the prefer-upstream intent
  // above) and before the blind "master" guess, or since-base gets suppressed
  // for the whole session on a repo that could serve it fine.
  const originMain = await runtime.runGit(
    ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
    { cwd },
  );
  if (originMain.exitCode === 0) return "origin/main";

  const mainBranch = await runtime.runGit(
    ["show-ref", "--verify", "refs/heads/main"],
    { cwd },
  );
  if (mainBranch.exitCode === 0) return "main";

  const originMaster = await runtime.runGit(
    ["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"],
    { cwd },
  );
  if (originMaster.exitCode === 0) return "origin/master";

  return "master";
}

export interface RemoteDefaultInfo {
  /** Tracking ref name, e.g. `origin/main`. */
  branch: string;
  /** The remote's current tip SHA for that branch (from the same ls-remote
   * response), or null if it couldn't be parsed. */
  remoteHeadSha: string | null;
}

/**
 * Query the remote for its default branch via `ls-remote --symref`. Returns
 * `origin/<name>` plus the remote tip SHA if the remote answers and the
 * tracking ref exists locally, otherwise `null`. Designed to run in the
 * background at server startup — the caller fires it with `.then()` and uses
 * the result if/when it arrives.
 *
 * Timeout-guarded: if the network is slow or absent, the promise resolves
 * (with `null`) once the timeout fires. Never throws.
 */
export async function detectRemoteDefaultInfo(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<RemoteDefaultInfo | null> {
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
    if (refExists.exitCode !== 0) return null;
    // The same response carries the remote tip: `<sha>\tHEAD`.
    const shaMatch = lsRemote.stdout.match(/^([0-9a-f]{40,64})\s+HEAD$/m);
    return { branch: remoteBranch, remoteHeadSha: shaMatch ? shaMatch[1] : null };
  } catch {
    return null;
  }
}

/** Back-compat wrapper: just the tracking ref name. */
export async function detectRemoteDefaultBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | null> {
  return (await detectRemoteDefaultInfo(runtime, cwd))?.branch ?? null;
}

const RECENT_COMMIT_LIMIT_DEFAULT = 20;
// US (\x1F) separator avoids collisions with commit subjects, author names, and
// dates while staying compatible with `git log --pretty=format`.
export const COMMIT_FIELD_SEP = "\x1f";

/**
 * Split a COMMIT_FIELD_SEP-formatted git output into exactly
 * `head + 1 + tail` fields. A literal US byte inside the one free-text field
 * (subject or body) over-splits the raw string; the fixed-shape head and tail
 * fields let us rejoin the middle losslessly. Returns null when the input has
 * fewer fields than the format guarantees. Shared by every %x1f parser
 * (here and commit-history.ts) so the over-split edge case lives in one place.
 */
export function splitCommitFormatFields(value: string, head: number, tail: number): string[] | null {
  const parts = value.split(COMMIT_FIELD_SEP);
  if (parts.length < head + tail + 1) return null;
  return [
    ...parts.slice(0, head),
    parts.slice(head, parts.length - tail).join(COMMIT_FIELD_SEP),
    ...parts.slice(parts.length - tail),
  ];
}

/**
 * Walk HEAD's ancestry and return the most-recent commits for the
 * commit-baseline picker. Single `git log` call — fast (~ms).
 */
export async function listRecentCommits(
  runtime: ReviewGitRuntime,
  cwd?: string,
  limit: number = RECENT_COMMIT_LIMIT_DEFAULT,
): Promise<RecentCommit[]> {
  const fmt = ["%H", "%h", "%s", "%cr", "%an"].join(COMMIT_FIELD_SEP);
  const result = await runtime.runGit(
    ["log", `--max-count=${limit}`, `--pretty=format:${fmt}`, "HEAD"],
    { cwd },
  );
  if (result.exitCode !== 0) return [];

  const commits: RecentCommit[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const fields = splitCommitFormatFields(line, 2, 2);
    if (!fields) continue;
    const [sha, shortSha, subject, relativeDate, author] = fields;
    commits.push({ sha, shortSha, subject, relativeDate, author });
  }
  return commits;
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
  const [currentBranch, defaultBranch, availableBranches, recentCommits] = await Promise.all([
    getCurrentBranch(runtime, cwd),
    getDefaultBranch(runtime, cwd),
    listBranches(runtime, cwd),
    listRecentCommits(runtime, cwd),
  ]);

  const diffOptions: DiffOption[] = [];

  // "Since <base>" — the composite default: merge-base(base, HEAD) vs the
  // working tree plus untracked. Everything a PR would show if pushed now.
  // Emitted first so it wins resolveInitialDiffType's diffOptions[0] fallback.
  //
  // Only offer it when the base ref actually resolves. getDefaultBranch returns
  // a literal "master" as a last resort even when no such ref exists (a repo
  // whose trunk is e.g. `trunk`, or a clone with no origin/HEAD). If we offered
  // since-base there it would become the auto-default, then merge-base fails and
  // the diff degrades to HEAD — silently hiding all committed branch work. When
  // it's absent, resolveInitialDiffType falls through to `uncommitted`.
  if (defaultBranch) {
    const baseResolves = (
      await runtime.runGit(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${defaultBranch}^{commit}`],
        { cwd },
      )
    ).exitCode === 0;
    if (baseResolves) {
      // Dynamic label so it matches the live gitRef header ("All changes
      // since origin/main" / "... since master") rather than a hardcoded
      // base name that contradicts it on non-main repos. The product/
      // first-run copy uses the short form "All changes".
      diffOptions.push({ id: "since-base", label: `All changes since ${displayRef(defaultBranch)}` });
    }
  }

  diffOptions.push(
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  );

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
    diffOptions.push({ id: "merge-base", label: "Committed changes (PR view)" });
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
      diffTypes: ["since-base", "branch", "merge-base"],
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
    recentCommits,
  };
}

/**
 * Remove tracked DELETION blocks whose path also exists as an untracked file.
 * `git rm --cached f` (optionally then editing f) reports f as BOTH a tracked
 * deletion and an untracked file — the file is still on disk, so the working-tree
 * (untracked) side carries the real content. Keep THAT and drop the misleading
 * deletion: exactly one diff entry per path (no path-keyed dock/nav collision)
 * AND the reviewer sees the actual content, not a phantom delete.
 *
 * The deletion's path is read from its `--- a/<path>` line via the shared
 * parsePatchPathToken (handles C-quoting and git's unquoted-space trailing-tab).
 * Binary deletions carry no `--- ` line, so a binary `rm --cached` isn't deduped
 * — an accepted edge (binary + untracked + unstaged-delete is vanishingly rare).
 *
 * Known accepted edge (since-base): a deletion COMMITTED on the branch whose
 * path was then recreated untracked is also deduped — the review shows the
 * recreated file as a plain untracked addition and hides that a base version
 * was removed. Distinguishing it (file absent at HEAD) would mean emitting two
 * same-path entries, which the path-keyed UI (dock panel, nav, sections map,
 * viewed state) cannot represent; showing the current content wins.
 */
function removeTrackedDeletions(patch: string, untrackedPaths: Set<string>): string {
  if (!patch || untrackedPaths.size === 0) return patch;
  const lines = patch.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith("diff --git ")) i++;
    const block = lines.slice(start, i);
    const isDeletion = block.some(
      (l) => l.startsWith("deleted file mode") || l === "+++ /dev/null",
    );
    let delPath: string | null = null;
    if (isDeletion) {
      const minus = block.find((l) => l.startsWith("--- "));
      if (minus) {
        const p = parsePatchPathToken(minus.slice(4), "a");
        if (p && p !== "/dev/null") delPath = p;
      }
    }
    if (!(isDeletion && delPath && untrackedPaths.has(delPath))) out.push(...block);
  }
  return out.join("\n");
}

/**
 * Resolve the repo toplevel for path resolution. Patch/porcelain paths are
 * repo-ROOT-relative; a review launched from a repo SUBDIRECTORY has its cwd
 * inside the repo, and resolving root-relative paths against that cwd
 * double-prefixes them (or aims git pathspecs at the wrong subtree). Every
 * place that turns a patch path into a filesystem path or git pathspec must
 * go through this. Falls back to the given cwd when rev-parse fails.
 */
async function resolveRepoToplevel(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | undefined> {
  const top = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
  const trimmed = top.exitCode === 0 ? top.stdout.trim() : "";
  return trimmed || cwd;
}

async function getUntrackedFileDiffs(
  runtime: ReviewGitRuntime,
  srcPrefix = "a/",
  dstPrefix = "b/",
  cwd?: string,
  options?: GitDiffOptions,
): Promise<{ diff: string; paths: string[] }> {
  // git ls-files scopes to the CWD subtree and returns CWD-relative paths,
  // unlike git diff HEAD which always covers the full repo with root-relative
  // paths.  Resolve the repo root so untracked files from the entire repo are
  // included and their paths match the tracked-diff output.
  const rootCwd = await resolveRepoToplevel(runtime, cwd);

  const lsResult = await runtime.runGit(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: rootCwd },
  );
  if (lsResult.exitCode !== 0) return { diff: "", paths: [] };

  // ls-files C-quotes unusual paths (unicode, control chars — NOT plain
  // spaces). The quoted form breaks everything downstream: the --no-index
  // diff can't access the literal quoted filename (the file silently drops
  // out of the review), and the returned paths would never match the
  // unquoted deletion paths in removeTrackedDeletions.
  const files = lsResult.stdout
    .trim()
    .split("\n")
    .filter((file) => file.length > 0)
    .map((file) => unquoteGitPath(file));

  if (files.length === 0) return { diff: "", paths: [] };

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

  return { diff: diffs.join(""), paths: files };
}

/**
 * If `ref` looks like a full or long hex SHA, return its 7-char prefix for
 * display. Branch names, tags, and `HEAD~N` pass through unchanged.
 */
function displayRef(ref: string): string {
  return /^[0-9a-f]{7,}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** Resolve the empty-tree object id (hash-object honors repo hash algorithm;
 * the SHA-1 constant is the fallback for the degenerate no-repo case). */
async function getEmptyTreeSha(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runGit(["hash-object", "-t", "tree", "/dev/null"], { cwd });
  return result.exitCode === 0
    ? result.stdout.trim()
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
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

// LOCKSTEP: packages/review-editor/App.tsx's activeWorktreePath memo
// hand-parses worktree: diffTypes with a COPY of this list (this module
// can't enter the browser bundle — node:path import above). Adding a
// subtype here without updating that copy makes the client derive a
// different worktreePath than the server stamped on guide/tour jobs,
// silently breaking their context matching. Real fix (cleanup PR):
// extract the pure parser to a browser-safe module.
const WORKTREE_SUB_TYPES = new Set([
  "since-base",
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
  "all",
]);

/** Bare hex object name (full or abbreviated) — the only sha shape accepted
 * from clients before it reaches a git argv position. */
export const BARE_HEX_SHA_RE = /^[0-9a-f]{4,64}$/i;

/**
 * Parse a `commit:<sha>` diff type — a single historical commit reviewed
 * against its first parent. The sha must be plain hex (full or abbreviated):
 * it flows from a client request into git argv positions, so anything that
 * isn't a bare object name is rejected here rather than trusted downstream
 * (`--end-of-options` already prevents flag smuggling; this keeps revspec
 * operators like `..`/`^{}` out too, so the diff is always one commit).
 */
export function parseCommitDiffType(diffType: string): { sha: string } | null {
  if (!diffType.startsWith("commit:")) return null;
  const sha = diffType.slice("commit:".length);
  return BARE_HEX_SHA_RE.test(sha) ? { sha } : null;
}

/**
 * True when switching to `nextDiffType` is a commit:<sha> diff within the
 * same cwd as `previousDiffType` (plain or worktree-prefixed). The commit-rail
 * hot path: such a switch cannot change branches, worktrees, or recent
 * commits, so the /api/diff/switch handlers skip their gitContext recompute.
 * Only the NEW type must be a commit diff — the context is invalidated by
 * where you land, not where you came from.
 */
export function isSameCwdCommitSwitch(
  previousDiffType: string,
  nextDiffType: string,
): boolean {
  const next = parseWorktreeDiffType(nextDiffType);
  if (!parseCommitDiffType(next?.subType ?? nextDiffType)) return false;
  return (next?.path ?? null) === (parseWorktreeDiffType(previousDiffType)?.path ?? null);
}

export function parseWorktreeDiffType(
  diffType: string,
): { path: string; subType: string } | null {
  if (!diffType.startsWith("worktree:")) return null;

  const rest = diffType.slice("worktree:".length);
  // `worktree:<path>:commit:<sha>` — the sub-type itself contains a colon, so
  // it can't be recognized by the single lastIndexOf(':') split below. Split
  // on the LAST ':commit:' occurrence (a path that itself ends in ':commit'
  // followed by a hex segment would be misread — accepted pathological edge).
  const commitIdx = rest.lastIndexOf(":commit:");
  if (commitIdx !== -1) {
    const maybeCommit = rest.slice(commitIdx + 1);
    if (parseCommitDiffType(maybeCommit)) {
      return { path: rest.slice(0, commitIdx), subType: maybeCommit };
    }
  }
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
    // `commit:<sha>` — one historical commit vs its first parent (git-show
    // style). Handled before the switch: the sha makes it a family of types,
    // not a literal case label.
    const commitRef = parseCommitDiffType(effectiveDiffType);
    if (commitRef) {
      const { sha } = commitRef;
      const infoArgs = ["log", "-1", `--pretty=format:%h${COMMIT_FIELD_SEP}%s`, "--end-of-options", sha];
      const info = assertGitSuccess(await runtime.runGit(infoArgs, { cwd }), infoArgs);
      const sepIdx = info.stdout.indexOf(COMMIT_FIELD_SEP);
      const shortSha = sepIdx === -1 ? sha.slice(0, 7) : info.stdout.slice(0, sepIdx);
      const subject = sepIdx === -1 ? "" : info.stdout.slice(sepIdx + 1).split("\n")[0];
      // Root commit has no parent — diff against the empty tree instead.
      const hasParent =
        (await runtime.runGit(["rev-parse", "--verify", "--quiet", `${sha}^`], { cwd }))
          .exitCode === 0;
      const baseRef = hasParent ? `${sha}^` : await getEmptyTreeSha(runtime, cwd);
      const commitDiffArgs = [
        "diff",
        "--no-ext-diff",
        ...wFlag,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--end-of-options",
        `${baseRef}..${sha}`,
      ];
      patch = assertGitSuccess(await runtime.runGit(commitDiffArgs, { cwd }), commitDiffArgs).stdout;
      label = subject ? `Commit ${shortSha} — ${subject}` : `Commit ${shortSha}`;
    } else if (effectiveDiffType.startsWith("commit:")) {
      return { patch: "", label: `Error: ${diffType}`, error: "Invalid commit ref" };
    } else switch (effectiveDiffType) {
      case "since-base": {
        // The composite "GitHub view": merge-base(base, HEAD) vs the working
        // tree (note: no right-hand ref on the diff), plus untracked files.
        // Exactly what a PR would show if the user committed and pushed now.
        const hasHead =
          (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd }))
            .exitCode === 0;
        let trackedPatch = "";
        if (hasHead) {
          // Resolve the merge-base with the requested base. When the base
          // doesn't exist (repo with no main/master/origin — e.g. a `trunk`
          // default and no remote) merge-base fails; degrade to HEAD so the
          // reviewer still sees their working-tree changes instead of a raw
          // git error. The sections sidecar degrades the same way.
          const mergeBaseResult = await runtime.runGit(
            ["merge-base", "--end-of-options", defaultBranch, "HEAD"],
            { cwd },
          );
          const mergeBase = mergeBaseResult.exitCode === 0
            ? mergeBaseResult.stdout.trim()
            : "HEAD";
          const sinceBaseDiffArgs = [
            "diff",
            "--no-ext-diff",
            ...wFlag,
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--end-of-options",
            mergeBase,
          ];
          trackedPatch = assertGitSuccess(
            await runtime.runGit(sinceBaseDiffArgs, { cwd }),
            sinceBaseDiffArgs,
          ).stdout;
        }
        const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options);
        patch = removeTrackedDeletions(trackedPatch, new Set(untracked.paths)) + untracked.diff;
        label = `All changes since ${displayRef(defaultBranch)}`;
        break;
      }

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
        const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options);
        patch = removeTrackedDeletions(trackedPatch, new Set(untracked.paths)) + untracked.diff;
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
        const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options);
        patch = removeTrackedDeletions(trackedDiff.stdout, new Set(untracked.paths)) + untracked.diff;
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
        label = `Changes vs ${displayRef(defaultBranch)}`;
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
        label = `PR diff vs ${displayRef(defaultBranch)}`;
        break;
      }

      case "all": {
        // Diff from the empty tree to HEAD — shows every tracked file as an addition.
        const emptyTree = await getEmptyTreeSha(runtime, cwd);
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

// --- Diff staleness fingerprint ---------------------------------------------
//
// A fingerprint is a small string capturing "what the repo looked like when
// this diff was computed". The server stores it beside the cached patch and
// recomputes it on demand; a mismatch means the diff on screen is stale (the
// agent/user changed files mid-review). `null` means "cannot fingerprint this
// mode" — callers must treat that as always-fresh (no staleness banner), never
// as stale.
//
// Per mode:
//  - Commit-anchored modes (last-commit, all, branch, merge-base) change only
//    when refs move → pure `rev-parse` fingerprints, ~10ms.
//  - Working-tree modes (uncommitted, staged, unstaged) must reflect CONTENT,
//    not just `git status` paths — a file that is already modified and gets
//    modified again produces identical porcelain output. So these hash the
//    same diff the patch itself is built from (still fast; it is exactly what
//    a refresh would re-run), plus untracked file contents (capped).

/** djb2-xor hash — cheap change-detection fingerprint, not cryptographic. */
export function hashFingerprintPart(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

const MAX_UNTRACKED_FINGERPRINT_FILES = 20;

/**
 * Circuit-breaker for the fingerprint's untracked enumeration. The freshness
 * poll runs `git status --porcelain -uall` every few seconds; on a repo with
 * a huge un-ignored tree (a forgotten `node_modules/`) that's megabytes of
 * output and sustained CPU for the whole session. Once a cwd's -uall output
 * exceeds the cap, it degrades PERMANENTLY (per process) to collapsed
 * `-unormal` — edits INSIDE untracked directories stop flipping the
 * fingerprint on that repo, which is the right trade on a repo that
 * pathological. The switch itself makes one probe hash differently, so the
 * staleness banner may fire once spuriously right after degrading.
 */
const UNTRACKED_STATUS_OUTPUT_CAP = 2 * 1024 * 1024;
const collapsedUntrackedCwds = new Set<string>();

export async function getGitDiffFingerprint(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string = "main",
  externalCwd?: string,
  options?: GitDiffOptions,
): Promise<string | null> {
  let cwd: string | undefined = externalCwd;
  let effectiveDiffType = diffType as string;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) return null;
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  const wFlag = options?.hideWhitespace ? ["-w"] : [];

  try {
    // --no-optional-locks: fingerprint probes run in the background (polled
    // every few seconds) and must NEVER take git's index lock — `status`/`diff`
    // opportunistically refresh the index by default, which races concurrent
    // `git add`/commit operations (the agent working while the user reviews).
    const runReadOnlyGit = (args: string[]) =>
      runtime.runGit(["--no-optional-locks", ...args], { cwd });

    // commit:<sha> — the diff is anchored to an immutable object, so the
    // fingerprint is the sha plus whether it still resolves. Deliberately NOT
    // headSha-coupled: new commits landing mid-review don't change this diff,
    // so they must not raise the staleness banner. If the commit vanishes from
    // the repo (rebase + gc), present→gone flips the fingerprint and the
    // banner fires — refreshing then surfaces the git error honestly.
    if (effectiveDiffType.startsWith("commit:")) {
      const commitRef = parseCommitDiffType(effectiveDiffType);
      if (!commitRef) return null;
      const resolves =
        (await runReadOnlyGit(["rev-parse", "--verify", "--quiet", `${commitRef.sha}^{commit}`]))
          .exitCode === 0;
      return `git:commit:${commitRef.sha}:${resolves ? "present" : "gone"}`;
    }

    const head = await runReadOnlyGit(["rev-parse", "HEAD"]);
    const headSha = head.exitCode === 0 ? head.stdout.trim() : "no-head";
    const parts = ["git", effectiveDiffType, headSha];

    const hashDiffOutput = async (args: string[]): Promise<boolean> => {
      const result = await runReadOnlyGit(["diff", "--no-ext-diff", ...wFlag, ...args]);
      if (result.exitCode !== 0) return false;
      parts.push(hashFingerprintPart(result.stdout));
      return true;
    };

    // Untracked files: porcelain `??` lines capture existence; hash their
    // contents too so editing a freshly-created (untracked) file is detected.
    // Capped — a pathological number of untracked files degrades to
    // existence-only detection rather than unbounded reads.
    const hashUntracked = async (): Promise<boolean> => {
      // -uall: without it, an untracked directory collapses to a single `?? dir/`
      // line, so edits to files inside it never change the fingerprint and the
      // "Diff out of date" banner never fires — even though the patch (which
      // enumerates individual untracked files) includes them. Match that here —
      // unless this cwd already tripped the output cap (see
      // UNTRACKED_STATUS_OUTPUT_CAP), in which case stay collapsed.
      const cwdKey = cwd ?? "";
      const collapsed = collapsedUntrackedCwds.has(cwdKey);
      const status = await runReadOnlyGit([
        "status",
        "--porcelain",
        collapsed ? "-unormal" : "-uall",
      ]);
      if (status.exitCode !== 0) return false;
      if (!collapsed && status.stdout.length > UNTRACKED_STATUS_OUTPUT_CAP) {
        collapsedUntrackedCwds.add(cwdKey);
      }
      parts.push(hashFingerprintPart(status.stdout));
      const untracked = status.stdout
        .split("\n")
        .filter((line) => line.startsWith("?? "))
        // Unquote — porcelain double-quotes any path with a space/unicode
        // regardless of core.quotePath, and a raw quoted string never resolves
        // on disk (so the fingerprint would go blind to edits on those files).
        .map((line) => unquoteGitPath(line.slice(3).trim()))
        .slice(0, MAX_UNTRACKED_FINGERPRINT_FILES);
      if (untracked.length > 0) {
        // Porcelain paths are repo-root-relative, NOT cwd-relative. Resolve them
        // against the git toplevel so a review launched from a subdirectory can
        // still read (and hash edits to) untracked files — resolving against cwd
        // double-prefixes the path, readTextFile returns null, and the untracked
        // half of the fingerprint goes permanently blind.
        const baseDir = await resolveRepoToplevel(runtime, cwd);
        for (const path of untracked) {
          const content = await runtime.readTextFile(baseDir ? resolvePath(baseDir, path) : path);
          parts.push(content != null ? hashFingerprintPart(content) : "unreadable");
        }
      }
      return true;
    };

    switch (effectiveDiffType) {
      case "since-base": {
        // Content hash of the mb→worktree diff catches edits; headSha (always
        // in `parts`) catches commits that only re-partition the sections;
        // the status hash inside hashUntracked catches stage/unstage flips.
        if (headSha !== "no-head") {
          // Degrade to HEAD when merge-base fails (base ref unresolvable, or the
          // base and HEAD have unrelated histories). runGitDiff/getSinceBaseSections/
          // getFileContentsForDiff all fall back to HEAD; the fingerprint must too,
          // or `null` here would report "always fresh" and the staleness banner
          // would never fire for the whole session on such repos.
          const mb = await runReadOnlyGit(["merge-base", "--end-of-options", defaultBranch, "HEAD"]);
          const mergeBase = mb.exitCode === 0 ? mb.stdout.trim() : "HEAD";
          parts.push(mergeBase);
          if (!(await hashDiffOutput(["--end-of-options", mergeBase]))) return null;
        }
        if (!(await hashUntracked())) return null;
        break;
      }
      case "uncommitted": {
        if (headSha !== "no-head" && !(await hashDiffOutput(["HEAD"]))) return null;
        if (!(await hashUntracked())) return null;
        break;
      }
      case "staged": {
        if (!(await hashDiffOutput(["--staged"]))) return null;
        break;
      }
      case "unstaged": {
        if (!(await hashDiffOutput([]))) return null;
        if (!(await hashUntracked())) return null;
        break;
      }
      case "branch":
      case "merge-base": {
        const baseTip = await runReadOnlyGit(["rev-parse", "--end-of-options", defaultBranch]);
        parts.push(baseTip.exitCode === 0 ? baseTip.stdout.trim() : "no-base");
        break;
      }
      case "last-commit":
      case "all":
        // HEAD alone identifies these.
        break;
      default:
        return null;
    }
    return parts.join(":");
  } catch {
    return null;
  }
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
    // Patch paths are repo-root-relative; resolve against the toplevel, not
    // cwd — from a subdirectory launch, cwd-resolution double-prefixes the
    // path and hunk expansion silently returns null. (The `git show ref:path`
    // sibling is immune: ref paths are root-relative regardless of cwd.)
    const baseDir = await resolveRepoToplevel(runtime, cwd);
    const fullPath = baseDir ? resolvePath(baseDir, path) : path;
    return runtime.readTextFile(fullPath);
  }

  // commit:<sha> — old side is the first parent (null on a root commit, which
  // correctly renders every file as an addition), new side the commit itself.
  const commitRef = parseCommitDiffType(effectiveDiffType);
  if (commitRef) {
    return {
      oldContent: await gitShow(`${commitRef.sha}^`, oldFilePath),
      newContent: await gitShow(commitRef.sha, filePath),
    };
  }

  switch (effectiveDiffType) {
    case "since-base": {
      const mbResult = await runtime.runGit(["merge-base", "--end-of-options", defaultBranch, "HEAD"], { cwd });
      // Degrade to HEAD (matching runGitDiff), not defaultBranch — when the base
      // doesn't resolve, the patch is computed against HEAD, so the expanded
      // old-side content must come from HEAD too or it won't match what the
      // reviewer is reading.
      const mb = mbResult.exitCode === 0 ? mbResult.stdout.trim() : "HEAD";
      return {
        oldContent: await gitShow(mb, oldFilePath),
        newContent: await readWorkingTree(filePath),
      };
    }
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

// --- Since-base sections -----------------------------------------------------
//
// The "since-base" composite diff is one patch (merge-base → working tree +
// untracked); the UI's three-stack panel groups its files by lifecycle state.
// This sidecar carries that grouping. Per-file A/M/D/R status is NOT here —
// the client already derives it from the patch itself.

export interface SinceBaseSectionEntry {
  group: "committed" | "changes" | "untracked";
  /** True when the file has staged (index) changes — porcelain column X.
   *  SNAPSHOT value from when the sidecar was computed. For DISPLAY, always
   *  render from the client's effective stagedFiles set (useGitAdd folds
   *  this in with session overrides) — never OR this flag back in, or files
   *  unstaged mid-session keep a stale staged indicator. */
  staged: boolean;
}

export interface SinceBaseSections {
  /** The base ref the merge-base was computed against, e.g. `origin/main`. */
  base: string;
  /** Resolved merge-base SHA ("" when the repo has no HEAD yet). */
  mergeBase: string;
  /** Repo-root-relative path → section entry. Paths match the patch's. */
  files: Record<string, SinceBaseSectionEntry>;
}

/**
 * Split a porcelain rename/copy path token (`<from> -> <to>`) into its two
 * sides. Git double-quotes a side when it contains a double quote, backslash,
 * control char, or (with core.quotePath on) non-ASCII — in those cases the
 * real separator is the ` -> ` OUTSIDE the quoted span, so a leading quote is
 * skipped before searching. Plain spaces are NOT quoted by porcelain v1,
 * which means a filename literally containing ` -> ` (and nothing else
 * unusual) is emitted unquoted and ambiguous — only `--porcelain -z` fully
 * disambiguates. Accepted edge: such a name splits at its first separator
 * and both sides misgroup to "committed" in the sidebar; nothing else breaks.
 * Returns [from, to] for a rename/copy, or [token] otherwise.
 */
export function splitPorcelainRename(rest: string): string[] {
  let searchFrom = 0;
  if (rest.startsWith('"')) {
    // Skip past the closing quote of the (quoted) from-path, honoring \" escapes.
    let i = 1;
    for (; i < rest.length; i++) {
      if (rest[i] === "\\") { i++; continue; }
      if (rest[i] === '"') { i++; break; }
    }
    searchFrom = i;
  }
  const sep = rest.indexOf(" -> ", searchFrom);
  return sep !== -1 ? [rest.slice(0, sep), rest.slice(sep + 4)] : [rest];
}

/**
 * Partition the since-base file set by `git status` state:
 *  - `??`                → untracked
 *  - any other dirty XY  → changes (staged = column X is set)
 *  - in mb..HEAD, clean  → committed
 *
 * Best-effort: returns null when the repo can't answer (callers omit the
 * sidecar rather than failing the diff).
 */
export async function getSinceBaseSections(
  runtime: ReviewGitRuntime,
  defaultBranch: string,
  cwd?: string,
): Promise<SinceBaseSections | null> {
  try {
    // --no-optional-locks: never take the index lock for a read-only sidecar
    // (the agent may be running git concurrently). -uall lists untracked
    // files individually so entries match the patch's per-file paths instead
    // of collapsing whole untracked directories.
    const status = await runtime.runGit(
      ["--no-optional-locks", "status", "--porcelain", "-uall"],
      { cwd },
    );
    if (status.exitCode !== 0) return null;

    const files: Record<string, SinceBaseSectionEntry> = {};
    for (const line of status.stdout.split("\n")) {
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const rest = line.slice(3);

      if (x === "?" && y === "?") {
        // Untracked. Don't clobber an existing tracked entry for the same
        // path: `git rm --cached f` emits BOTH `D  f` (staged delete) and
        // `?? f` (now-untracked file) — the tracked/staged signal wins.
        const path = unquoteGitPath(rest.trim());
        if (path && !files[path]) files[path] = { group: "untracked", staged: false };
        continue;
      }

      // Tracked change (always wins over a prior untracked entry). Renames /
      // copies list `orig -> dest`; record BOTH sides as changes. If a rename
      // is followed by a working-tree edit that drops similarity below git's
      // threshold, the since-base patch emits SEPARATE delete(orig)+add(dest)
      // chunks — recording only dest would leave the deleted `orig` half with
      // no sidecar entry, defaulting it to Committed. Both-sides prevents that.
      const staged = x !== " " && x !== "?";
      for (const token of splitPorcelainRename(rest)) {
        const path = unquoteGitPath(token.trim());
        if (path) files[path] = { group: "changes", staged };
      }
    }

    let mergeBase = "";
    const hasHead =
      (await runtime.runGit(["--no-optional-locks", "rev-parse", "--verify", "HEAD"], { cwd }))
        .exitCode === 0;
    if (hasHead) {
      const mbResult = await runtime.runGit(
        ["--no-optional-locks", "merge-base", "--end-of-options", defaultBranch, "HEAD"],
        { cwd },
      );
      // Degrade to HEAD when the base can't be resolved (matches runGitDiff):
      // the "committed since base" set becomes empty rather than nulling the
      // whole sidecar, so the panel still renders Changes/Untracked.
      mergeBase = mbResult.exitCode === 0 ? mbResult.stdout.trim() : "HEAD";

      const committed = await runtime.runGit(
        [
          "--no-optional-locks",
          "diff",
          "--no-ext-diff",
          "--name-only",
          "--end-of-options",
          `${mergeBase}..HEAD`,
        ],
        { cwd },
      );
      if (committed.exitCode !== 0) return null;
      for (const line of committed.stdout.split("\n")) {
        const path = unquoteGitPath(line.trim());
        if (!path) continue;
        // Dirty state wins: a file with both committed and working-tree
        // changes lives in "changes" (its diff still shows the full story).
        if (!files[path]) files[path] = { group: "committed", staged: false };
      }
    }

    return { base: defaultBranch, mergeBase, files };
  } catch {
    return null;
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
  // Patch paths are repo-root-relative; from a subdirectory launch the
  // pathspec must be applied at the toplevel or `git add` fails with
  // "did not match any files".
  await ensureGitSuccess(runtime, ["add", "--", filePath], await resolveRepoToplevel(runtime, cwd));
}

export async function gitResetFile(
  runtime: ReviewGitRuntime,
  filePath: string,
  cwd?: string,
): Promise<void> {
  validateFilePath(filePath);
  // Toplevel for the same reason as gitAddFile.
  await ensureGitSuccess(runtime, ["reset", "HEAD", "--", filePath], await resolveRepoToplevel(runtime, cwd));
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

/**
 * Extract per-file path + line-count stats from a raw unified diff patch.
 * Mirrors the client's packages/review-editor/utils/diffParser.ts chunk-split
 * and additions/deletions counting logic, but only needs path/additions/
 * deletions (no status/oldPath) — used server-side to give agent-job
 * providers (e.g. Guided Review) the authoritative changed-file set to plan
 * against, without duplicating the VCS-agnostic diff-splitting logic.
 */
export function listPatchFiles(
  patch: string,
): { path: string; additions: number; deletions: number }[] {
  if (!patch) return [];

  const chunkStarts = [...patch.matchAll(/^diff --git /gm)];
  if (chunkStarts.length === 0) return [];

  const files: { path: string; additions: number; deletions: number }[] = [];

  for (let i = 0; i < chunkStarts.length; i++) {
    const start = chunkStarts[i].index ?? 0;
    const end = chunkStarts[i + 1]?.index ?? patch.length;
    const lines = patch.slice(start, end).split("\n");

    // Prefer the --- /+++ path lines (present on every non-mode-only chunk);
    // fall back to the "diff --git a/x b/y" header for the rare chunk that
    // lacks them (e.g. a pure mode change).
    const { oldPath: bodyOldPath, newPath: bodyNewPath } = parseDiffFilePathLines(lines);
    const headerPaths = parseDiffGitHeader(lines[0] ?? "");
    const path = bodyNewPath ?? bodyOldPath ?? headerPaths.newPath ?? headerPaths.oldPath;
    if (!path) continue;

    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    files.push({ path, additions, deletions });
  }

  return files;
}
