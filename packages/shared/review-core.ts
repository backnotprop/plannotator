import {
  formatDiffMetadataPathToken,
  formatPatchPathToken,
  unquoteGitPath,
  parsePatchPathToken,
  parseDiffFilePathLines,
  parseDiffGitHeader,
  parseDiffMetadataPathLines,
  OVERSIZED_REVIEW_STUB_MARKER,
} from "./diff-paths";
import { parseDiffToFiles } from "@plannotator/core/diff-files";

import {
  BARE_HEX_SHA_RE,
  JJ_TRUNK_REVSET,
  commitFamilyId,
  jjCommitRevset,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseCommitDiffType,
  parseJjCommitDiffType,
  parseRemoteBookmark,
  parseWorktreeDiffType,
  type DiffType,
} from "@plannotator/core/diff-type";

export {
  BARE_HEX_SHA_RE,
  JJ_TRUNK_REVSET,
  commitFamilyId,
  jjCommitRevset,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseCommitDiffType,
  parseJjCommitDiffType,
  parseRemoteBookmark,
  parseWorktreeDiffType,
};
export type { DiffType };

export const MAX_REVIEW_FILE_CONTENT_BYTES = 5 * 1024 * 1024;

const MAX_UNTRACKED_DIFF_CONCURRENCY = 4;
// Fingerprints run every few seconds, so their read ceiling is lower than one-shot diff generation; larger files use size + mtime.
const MAX_UNTRACKED_FINGERPRINT_CONTENT_BYTES = 1024 * 1024;

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

export interface ReviewBaseCandidate {
  revision: string;
  labels: string[];
  subject: string;
}

export interface ReviewDiffFallback {
  requestedDiffType: string;
  effectiveDiffType: string;
  message: string;
  candidates?: ReviewBaseCandidate[];
}

export interface DiffAvailability {
  fallbackDiffType: string;
  message: string;
  candidates?: ReviewBaseCandidate[];
}

export interface JjRevisionInfo {
  commitId: string;
  bookmarks: string[];
  subject: string;
}

export type JjLineBaseResolution =
  | { kind: "resolved"; revision: JjRevisionInfo }
  | { kind: "ambiguous"; candidates: JjRevisionInfo[] }
  | { kind: "unavailable"; reason: string };

export interface JjEvoLogEntry {
  commitId: string;
  description: string;
  age?: string;
}

export interface RecentCommit {
  sha: string;
  shortSha: string;
  subject: string;
  relativeDate: string;
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
  diffAvailability?: Record<string, DiffAvailability>;
  diffFallback?: ReviewDiffFallback;
  cwd?: string;
  /** Absolute repo top level; patch paths are relative to it, while `cwd` may be a subfolder. Git only. */
  root?: string;
  vcsType?: "git" | "gitbutler" | "jj" | "p4";
  gitButlerRevision?: string;
  jjLineBase?: JjLineBaseResolution;
  jjEvologs?: JjEvoLogEntry[];
  recentCommits?: RecentCommit[];
}

export interface DiffResult {
  patch: string;
  label: string;
  fileIdentities?: Record<string, string>;
  error?: string;
  gitContext?: GitContext;
  fingerprint?: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when `maxOutputBytes` was reached and the command was killed: `exitCode` reports the signal and `stdout` is a prefix. */
  truncated?: boolean;
}

export interface GitCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  interaction?: "allow" | "forbid";
  /** Past the limit the runtime stops reading and kills the command; the result is flagged `truncated`. */
  maxOutputBytes?: number;
  /** Injected as GIT_CONFIG_* env vars, deliberately not `-c` argv: callers and tests match on the exact argv. */
  config?: Record<string, string>;
}

export interface PreparedGitCommand {
  args: string[];
  env?: Record<string, string | undefined>;
  isolateProcessGroup: boolean;
}

export interface ReviewFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isSymbolicLink: boolean;
  isExecutable: boolean;
}

export interface ReviewGitRuntime {
  runGit: (
    args: string[],
    options?: GitCommandOptions,
  ) => Promise<GitCommandResult>;
  readTextFile: (path: string) => Promise<string | null>;
  getFileInfo: (
    basePath: string | undefined,
    path: string,
  ) => Promise<ReviewFileInfo | null>;
  readLink: (path: string) => Promise<string | null>;
  /** Raw stdout bytes (never UTF-8 decoded), honoring `maxOutputBytes`. Optional: without it, binary sides are unavailable. */
  runGitBytes?: (
    args: string[],
    options?: GitCommandOptions,
  ) => Promise<GitBytesCommandResult>;
  readFileBytes?: (path: string, maxBytes: number) => Promise<Uint8Array | null>;
  realPath?: (path: string) => Promise<string | null>;
}

export interface GitBytesCommandResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
}

/** `missing`: absent object, vanished file, symlink, or a path escaping the repository; `unavailable`: the runtime or mode cannot read bytes. */
export type FileBytesRead =
  | { kind: "ok"; bytes: Uint8Array; etag?: string }
  | { kind: "missing" }
  | { kind: "too-large"; size: number }
  | { kind: "unavailable" };

export type DiffSide = "old" | "new";

/** A git object (`<rev>:<path>`, read with `cat-file`, never `show`) or the working tree (path relative to the repo toplevel). */
export type DiffSideSource =
  | { kind: "object"; rev: string; path: string }
  | { kind: "worktree"; path: string };

export interface DiffSideSources {
  cwd?: string;
  old: DiffSideSource | null;
  new: DiffSideSource | null;
}

function quoteGitSshPath(path: string): string {
  return `"${path.replace(/["\\$`]/g, "\\$&")}"`;
}

function inheritedSshCommand(environment: Readonly<Record<string, string | undefined>>): string {
  const command = environment.GIT_SSH_COMMAND?.trim();
  if (command) return command;
  const executable = environment.GIT_SSH?.trim();
  return executable ? quoteGitSshPath(executable) : "ssh";
}

function usesPlink(
  environment: Readonly<Record<string, string | undefined>>,
  sshCommand: string,
): boolean {
  const variant = environment.GIT_SSH_VARIANT?.trim().toLowerCase();
  if (variant === "plink" || variant === "tortoiseplink") return true;
  if (variant === "ssh" || variant === "simple") return false;
  return /(?:^|[\\/])(?:tortoise)?plink(?:\.exe)?(?:[\s"']|$)/i.test(sshCommand);
}

/** Entries append after config already in the inherited env (git reads keys 0..COUNT-1). Null when there is nothing to add. */
function gitConfigEnvironment(
  config: Record<string, string> | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> | null {
  const entries = Object.entries(config ?? {});
  if (entries.length === 0) return null;
  const inheritedCount = Number(environment.GIT_CONFIG_COUNT ?? "0");
  const offset =
    Number.isSafeInteger(inheritedCount) && inheritedCount > 0 ? inheritedCount : 0;
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(offset + entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${offset + index}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  return env;
}

/** `color.ui=never` alone is not enough: a specific key like `color.diff=always` overrides it, so every command-specific color key is set too. `--no-pager` rules out `pager.<cmd>`. */
const GIT_COLOR_FREE_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  "color.ui": "never",
  "color.diff": "never",
  "color.status": "never",
  "color.branch": "never",
  "color.grep": "never",
  "color.showBranch": "never",
  "color.interactive": "never",
});

export const GIT_COLOR_FREE_ARGS: readonly string[] = Object.freeze([
  "--no-pager",
  ...Object.entries(GIT_COLOR_FREE_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
]);

/** Same color-off settings as env vars for spawned processes that run git themselves. Git older than 2.31 ignores them. */
export function gitColorFreeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return gitConfigEnvironment({ ...GIT_COLOR_FREE_CONFIG }, environment) ?? {};
}

/** Non-interactive commands disable credential prompts, request SSH batch mode and process-group isolation so the runtime can kill transport children on timeout. */
export function prepareGitCommand(
  args: string[],
  options: GitCommandOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): PreparedGitCommand {
  const configEnv = gitConfigEnvironment(options?.config, environment);
  const interaction = options?.interaction ?? "allow";
  if (interaction === "allow") {
    return {
      args: [...GIT_COLOR_FREE_ARGS, "-c", "core.quotePath=false", ...args],
      ...(configEnv ? { env: { ...environment, ...configEnv } } : {}),
      isolateProcessGroup: false,
    };
  }

  const sshCommand = inheritedSshCommand(environment);
  const connectTimeoutSeconds = Math.max(1, Math.ceil((options?.timeoutMs ?? 5_000) / 1_000));
  const sshBatchOptions = usesPlink(environment, sshCommand)
    ? "-batch"
    : `-o BatchMode=yes -o ConnectTimeout=${connectTimeoutSeconds}`;

  return {
    args: [
      ...GIT_COLOR_FREE_ARGS,
      "-c",
      "core.quotePath=false",
      "-c",
      "credential.interactive=false",
      ...args,
    ],
    env: {
      ...environment,
      ...configEnv,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: `${sshCommand} ${sshBatchOptions}`,
      SSH_ASKPASS_REQUIRE: "never",
    },
    isolateProcessGroup: true,
  };
}

export interface GitDiffOptions {
  captureFileIdentities?: boolean;
  hideWhitespace?: boolean;
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
  // Prefer the remote tracking ref so diffs run against the upstream tip, not a stale local copy; fall back to a local ref only when no remote exists.
  const remoteHead = await runtime.runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  if (remoteHead.exitCode === 0) {
    const ref = remoteHead.stdout.trim();
    if (ref) {
      // `symbolic-ref` only says what origin/HEAD points at; in partial clones the target may be missing, so verify it exists.
      const verify = await runtime.runGit(
        ["show-ref", "--verify", "--quiet", ref],
        { cwd },
      );
      if (verify.exitCode === 0) return ref.replace("refs/remotes/", "");
    }
  }

  // origin/HEAD is often unset and there may be no local main/master, yet the remote-tracking ref is diffable; check it before local names and the blind "master" guess.
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

/** Rate-limits the remote-default probe: it is a network round trip, and a physical touch prompt on smartcard-backed SSH. */
export const REMOTE_BASE_CHECK_INTERVAL_MS = 60_000;

/** Backoff ceiling: a failing remote stays failing, and retrying at the base cadence kept waking a hardware key. */
export const REMOTE_BASE_CHECK_MAX_INTERVAL_MS = 900_000;

/** Next probe interval: the base when the remote answered, otherwise doubled up to the cap. */
export function nextRemoteBaseCheckInterval(
  currentIntervalMs: number,
  succeeded: boolean,
): number {
  if (succeeded) return REMOTE_BASE_CHECK_INTERVAL_MS;
  return Math.min(currentIntervalMs * 2, REMOTE_BASE_CHECK_MAX_INTERVAL_MS);
}

export interface RemoteDefaultInfo {
  branch: string;
  remoteHeadSha: string | null;
}

/** Queries the remote default branch via `ls-remote --symref`; null if it does not answer, times out, or the tracking ref is missing locally. Non-interactive, never throws. */
export async function detectRemoteDefaultInfo(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<RemoteDefaultInfo | null> {
  try {
    const lsRemote = await runtime.runGit(
      ["ls-remote", "--symref", "origin", "HEAD"],
      { cwd, timeoutMs: 5000, interaction: "forbid" },
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
    const shaMatch = lsRemote.stdout.match(/^([0-9a-f]{40,64})\s+HEAD$/m);
    return { branch: remoteBranch, remoteHeadSha: shaMatch ? shaMatch[1] : null };
  } catch {
    return null;
  }
}

export async function detectRemoteDefaultBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | null> {
  return (await detectRemoteDefaultInfo(runtime, cwd))?.branch ?? null;
}

const RECENT_COMMIT_LIMIT_DEFAULT = 20;
// US (\x1F) separator avoids collisions with commit subjects, author names, and dates.
export const COMMIT_FIELD_SEP = "\x1f";

/** Splits into exactly `head + 1 + tail` fields: a literal US byte in the one free-text field over-splits, so the middle is rejoined. Null when there are fewer fields than the format guarantees. */
export function splitCommitFormatFields(value: string, head: number, tail: number): string[] | null {
  const parts = value.split(COMMIT_FIELD_SEP);
  if (parts.length < head + tail + 1) return null;
  return [
    ...parts.slice(0, head),
    parts.slice(head, parts.length - tail).join(COMMIT_FIELD_SEP),
    ...parts.slice(parts.length - tail),
  ];
}

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
  // Emit the full refname so refs classify by prefix; local branches can contain `/`.
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

  // Keep local and remote refs: they can point to different commits (stale tracking branches are common).
  local.sort();
  remote.sort();

  return { local, remote };
}

/** Trusts a caller-supplied base verbatim (tags, SHAs and non-origin remotes must not be rewritten); invalid refs surface as git errors on the next diff. */
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

  // Offer since-base only when the base ref resolves: getDefaultBranch can return a literal "master" that does not exist, and since-base would become the default, merge-base would fail, and the diff would degrade to HEAD, hiding branch work.
  if (defaultBranch) {
    const baseResolves = (
      await runtime.runGit(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${defaultBranch}^{commit}`],
        { cwd },
      )
    ).exitCode === 0;
    if (baseResolves) {
      diffOptions.push({ id: "since-base", label: `All changes since ${displayRef(defaultBranch)}` });
    }
  }

  const upstreamBranch = await getCurrentUpstreamBranch(runtime, cwd);
  if (upstreamBranch) {
    diffOptions.push({ id: "local-vs-remote", label: "Local vs remote branch" });
  }

  diffOptions.push(
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  );

  // Always offered: preserving diff mode across worktree switches or Pi's `initialBase` can land on the default branch with branch/merge-base already active, and hiding the option would trap the reviewer.
  if (defaultBranch) {
    diffOptions.push({ id: "merge-base", label: "Committed changes (PR view)" });
  }

  diffOptions.push({ id: "all", label: "Every file (HEAD)" });

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
    ...(currentTreePath ? { root: currentTreePath } : {}),
    vcsType: "git",
    recentCommits,
  };
}

/**
 * Drops tracked deletions whose path also exists untracked (`git rm --cached f` reports both); the on-disk content wins, so each path has one entry.
 * Accepted edges: binary deletions have no `--- ` line and are not deduped; a deletion committed on the branch whose path was recreated untracked is deduped too.
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

/** Patch paths are repo-root-relative; resolving them against a subdirectory cwd double-prefixes them. Falls back to cwd when rev-parse fails. */
async function resolveRepoToplevel(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | undefined> {
  const top = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
  const trimmed = top.exitCode === 0 ? top.stdout.trim() : "";
  return trimmed || cwd;
}

interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  oldObjectId: string;
  newObjectId: string;
  status: string;
  oldPath: string | null;
  newPath: string | null;
}

interface OversizedTrackedDiffEntry extends RawDiffEntry {
  oldObjectId: string;
  newObjectId: string;
}

const NULL_OBJECT_ID = /^0+$/;

function parseRawDiffEntries(output: string): RawDiffEntry[] {
  const fields = output.split("\0");
  const entries: RawDiffEntry[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index++];
    if (!header) continue;
    if (!header.startsWith(":")) {
      throw new Error("git diff --raw returned an invalid record");
    }

    const metadata = header.slice(1).split(" ");
    if (metadata.length !== 5 || !metadata[4]) {
      throw new Error("git diff --raw returned malformed metadata");
    }
    const [oldMode, newMode, oldObjectId, newObjectId, status] = metadata;
    const renamedOrCopied = status[0] === "R" || status[0] === "C";
    const oldPath = fields[index++] ?? null;
    const newPath = renamedOrCopied ? fields[index++] ?? null : oldPath;
    if (!oldPath || !newPath) {
      throw new Error("git diff --raw returned a record without a path");
    }

    entries.push({
      oldMode,
      newMode,
      oldObjectId,
      newObjectId,
      status,
      oldPath: status[0] === "A" ? null : oldPath,
      newPath: status[0] === "D" ? null : newPath,
    });
  }

  return entries;
}

function isNullObjectId(objectId: string): boolean {
  return NULL_OBJECT_ID.test(objectId);
}

function isGitlink(entry: RawDiffEntry): boolean {
  return entry.oldMode === "160000" || entry.newMode === "160000";
}

/** Null when the batch command fails; callers then rely on `core.bigFileThreshold` (`BOUNDED_DIFF_GIT_CONFIG`). Per object, null means unknown, never oversized: `missing` is routine for tree-vs-worktree diffs (rename/copy detection hashes working-tree content) and partial clones. Working-tree sizes come from stat. */
async function getGitObjectSizes(
  runtime: ReviewGitRuntime,
  objectIds: string[],
  cwd?: string,
): Promise<Map<string, number | null> | null> {
  const uniqueObjectIds = [...new Set(objectIds.filter((objectId) => !isNullObjectId(objectId)))];
  const sizes = new Map<string, number | null>();
  if (uniqueObjectIds.length === 0) return sizes;

  const result = await runtime.runGit(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      cwd,
      stdin: `${uniqueObjectIds.join("\n")}\n`,
      timeoutMs: 5000,
      interaction: "forbid",
    },
  );
  if (result.exitCode !== 0) return null;

  for (const line of result.stdout.split("\n")) {
    const [objectId, objectType, objectSize] = line.split(" ");
    if (!objectId || objectType === "missing") continue;
    const size = Number(objectSize);
    sizes.set(objectId, Number.isFinite(size) && size >= 0 ? size : null);
  }
  for (const objectId of uniqueObjectIds) {
    if (!sizes.has(objectId)) sizes.set(objectId, null);
  }
  return sizes;
}

async function getWorkingTreeFileInfo(
  runtime: ReviewGitRuntime,
  root: string | undefined,
  path: string | null,
): Promise<ReviewFileInfo | null> {
  if (!path) return null;
  try {
    const fileInfo = await runtime.getFileInfo(root, path);
    return fileInfo?.isFile || fileInfo?.isSymbolicLink ? fileInfo : null;
  } catch {
    return null;
  }
}

async function hashOversizedWorkingTreeFile(
  runtime: ReviewGitRuntime,
  path: string,
  file: ReviewFileInfo,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runGit(
    ["hash-object", "--no-filters", "--", file.path],
    { cwd },
  );
  if (result.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(result.stdout.trim())) {
    return result.stdout.trim();
  }
  // The patch stays omitted even if a concurrently deleted file cannot be hashed; keep stat metadata for freshness.
  return hashFingerprintPart(`${path}:${file.size}:${file.mtimeMs}`);
}

function buildOversizedTrackedStub(entry: OversizedTrackedDiffEntry): string {
  const headerOldToken = formatPatchPathToken("a", entry.oldPath ?? entry.newPath!);
  const headerNewToken = formatPatchPathToken("b", entry.newPath ?? entry.oldPath!);
  const oldToken = entry.oldPath ? formatPatchPathToken("a", entry.oldPath) : "/dev/null";
  const newToken = entry.newPath ? formatPatchPathToken("b", entry.newPath) : "/dev/null";
  const oldId = isNullObjectId(entry.oldObjectId) ? "000000000000" : entry.oldObjectId.slice(0, 12);
  const newId = isNullObjectId(entry.newObjectId) ? "000000000000" : entry.newObjectId.slice(0, 12);
  // Marks this as our size-cap stub rather than a real binary, so the card can say why it has no contents.
  const lines = [
    `diff --git ${headerOldToken} ${headerNewToken}`,
    OVERSIZED_REVIEW_STUB_MARKER,
  ];

  if (!entry.oldPath) lines.push(`new file mode ${entry.newMode}`);
  if (!entry.newPath) lines.push(`deleted file mode ${entry.oldMode}`);
  if (entry.status[0] === "R") {
    const similarity = Number(entry.status.slice(1));
    if (Number.isFinite(similarity)) lines.push(`similarity index ${similarity}%`);
    lines.push(`rename from ${formatDiffMetadataPathToken(entry.oldPath!)}`);
    lines.push(`rename to ${formatDiffMetadataPathToken(entry.newPath!)}`);
  } else if (entry.status[0] === "C") {
    const similarity = Number(entry.status.slice(1));
    if (Number.isFinite(similarity)) lines.push(`similarity index ${similarity}%`);
    lines.push(`copy from ${formatDiffMetadataPathToken(entry.oldPath!)}`);
    lines.push(`copy to ${formatDiffMetadataPathToken(entry.newPath!)}`);
  }
  if (entry.oldPath && entry.newPath && entry.oldMode !== entry.newMode) {
    lines.push(`old mode ${entry.oldMode}`);
    lines.push(`new mode ${entry.newMode}`);
  }
  lines.push(
    `index ${oldId}..${newId}${entry.oldMode === entry.newMode ? ` ${entry.newMode}` : ""}`,
  );
  if (entry.oldObjectId !== entry.newObjectId) {
    lines.push(`Binary files ${oldToken} and ${newToken} differ`);
  }
  lines.push("");
  return lines.join("\n");
}

interface BoundedTrackedDiff {
  patch: string;
  fingerprintMetadata: string[];
}

/** Makes git treat blobs above the review cap as binary stubs, so patch output stays bounded even when the size probe cannot run. Env entries, never `-c` argv, so argv stays byte-identical. */
const BOUNDED_DIFF_GIT_CONFIG: Record<string, string> = {
  "core.bigFileThreshold": String(MAX_REVIEW_FILE_CONTENT_BYTES),
};

/** Over-limit paths found by a raw no-textconv preflight are excluded by literal pathspec and replaced with a binary stub carrying a content-sensitive id. The size probe is best-effort; `BOUNDED_DIFF_GIT_CONFIG` and stat-based exclusion of working-tree sides bound the rest. */
async function buildBoundedTrackedDiff(
  runtime: ReviewGitRuntime,
  args: string[],
  cwd?: string,
  fingerprintMode = false,
  fileIdentities?: Record<string, string>,
): Promise<BoundedTrackedDiff> {
  const diffIndex = args.indexOf("diff");
  if (diffIndex === -1) throw new Error("Expected a git diff command");
  // Textconv is disabled only for the preflight; the rendered diff keeps it for sub-threshold paths.
  const rawFlags = args.includes("--no-textconv") ? [] : ["--no-textconv"];
  const rawArgs = [
    ...args.slice(0, diffIndex + 1),
    ...rawFlags,
    "--raw",
    "-z",
    "--no-abbrev",
    ...args.slice(diffIndex + 1),
  ];
  const rawResult = assertGitSuccess(await runtime.runGit(rawArgs, { cwd }), rawArgs);
  const entries = parseRawDiffEntries(rawResult.stdout);
  // Set when a side's size is unknown and nothing else bounds it: git consults core.bigFileThreshold only when it decides binaryness itself, and a textconv driver skips that, so such a render turns textconv off.
  let gitBoundOnly = false;
  const render = async (patchArgs: string[]) => {
    const flags = [
      ...(gitBoundOnly && !args.includes("--no-textconv") ? ["--no-textconv"] : []),
      ...(fileIdentities ? ["--raw", "-z", "--patch", "--no-abbrev"] : []),
    ];
    const command = [...patchArgs.slice(0, diffIndex + 1), ...flags, ...patchArgs.slice(diffIndex + 1)];
    const result = assertGitSuccess(await runtime.runGit(command, { cwd, config: BOUNDED_DIFF_GIT_CONFIG }), command);
    return fileIdentities ? extractReviewPatch(runtime, result.stdout, fileIdentities, cwd) : result.stdout;
  };
  if (entries.length === 0) {
    return {
      patch: await render(args),
      fingerprintMetadata: [],
    };
  }

  const root = await resolveRepoToplevel(runtime, cwd);
  const oversized: OversizedTrackedDiffEntry[] = [];
  const fingerprintMetadata: string[] = [];
  const nonGitlinks = entries.filter((entry) => !isGitlink(entry));
  const objectSizes = await getGitObjectSizes(
    runtime,
    nonGitlinks.flatMap((entry) => [entry.oldObjectId, entry.newObjectId]),
    cwd,
  );
  // A failed probe (null) must not mark everything oversized. Blob sides are bounded by BOUNDED_DIFF_GIT_CONFIG, so unknown reads as not oversized; working-tree sides are not covered by it but are sized by stat; an id the probe could not size (missing, omitted, unparseable) is unknown, never oversized.
  const probedSize = (objectId: string): number | null =>
    isNullObjectId(objectId) || objectSizes === null
      ? null
      : objectSizes.get(objectId) ?? null;
  for (const entry of entries) {
    if (isGitlink(entry)) continue;
    const oldSize = probedSize(entry.oldObjectId);
    const newObjectSize = probedSize(entry.newObjectId);
    // The working-tree file is what git formats when the new side has no readable object (all-zero id, or an id a successful probe could not find), so its stat size bounds it. A failed probe says nothing per object, so those ids rely on core.bigFileThreshold.
    const newSideUnreadable = isNullObjectId(entry.newObjectId)
      || (objectSizes !== null && newObjectSize === null);
    const workingTreeInfo = newSideUnreadable
      ? await getWorkingTreeFileInfo(runtime, root, entry.newPath)
      : null;
    const newSize = newObjectSize ?? workingTreeInfo?.size ?? null;
    if ((!isNullObjectId(entry.oldObjectId) && oldSize === null)
      || (!isNullObjectId(entry.newObjectId) && newSize === null)) {
      gitBoundOnly = true;
    }
    if (oldSize === null && newSize === null) continue;
    if ((oldSize ?? 0) <= MAX_REVIEW_FILE_CONTENT_BYTES
      && (newSize ?? 0) <= MAX_REVIEW_FILE_CONTENT_BYTES) {
      continue;
    }
    // Fingerprint polling uses path, size and mtime for large files; same-size edits within a timestamp tick can collide. One-shot patch generation hashes exact content.
    if (fingerprintMode && workingTreeInfo && entry.newPath) {
      fingerprintMetadata.push(
        `large:${entry.newPath}:${workingTreeInfo.size}:${workingTreeInfo.mtimeMs}`,
      );
    }
    // Only an all-zero new side needs a synthesized id; a real id already hashed this content.
    const workingObjectId = !fingerprintMode
      && isNullObjectId(entry.newObjectId)
      && workingTreeInfo
      && entry.newPath
      ? await hashOversizedWorkingTreeFile(runtime, entry.newPath, workingTreeInfo, cwd)
      : null;
    oversized.push({
      ...entry,
      newObjectId: workingObjectId ?? entry.newObjectId,
    });
  }

  if (oversized.length === 0) {
    return {
      patch: await render(args),
      fingerprintMetadata,
    };
  }

  const exclusions = oversized.flatMap((entry) => [
    ...(entry.oldPath ? [`:(top,exclude,literal)${entry.oldPath}`] : []),
    ...(entry.newPath && entry.newPath !== entry.oldPath
      ? [`:(top,exclude,literal)${entry.newPath}`]
      : []),
  ]);
  const patchArgs = [...args, "--", ...exclusions];
  const boundedPatch = await render(patchArgs);
  return {
    patch: boundedPatch + oversized.map(buildOversizedTrackedStub).join(""),
    fingerprintMetadata,
  };
}

export async function runBoundedTrackedDiff(
  runtime: ReviewGitRuntime,
  args: string[],
  cwd?: string,
  fileIdentities?: Record<string, string>,
): Promise<string> {
  return (await buildBoundedTrackedDiff(runtime, args, cwd, false, fileIdentities)).patch;
}

/** --raw --patch keeps the patch byte-identical while raw metadata gives full ids even for mode-only changes and pure renames. */
interface ReviewPatchOutput {
  patch: string;
  entries: RawDiffEntry[];
}

function splitReviewPatchOutput(output: string): ReviewPatchOutput {
  const separator = output.indexOf("\0\0");
  if (separator === -1) return { patch: output.startsWith(":") ? "" : output, entries: [] };
  return {
    patch: output.slice(separator + 2),
    entries: parseRawDiffEntries(output.slice(0, separator)),
  };
}

async function extractReviewPatch(
  runtime: ReviewGitRuntime,
  output: string,
  identities: Record<string, string>,
  cwd?: string,
): Promise<string> {
  const parsed = splitReviewPatchOutput(output);
  if (parsed.entries.length > 0) {
    await resolveReviewFileIdentities(runtime, await resolveRepoToplevel(runtime, cwd), [parsed], identities);
  }
  return parsed.patch;
}

const OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** `--stdin-paths` C-unquotes lines starting with a quote and strips a trailing CR, so such paths (and paths with line breaks) cannot pass through it; they get no identity and just do not restore as viewed. */
function isStdinPathSafe(path: string): boolean {
  return !/[\n\r]/.test(path) && !path.startsWith('"');
}

/** Worktree raw ids are zero, so they are hashed in one `hash-object --stdin-paths` call (symlinks hash link text via `--stdin`, one call each). Each hash is checked against the patch's index line so a mid-review edit cannot mark a newer version reviewed. */
async function resolveReviewFileIdentities(
  runtime: ReviewGitRuntime,
  root: string | undefined,
  outputs: ReviewPatchOutput[],
  identities: Record<string, string>,
): Promise<void> {
  const record = (entry: RawDiffEntry, path: string, newId: string) => {
    identities[path] = JSON.stringify([
      entry.oldPath, entry.newPath, entry.oldMode, entry.newMode, entry.oldObjectId, newId,
    ]);
  };
  const pending: { entry: RawDiffEntry; path: string; patch: string }[] = [];
  for (const output of outputs) {
    if (output.entries.length === 0) continue;
    const files = new Map(parseDiffToFiles(output.patch).map(file => [file.path, file]));
    for (const entry of output.entries) {
      const path = entry.newPath ?? entry.oldPath!;
      const file = files.get(path);
      if (!file || isGitlink(entry)) continue;
      if (entry.newPath && isNullObjectId(entry.newObjectId)) {
        pending.push({ entry, path, patch: file.patch });
      } else {
        record(entry, path, entry.newObjectId);
      }
    }
  }
  if (pending.length === 0) return;

  const infos = await Promise.all(pending.map(item => getWorkingTreeFileInfo(runtime, root, item.path)));
  const hashes = new Map<(typeof pending)[number], string>();
  const regular: (typeof pending)[number][] = [];
  const symlinks: { item: (typeof pending)[number]; info: ReviewFileInfo }[] = [];
  pending.forEach((item, index) => {
    const info = infos[index];
    if (!info || info.size > MAX_REVIEW_FILE_CONTENT_BYTES) return;
    if (info.isSymbolicLink) symlinks.push({ item, info });
    else if (isStdinPathSafe(item.path)) regular.push(item);
  });

  if (regular.length > 0) {
    // Root-relative paths with cwd at the root, so clean filters and attributes resolve as for the diff.
    const result = await runtime.runGit(["hash-object", "--stdin-paths"], {
      cwd: root,
      stdin: `${regular.map(item => item.path).join("\n")}\n`,
    });
    // A path that vanished mid-snapshot makes git stop; the lines it printed are a correct prefix and later files go without an identity.
    const lines = result.stdout.split("\n");
    regular.forEach((item, index) => {
      const line = lines[index]?.trim();
      if (line && OBJECT_ID_RE.test(line) && (result.exitCode === 0 || index < lines.length - 1)) {
        hashes.set(item, line);
      }
    });
  }
  for (const { item, info } of symlinks) {
    const link = await runtime.readLink(info.path);
    if (link === null) continue;
    const result = await runtime.runGit(["hash-object", "--stdin"], { cwd: root, stdin: link });
    const id = result.stdout.trim();
    if (result.exitCode === 0 && OBJECT_ID_RE.test(id)) hashes.set(item, id);
  }

  for (const item of pending) {
    const newId = hashes.get(item);
    if (!newId) continue;
    const index = item.patch.match(/^index [a-f0-9]+\.\.([a-f0-9]+)/m);
    if (index ? !newId.startsWith(index[1]) : newId !== item.entry.oldObjectId) continue;
    record(item.entry, item.path, newId);
  }
}

async function getUntrackedFileDiffs(
  runtime: ReviewGitRuntime,
  srcPrefix = "a/",
  dstPrefix = "b/",
  cwd?: string,
  options?: GitDiffOptions,
  failurePolicy: UntrackedFailurePolicy = "best-effort",
  includeBinaryPayloads = false,
  fileIdentities?: Record<string, string>,
): Promise<{ diff: string; paths: string[] }> {
  // ls-files scopes to the cwd subtree with cwd-relative paths; resolve the repo root so untracked files from the whole repo are included and paths match the tracked diff.
  const rootCwd = await resolveRepoToplevel(runtime, cwd);

  const lsResult = await runtime.runGit(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: rootCwd },
  );
  if (lsResult.exitCode !== 0) {
    if (failurePolicy === "strict") {
      assertGitSuccess(lsResult, ["ls-files", "--others", "--exclude-standard"]);
    }
    return { diff: "", paths: [] };
  }

  // ls-files C-quotes unusual paths (unicode, control chars, not plain spaces); the quoted form cannot be read by --no-index and would never match removeTrackedDeletions paths.
  const files = lsResult.stdout
    .trim()
    .split("\n")
    .filter((file) => file.length > 0)
    .map((file) => unquoteGitPath(file));

  if (files.length === 0) return { diff: "", paths: [] };

  const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex++;
          results[index] = await mapper(items[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  };

  const diffs = await mapWithConcurrency(
    files,
    MAX_UNTRACKED_DIFF_CONCURRENCY,
    async (file) => {
      // Large untracked files stay visible as binary additions, but their bytes never enter git or the buffered stdout.
      let fileInfo: ReviewFileInfo | null = null;
      try {
        fileInfo = await runtime.getFileInfo(rootCwd, file);
      } catch {
        // Preserve the existing best-effort/strict behavior below: Git reports
        // the authoritative read error for files that disappear mid-snapshot.
      }
      if (
        !includeBinaryPayloads
        && fileInfo?.isFile
        && fileInfo.size > MAX_REVIEW_FILE_CONTENT_BYTES
      ) {
        const mode = fileInfo.isExecutable ? "100755" : "100644";
        const oldToken = formatPatchPathToken("a", file);
        const newToken = formatPatchPathToken("b", file);
        return [
          `diff --git ${oldToken} ${newToken}`,
          OVERSIZED_REVIEW_STUB_MARKER,
          `new file mode ${mode}`,
          `Binary files /dev/null and ${newToken} differ`,
          "",
        ].join("\n");
      }

      const diffResult = await runtime.runGit(
        [
          "diff",
          "--no-ext-diff",
          ...(includeBinaryPayloads ? ["--binary", "--full-index"] : []),
          ...(fileIdentities ? ["--raw", "-z", "--patch", "--no-abbrev"] : []),
          ...(options?.hideWhitespace ? ["-w"] : []),
          "--no-index",
          `--src-prefix=${srcPrefix}`,
          `--dst-prefix=${dstPrefix}`,
          "/dev/null",
          file,
        ],
        { cwd: rootCwd },
      );
      // `git diff --no-index` exits 1 for a normal difference; above 1 is a real failure: best-effort by default, strict policy fails closed.
      if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
        if (failurePolicy === "best-effort") return "";
        const stderr = diffResult.stderr.trim();
        throw new Error(
          stderr
            ? `git diff --no-index failed for ${JSON.stringify(file)}: ${stderr}`
            : `git diff --no-index failed for ${JSON.stringify(file)} with exit code ${diffResult.exitCode}`,
        );
      }
      return diffResult.stdout;
    },
  );

  if (!fileIdentities) return { diff: diffs.join(""), paths: files };
  // Identities are resolved once for all untracked files: one hash-object process.
  const outputs = diffs.map(splitReviewPatchOutput);
  await resolveReviewFileIdentities(runtime, rootCwd, outputs, fileIdentities);
  return { diff: outputs.map(output => output.patch).join(""), paths: files };
}

export type UntrackedFailurePolicy = "best-effort" | "strict";

/** Never discovers another base like `since-base`; callers with an authoritative base can request the strict policy to fail closed. */
export async function getWorkingTreeDiffFromBase(
  runtime: ReviewGitRuntime,
  base: string,
  cwd?: string,
  options?: GitDiffOptions,
  untrackedFailurePolicy: UntrackedFailurePolicy = "best-effort",
  fileIdentities?: Record<string, string>,
): Promise<string> {
  const args = [
    "diff",
    "--no-ext-diff",
    ...(options?.hideWhitespace ? ["-w"] : []),
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    base,
  ];
  const trackedPatch = await runBoundedTrackedDiff(runtime, args, cwd, fileIdentities);
  const untracked = await getUntrackedFileDiffs(
    runtime,
    "a/",
    "b/",
    cwd,
    options,
    untrackedFailurePolicy,
    false,
    fileIdentities,
  );
  return removeTrackedDeletions(trackedPatch, new Set(untracked.paths)) + untracked.diff;
}

export async function getCurrentUpstreamBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string | null> {
  const result = await runtime.runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const branch = result.stdout.trim();
  return branch && branch !== "@{upstream}" ? branch : null;
}

/** Exact applyable patch for immutable analysis snapshots: includes binary payloads and full object ids so a binary file cannot make `git apply --binary` reject it. */
export async function getGitSnapshotMaterializationPatch(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string = "main",
  externalCwd?: string,
): Promise<string | null> {
  let cwd = externalCwd;
  let effectiveDiffType = diffType as string;
  const worktree = parseWorktreeDiffType(effectiveDiffType);
  if (effectiveDiffType.startsWith("worktree:")) {
    if (!worktree) throw new Error("Could not parse the worktree snapshot.");
    cwd = worktree.path;
    effectiveDiffType = worktree.subType;
  }
  if (
    effectiveDiffType !== "since-base"
    && effectiveDiffType !== "local-vs-remote"
    && effectiveDiffType !== "uncommitted"
    && effectiveDiffType !== "staged"
    && effectiveDiffType !== "unstaged"
  ) {
    return null;
  }

  const binaryDiff = async (args: string[]): Promise<string> =>
    assertGitSuccess(await runtime.runGit(args, { cwd }), args).stdout;
  const common = [
    "diff",
    "--no-ext-diff",
    "--binary",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  const untracked = async (): Promise<{ diff: string; paths: string[] }> =>
    getUntrackedFileDiffs(runtime, "a/", "b/", cwd, undefined, "strict", true);

  if (effectiveDiffType === "staged") {
    return binaryDiff([...common, "--staged"]);
  }
  if (effectiveDiffType === "unstaged") {
    const files = await untracked();
    const tracked = await binaryDiff(common);
    return removeTrackedDeletions(tracked, new Set(files.paths)) + files.diff;
  }

  const hasHead = (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd })).exitCode === 0;
  const files = await untracked();
  if (!hasHead) return files.diff;
  if (effectiveDiffType === "uncommitted") {
    const tracked = await binaryDiff([...common, "HEAD"]);
    return removeTrackedDeletions(tracked, new Set(files.paths)) + files.diff;
  }

  if (effectiveDiffType === "local-vs-remote") {
    const upstreamBranch = await getCurrentUpstreamBranch(runtime, cwd);
    if (!upstreamBranch) throw new Error("The current branch does not have a remote tracking branch.");
    const tracked = await binaryDiff([...common, "--end-of-options", upstreamBranch]);
    return removeTrackedDeletions(tracked, new Set(files.paths)) + files.diff;
  }

  const mergeBaseResult = await runtime.runGit(
    ["merge-base", "--end-of-options", defaultBranch, "HEAD"],
    { cwd },
  );
  const mergeBase = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : "HEAD";
  const tracked = await binaryDiff([...common, "--end-of-options", mergeBase]);
  return removeTrackedDeletions(tracked, new Set(files.paths)) + files.diff;
}

/** Full or long hex SHAs shorten to a 7-char prefix for display; other refs pass through. */
function displayRef(ref: string): string {
  return /^[0-9a-f]{7,}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** hash-object honors the repo hash algorithm; the SHA-1 constant is the no-repo fallback. */
export async function getEmptyTreeSha(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runGit(["hash-object", "-t", "tree", "--stdin"], { cwd });
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

/** True for a switch to `commit:<sha>` within the same cwd (plain or worktree-prefixed): it cannot change branches, worktrees or recent commits, so handlers skip the gitContext recompute. */
export function isSameCwdCommitSwitch(
  previousDiffType: string,
  nextDiffType: string,
): boolean {
  const next = parseWorktreeDiffType(nextDiffType);
  if (!commitFamilyId(nextDiffType)) return false;
  return (next?.path ?? null) === (parseWorktreeDiffType(previousDiffType)?.path ?? null);
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
  const fileIdentities = options?.captureFileIdentities ? Object.create(null) as Record<string, string> : undefined;
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
      patch = await runBoundedTrackedDiff(runtime, commitDiffArgs, cwd, fileIdentities);
      label = subject ? `Commit ${shortSha} — ${subject}` : `Commit ${shortSha}`;
    } else if (effectiveDiffType.startsWith("commit:")) {
      return { patch: "", label: `Error: ${diffType}`, error: "Invalid commit ref" };
    } else switch (effectiveDiffType) {
      case "local-vs-remote": {
        const upstreamBranch = await getCurrentUpstreamBranch(runtime, cwd);
        if (!upstreamBranch) {
          throw new Error("The current branch does not have a remote tracking branch.");
        }
        patch = await getWorkingTreeDiffFromBase(runtime, upstreamBranch, cwd, options);
        label = `Local vs ${displayRef(upstreamBranch)}`;
        break;
      }

      case "since-base": {
        const hasHead =
          (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd }))
            .exitCode === 0;
        let trackedPatch = "";
        if (hasHead) {
          // When the base does not resolve, merge-base fails; degrade to HEAD so working-tree changes still show.
          const mergeBaseResult = await runtime.runGit(
            ["merge-base", "--end-of-options", defaultBranch, "HEAD"],
            { cwd },
          );
          const mergeBase = mergeBaseResult.exitCode === 0
            ? mergeBaseResult.stdout.trim()
            : "HEAD";
          trackedPatch = await getWorkingTreeDiffFromBase(runtime, mergeBase, cwd, options, "best-effort", fileIdentities);
        }
        if (hasHead) {
          patch = trackedPatch;
        } else {
          const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options, "best-effort", false, fileIdentities);
          patch = untracked.diff;
        }
        label = `All changes since ${displayRef(defaultBranch)}`;
        break;
      }

      case "uncommitted": {
        const trackedDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "HEAD",
        ];
        const hasHead =
          (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd }))
            .exitCode === 0;
        const trackedPatch = hasHead
          ? await runBoundedTrackedDiff(runtime, trackedDiffArgs, cwd, fileIdentities)
          : "";
        const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options, "best-effort", false, fileIdentities);
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
        patch = await runBoundedTrackedDiff(runtime, stagedDiffArgs, cwd, fileIdentities);
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
        const untracked = await getUntrackedFileDiffs(runtime, "a/", "b/", cwd, options, "best-effort", false, fileIdentities);
        patch = removeTrackedDeletions(
          await runBoundedTrackedDiff(runtime, trackedDiffArgs, cwd, fileIdentities),
          new Set(untracked.paths),
        ) + untracked.diff;
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
            ? ["diff", "--no-ext-diff", ...wFlag, "--src-prefix=a/", "--dst-prefix=b/", "HEAD~1..HEAD"]
            : ["diff", "--no-ext-diff", ...wFlag, "--src-prefix=a/", "--dst-prefix=b/", "--root", "HEAD"];
        patch = await runBoundedTrackedDiff(runtime, args, cwd, fileIdentities);
        label = "Last commit";
        break;
      }

      case "branch": {
        // `--end-of-options` stops a caller-supplied `defaultBranch` starting with `-` from being parsed as a git flag.
        const branchDiffArgs = [
          "diff",
          "--no-ext-diff",
          ...wFlag,
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--end-of-options",
          `${defaultBranch}..HEAD`,
        ];
        patch = await runBoundedTrackedDiff(runtime, branchDiffArgs, cwd, fileIdentities);
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
        patch = await runBoundedTrackedDiff(runtime, mergeBaseDiffArgs, cwd, fileIdentities);
        label = `PR diff vs ${displayRef(defaultBranch)}`;
        break;
      }

      case "all": {
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
        patch = await runBoundedTrackedDiff(runtime, allDiffArgs, cwd, fileIdentities);
        label = "Every file";
        break;
      }

      default:
        return { patch: "", label: "Unknown diff type" };
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Git can dump its whole --help on failure; keep only the first meaningful line.
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

  return { patch, label, ...(fileIdentities ? {
    fileIdentities: Object.fromEntries(Object.entries(fileIdentities).sort(([a], [b]) => a.localeCompare(b))),
  } : {}) };
}

export async function runGitDiffWithContext(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  gitContext: GitContext,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiff(runtime, diffType, gitContext.defaultBranch, gitContext.cwd, options);
}

// A `null` fingerprint means "cannot fingerprint this mode": callers treat it as always-fresh, never stale. Working-tree modes hash content, since a re-modified file yields identical porcelain.

export function hashFingerprintPart(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

const MAX_UNTRACKED_FINGERPRINT_FILES = 20;

/** Circuit-breaker: past the cap, `-uall` output (e.g. a forgotten node_modules) degrades permanently per process to `-unormal`, so edits inside untracked directories stop flipping the fingerprint; the banner may fire once spuriously. */
const UNTRACKED_STATUS_OUTPUT_CAP = 2 * 1024 * 1024;
const collapsedUntrackedCwds = new Set<string>();

type ReadOnlyGitRunner = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<GitCommandResult>;

async function appendDiffFingerprint(
  runReadOnlyGit: ReadOnlyGitRunner,
  runtime: ReviewGitRuntime,
  parts: string[],
  whitespaceArgs: string[],
  args: string[],
): Promise<boolean> {
  try {
    const diff = await buildBoundedTrackedDiff(
      {
        runGit: (diffArgs, options) => runReadOnlyGit(diffArgs, options),
        readTextFile: async () => null,
        getFileInfo: runtime.getFileInfo,
        readLink: runtime.readLink,
      },
      ["diff", "--no-ext-diff", ...whitespaceArgs, ...args],
      undefined,
      true,
    );
    parts.push(hashFingerprintPart(diff.patch), ...diff.fingerprintMetadata);
    return true;
  } catch {
    return false;
  }
}

async function appendUntrackedFingerprint(
  runtime: ReviewGitRuntime,
  runReadOnlyGit: ReadOnlyGitRunner,
  parts: string[],
  cwd?: string,
): Promise<boolean> {
  // -uall: otherwise an untracked directory collapses to one `??` line and edits inside never change the fingerprint.
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
    .map((line) => unquoteGitPath(line.slice(3).trim()))
    .slice(0, MAX_UNTRACKED_FINGERPRINT_FILES);
  if (untracked.length > 0) {
    const baseDir = await resolveRepoToplevel(runtime, cwd);
    for (const path of untracked) {
      try {
        const fileInfo = await runtime.getFileInfo(baseDir, path);
        if (!fileInfo) {
          parts.push("unreadable");
          continue;
        }
        if (fileInfo.isSymbolicLink) {
          const link = await runtime.readLink(fileInfo.path);
          parts.push(link != null ? hashFingerprintPart(`symlink:${link}`) : "unreadable");
          continue;
        }
        if (!fileInfo.isFile) {
          parts.push(`non-file:${fileInfo.size}:${fileInfo.mtimeMs}`);
          continue;
        }
        if (fileInfo.size > MAX_UNTRACKED_FINGERPRINT_CONTENT_BYTES) {
          // A metadata fingerprint avoids decoding a huge binary into a string every poll; small files stay content-accurate.
          parts.push(`large:${fileInfo.size}:${fileInfo.mtimeMs}`);
          continue;
        }
        const content = await runtime.readTextFile(fileInfo.path);
        parts.push(content != null ? hashFingerprintPart(content) : "unreadable");
      } catch {
        parts.push("unreadable");
      }
    }
  }
  return true;
}

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
    // --no-optional-locks: background probes must never take git's index lock, which races concurrent `git add`/commit.
    const runReadOnlyGit = (args: string[], options?: GitCommandOptions) =>
      runtime.runGit(["--no-optional-locks", ...args], { ...options, cwd });

    // Anchored to an immutable object: the sha plus whether it still resolves. Deliberately not headSha-coupled, so new commits mid-review do not raise the banner.
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

    const hashDiffOutput = (args: string[]): Promise<boolean> =>
      appendDiffFingerprint(runReadOnlyGit, runtime, parts, wFlag, args);

    // Hash untracked contents too so edits to new files are detected; capped, degrading to existence-only.
    const hashUntracked = (): Promise<boolean> =>
      appendUntrackedFingerprint(runtime, runReadOnlyGit, parts, cwd);

    switch (effectiveDiffType) {
      case "local-vs-remote": {
        const upstreamBranch = await getCurrentUpstreamBranch(runtime, cwd);
        if (!upstreamBranch) return null;
        const upstreamTip = await runReadOnlyGit(["rev-parse", "--end-of-options", upstreamBranch]);
        parts.push(upstreamBranch, upstreamTip.exitCode === 0 ? upstreamTip.stdout.trim() : "no-upstream");
        if (!(await hashDiffOutput(["--end-of-options", upstreamBranch]))) return null;
        if (!(await hashUntracked())) return null;
        break;
      }
      case "since-base": {
        // The mb→worktree content hash catches edits; headSha catches commits that re-partition sections; the status hash in hashUntracked catches stage flips.
        if (headSha !== "no-head") {
          // Degrade to HEAD when merge-base fails, as runGitDiff does; `null` here would mean always-fresh and the banner would never fire.
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
        break;
      default:
        return null;
    }
    return parts.join(":");
  } catch {
    return null;
  }
}

/** The one ref table behind both the text and byte readers, so they never read different revisions. `null` for a side with no content; `null` overall for an unknown diff type. */
export async function resolveDiffSideSources(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<DiffSideSources | null> {
  const oldFilePath = oldPath || filePath;

  let effectiveDiffType = diffType as string;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) return null;
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  const object = (rev: string, path: string): DiffSideSource => ({ kind: "object", rev, path });
  const worktree = (path: string): DiffSideSource => ({ kind: "worktree", path });

  // commit:<sha> — old side is the first parent (null on a root commit, so every file renders as an addition).
  const commitRef = parseCommitDiffType(effectiveDiffType);
  if (commitRef) {
    return { cwd, old: object(`${commitRef.sha}^`, oldFilePath), new: object(commitRef.sha, filePath) };
  }

  switch (effectiveDiffType) {
    case "local-vs-remote": {
      const upstreamBranch = await getCurrentUpstreamBranch(runtime, cwd);
      return {
        cwd,
        old: upstreamBranch ? object(upstreamBranch, oldFilePath) : null,
        new: worktree(filePath),
      };
    }
    case "since-base": {
      const mbResult = await runtime.runGit(["merge-base", "--end-of-options", defaultBranch, "HEAD"], { cwd });
      // Degrade to HEAD like runGitDiff: when the base does not resolve the patch is against HEAD, so old-side content must come from HEAD.
      const mb = mbResult.exitCode === 0 ? mbResult.stdout.trim() : "HEAD";
      return { cwd, old: object(mb, oldFilePath), new: worktree(filePath) };
    }
    case "uncommitted":
      return { cwd, old: object("HEAD", oldFilePath), new: worktree(filePath) };
    case "staged":
      return { cwd, old: object("HEAD", oldFilePath), new: object(":0", filePath) };
    case "unstaged":
      return { cwd, old: object(":0", oldFilePath), new: worktree(filePath) };
    case "last-commit":
      return { cwd, old: object("HEAD~1", oldFilePath), new: object("HEAD", filePath) };
    case "branch":
      return { cwd, old: object(defaultBranch, oldFilePath), new: object("HEAD", filePath) };
    case "merge-base": {
      const mbResult = await runtime.runGit(["merge-base", "--end-of-options", defaultBranch, "HEAD"], { cwd });
      const mb = mbResult.exitCode === 0 ? mbResult.stdout.trim() : defaultBranch;
      return { cwd, old: object(mb, oldFilePath), new: object("HEAD", filePath) };
    }
    case "all":
      return { cwd, old: null, new: object("HEAD", filePath) };
    default:
      return null;
  }
}

export type RepoSideSource =
  | { kind: "worktree"; cwd?: string }
  | { kind: "index"; cwd?: string }
  | { kind: "commit"; rev: string; cwd?: string };

export interface RepoRevisionInfo {
  kind: "worktree" | "index" | "commit";
  label: string;
}

export interface RepoFileListing {
  paths: string[];
  revision: RepoRevisionInfo;
  live: boolean;
  root?: string;
  /** Where listed paths are files on disk: a path under `prefix` is `root` joined with the rest. A multi-repo workspace names each child that lists its working tree. */
  diskRoots?: Array<{ prefix: string; root: string }>;
  truncated?: boolean;
}

const REPO_LIST_TIMEOUT_MS = 5 * 60_000;

function splitNulList(output: string): string[] {
  if (!output) return [];
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export async function resolveGitNewSide(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  cwd?: string,
): Promise<RepoSideSource | null> {
  const sources = await resolveDiffSideSources(runtime, diffType, defaultBranch, "", undefined, cwd);
  const side = sources?.new;
  if (!side) return null;
  if (side.kind === "worktree") return { kind: "worktree", cwd: sources.cwd };
  if (side.rev === ":0") return { kind: "index", cwd: sources.cwd };
  return { kind: "commit", rev: side.rev, cwd: sources.cwd };
}

/** The working tree follows `.gitignore` (`ls-files --cached --others --exclude-standard`, minus files deleted on disk). */
export async function listGitSideFiles(
  runtime: ReviewGitRuntime,
  side: RepoSideSource,
): Promise<RepoFileListing | null> {
  const root = await resolveRepoToplevel(runtime, side.cwd);
  const opts = { cwd: root, timeoutMs: REPO_LIST_TIMEOUT_MS };
  let paths: string[];
  let revision: RepoRevisionInfo;
  if (side.kind === "worktree") {
    const [listed, deleted] = await Promise.all([
      runtime.runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], opts),
      runtime.runGit(["ls-files", "-z", "--deleted"], opts),
    ]);
    if (listed.exitCode !== 0 || deleted.exitCode !== 0) return null;
    const removed = new Set(splitNulList(deleted.stdout));
    // Unmerged entries are listed once per stage; the Set dedupes them.
    paths = [...new Set(splitNulList(listed.stdout))].filter((path) => !removed.has(path));
    revision = { kind: "worktree", label: "working tree" };
  } else if (side.kind === "index") {
    const listed = await runtime.runGit(["ls-files", "-z", "--cached"], opts);
    if (listed.exitCode !== 0) return null;
    paths = [...new Set(splitNulList(listed.stdout))];
    revision = { kind: "index", label: "index" };
  } else {
    const [listed, short] = await Promise.all([
      runtime.runGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", "--end-of-options", side.rev], opts),
      runtime.runGit(["rev-parse", "--short", "--end-of-options", `${side.rev}^{commit}`], opts),
    ]);
    if (listed.exitCode !== 0) return null;
    paths = splitNulList(listed.stdout);
    revision = { kind: "commit", label: short.exitCode === 0 ? short.stdout.trim() : side.rev };
  }
  paths.sort(compareRepoPaths);
  return { paths, revision, live: side.kind === "worktree", root };
}

/** The one sort order every listing uses (code-unit order, so prefix ranges are contiguous). */
export function compareRepoPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function listGitFilesForDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  cwd?: string,
): Promise<RepoFileListing | null> {
  const side = await resolveGitNewSide(runtime, diffType, defaultBranch, cwd);
  return side ? listGitSideFiles(runtime, side) : null;
}

/** Read one side as text for hunk expansion (the 5 MB text cap applies). */
export async function readDiffSideText(
  runtime: ReviewGitRuntime,
  source: DiffSideSource | null,
  cwd?: string,
): Promise<string | null> {
  if (!source) return null;
  if (source.kind === "object") {
    const object = `${source.rev}:${source.path}`;
    const sizeResult = await runtime.runGit(
      ["cat-file", "-s", "--", object],
      { cwd },
    );
    if (sizeResult.exitCode !== 0) return null;
    const size = Number(sizeResult.stdout.trim());
    if (!Number.isFinite(size) || size > MAX_REVIEW_FILE_CONTENT_BYTES) return null;
    const result = await runtime.runGit(["show", "--end-of-options", object], { cwd });
    return result.exitCode === 0 ? result.stdout : null;
  }

  // Patch paths are repo-root-relative; resolve against the toplevel, not cwd, or a subdirectory launch double-prefixes them and expansion returns null.
  const baseDir = await resolveRepoToplevel(runtime, cwd);
  try {
    const fileInfo = await runtime.getFileInfo(baseDir, source.path);
    if (!fileInfo) return null;
    // Git stores the link target as blob contents; read the link itself rather than following a possibly huge target.
    if (fileInfo.isSymbolicLink) return await runtime.readLink(fileInfo.path);
    if (!fileInfo.isFile || fileInfo.size > MAX_REVIEW_FILE_CONTENT_BYTES) return null;
    return runtime.readTextFile(fileInfo.path);
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
  const sources = await resolveDiffSideSources(runtime, diffType, defaultBranch, filePath, oldPath, cwd);
  if (!sources) return { oldContent: null, newContent: null };
  return {
    oldContent: await readDiffSideText(runtime, sources.old, sources.cwd),
    newContent: await readDiffSideText(runtime, sources.new, sources.cwd),
  };
}

function isPathInside(root: string, child: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = normalize(root);
  const c = normalize(child);
  return c === r || c.startsWith(`${r}/`);
}

/** The size is read first and the blob stream stops at the cap. The spec goes on stdin, never argv. */
export async function readGitObjectBytes(
  runtime: ReviewGitRuntime,
  spec: string,
  maxBytes: number,
  cwd?: string,
): Promise<FileBytesRead> {
  if (!runtime.runGitBytes) return { kind: "unavailable" };
  if (/[\r\n]/.test(spec)) return { kind: "missing" };
  const check = await runtime.runGit(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { cwd, stdin: `${spec}\n` },
  );
  if (check.exitCode !== 0) return { kind: "missing" };
  const match = check.stdout.trim().match(/^([0-9a-f]{40,64}) (\S+) (\d+)$/);
  if (!match || match[2] !== "blob") return { kind: "missing" };
  const size = Number(match[3]);
  if (size > maxBytes) return { kind: "too-large", size };
  const blob = await runtime.runGitBytes(["cat-file", "blob", match[1]], {
    cwd,
    maxOutputBytes: maxBytes,
  });
  if (blob.truncated) return { kind: "too-large", size };
  if (blob.exitCode !== 0) return { kind: "missing" };
  return { kind: "ok", bytes: blob.stdout, etag: `"${match[1]}"` };
}

/**
 * Objects: `cat-file --batch-check` gates on size before any byte is read, then `cat-file blob` streams undecoded; the spec goes on stdin so it cannot be taken for an option.
 * Worktree: must be a regular file (never a symlink) whose canonical path stays inside the canonical toplevel, blocking a directory swapped for a symlink after the diff.
 */
export async function readDiffSideBytes(
  runtime: ReviewGitRuntime,
  source: DiffSideSource,
  maxBytes: number,
  cwd?: string,
): Promise<FileBytesRead> {
  if (source.kind === "object") {
    return readGitObjectBytes(runtime, `${source.rev}:${source.path}`, maxBytes, cwd);
  }

  if (!runtime.readFileBytes || !runtime.realPath) return { kind: "unavailable" };
  const root = await resolveRepoToplevel(runtime, cwd);
  if (!root) return { kind: "unavailable" };
  const info = await runtime.getFileInfo(root, source.path);
  if (!info || info.isSymbolicLink || !info.isFile) return { kind: "missing" };
  if (info.size > maxBytes) return { kind: "too-large", size: info.size };
  const [realRoot, realFile] = await Promise.all([
    runtime.realPath(root),
    runtime.realPath(info.path),
  ]);
  if (!realRoot || !realFile || !isPathInside(realRoot, realFile)) return { kind: "missing" };
  const bytes = await runtime.readFileBytes(realFile, maxBytes);
  if (!bytes) return { kind: "missing" };
  if (bytes.byteLength > maxBytes) return { kind: "too-large", size: bytes.byteLength };
  return { kind: "ok", bytes, etag: `W/"${info.size}-${Math.trunc(info.mtimeMs)}"` };
}

export async function getFileBytesForDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath: string | undefined,
  side: DiffSide,
  maxBytes: number,
  cwd?: string,
): Promise<FileBytesRead> {
  const sources = await resolveDiffSideSources(runtime, diffType, defaultBranch, filePath, oldPath, cwd);
  if (!sources) return { kind: "unavailable" };
  const source = side === "old" ? sources.old : sources.new;
  if (!source) return { kind: "missing" };
  return readDiffSideBytes(runtime, source, maxBytes, sources.cwd);
}

export interface SinceBaseSectionEntry {
  group: "committed" | "changes" | "untracked";
  staged: boolean;
}

export interface SinceBaseSections {
  base: string;
  mergeBase: string;
  files: Record<string, SinceBaseSectionEntry>;
}

/** Git double-quotes a side containing a quote, backslash, control or non-ASCII char, so the real separator is the ` -> ` outside the quoted span. A name literally containing ` -> ` is ambiguous (accepted edge); only `--porcelain -z` disambiguates. */
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

/** Partitions by `git status`: `??` untracked; other dirty XY changes (staged = column X set); clean in mb..HEAD committed. Null when the repo cannot answer. */
export async function getSinceBaseSections(
  runtime: ReviewGitRuntime,
  defaultBranch: string,
  cwd?: string,
): Promise<SinceBaseSections | null> {
  try {
    // --no-optional-locks: never take the index lock for a read-only sidecar. -uall lists untracked files individually so entries match the patch's per-file paths.
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
        // Untracked. Do not clobber a tracked entry for the same path: `git rm --cached f` emits both `D  f` and `?? f`; the tracked/staged signal wins.
        const path = unquoteGitPath(rest.trim());
        if (path && !files[path]) files[path] = { group: "untracked", staged: false };
        continue;
      }

      // Tracked change always wins over a prior untracked entry. Renames/copies record both sides: if a working-tree edit drops similarity below git's threshold, the patch emits separate delete+add chunks and `orig` would otherwise default to Committed.
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
      // Degrade to HEAD when the base cannot be resolved (as runGitDiff does): the committed set becomes empty rather than nulling the whole sidecar.
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
        // Dirty state wins: a file with committed and working-tree changes lives in "changes".
        if (!files[path]) files[path] = { group: "committed", staged: false };
      }
    }

    return { base: defaultBranch, mergeBase, files };
  } catch {
    return null;
  }
}

/** Refuses absolute paths and any segment made only of dots: `..`, and `...`, which is Perforce's recursive wildcard (P4 content runs `p4 print` on the path) and which Windows trims to nothing. */
export function validateFilePath(filePath: string): void {
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(filePath) ||
    filePath.split(/[\\/]/).some((segment) => /^\.+$/.test(segment))
  ) {
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
  // Patch paths are repo-root-relative; apply the pathspec at the toplevel or `git add` fails with "did not match any files".
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

    // Prefer the --- /+++ path lines; fall back to the `diff --git` header for chunks lacking them (e.g. a pure mode change).
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

export interface PatchFileEntry {
  path: string;
  oldPath?: string;
  newPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  hasHunks: boolean;
  isBinary: boolean;
  isOversizedStub: boolean;
}

/** Matched by display path. Headers are read only before the first hunk, so a path that merely appears in hunk content never matches. Null when no chunk names the path. */
export function findPatchFileEntry(patch: string, filePath: string): PatchFileEntry | null {
  const chunkStarts = [...patch.matchAll(/^diff --git /gm)];
  for (let i = 0; i < chunkStarts.length; i++) {
    const start = chunkStarts[i].index ?? 0;
    const end = chunkStarts[i + 1]?.index ?? patch.length;
    const lines = patch.slice(start, end).split("\n");
    const header = parseDiffGitHeader(lines[0] ?? "");
    const fileLines = parseDiffFilePathLines(lines);
    const metadata = parseDiffMetadataPathLines(lines);
    const path =
      metadata.newPath ??
      fileLines.newPath ??
      header.newPath ??
      metadata.oldPath ??
      fileLines.oldPath ??
      header.oldPath;
    if (path !== filePath) continue;

    const hunkIndex = lines.findIndex((line) => line.startsWith("@@ "));
    const headerLines = hunkIndex === -1 ? lines : lines.slice(0, hunkIndex);
    const binaryLine = headerLines.find(
      (line) => line === "GIT binary patch" || line.startsWith("Binary files "),
    );
    const added =
      headerLines.some((line) => line.startsWith("new file mode ") || line === "--- /dev/null") ||
      (binaryLine?.startsWith("Binary files /dev/null and ") ?? false);
    const deleted =
      headerLines.some((line) => line.startsWith("deleted file mode ") || line === "+++ /dev/null") ||
      (binaryLine?.endsWith(" and /dev/null differ") ?? false);
    const oldPath = added ? undefined : metadata.oldPath ?? fileLines.oldPath ?? header.oldPath;
    const newPath = deleted ? undefined : metadata.newPath ?? fileLines.newPath ?? header.newPath;
    const status = added
      ? "added"
      : deleted
        ? "deleted"
        : oldPath && newPath && oldPath !== newPath
          ? "renamed"
          : "modified";
    return {
      path,
      ...(oldPath ? { oldPath } : {}),
      ...(newPath ? { newPath } : {}),
      status,
      hasHunks: hunkIndex !== -1,
      isBinary: binaryLine !== undefined,
      isOversizedStub: headerLines.includes(OVERSIZED_REVIEW_STUB_MARKER),
    };
  }
  return null;
}

export function isBinaryPatchFile(patch: string, filePath: string): boolean {
  return findPatchFileEntry(patch, filePath)?.isBinary ?? false;
}

/** Content is caller-supplied unified-diff bytes (`review --patch-file`), not computed by a VCS; nothing in the session may read the working tree. */
export const STATIC_PATCH_DIFF_TYPE = "static-patch";

/** Absent reads as `"vcs"`. `"patch"` is static-patch mode: no repository, working tree or VCS, so every affordance touching one is unavailable and its endpoint answers 400. */
export type ReviewSourceKind = "vcs" | "patch";
