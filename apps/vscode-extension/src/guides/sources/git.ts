/**
 * The repository and its local changes, for the dashboard and for a guide of
 * local changes. The patch comes from Plannotator's own review core
 * (`getWorkingTreeDiffFromBase`), so untracked files are handled exactly as in
 * the web app's "since base" view.
 */

import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import {
  getDefaultBranch,
  getWorkingTreeDiffFromBase,
  prepareGitCommand,
  type GitCommandOptions,
  type ReviewGitRuntime,
} from "@plannotator/shared/review-core";
import { parseRemoteHost, parseRemoteUrl } from "@plannotator/shared/repo";
import { readRepoWorkingTreeEntry } from "@plannotator/shared/repo-file";
import { deriveGuideRepoKeyFallback, deriveGuideRepoKeyFromRemote } from "@plannotator/shared/guide-store";
import type { Runner } from "./runner";

export interface RepoInfo {
  root: string;
  /** Directory name, or `owner/repo` when the origin is GitHub. */
  displayName: string;
  branch: string;
  headSha: string;
  /** e.g. `origin/main`. */
  defaultBranch: string;
  remoteUrl?: string;
  /** Guide store shelf, shared with the web app. */
  repoKey: string;
  github?: { host: string; owner: string; repo: string };
}

export interface ChangedFileInfo {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** New-side hunk ranges, 1-based inclusive. */
  hunks: Array<{ start: number; end: number }>;
}

export function gitRuntime(runner: Runner): ReviewGitRuntime {
  return {
    async runGit(args: string[], options?: GitCommandOptions) {
      const prepared = prepareGitCommand(args, options, process.env);
      const result = await runner("git", prepared.args, {
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
        stdin: options?.stdin,
        maxOutputBytes: options?.maxOutputBytes,
        ...(prepared.env && { env: prepared.env }),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, ...(result.truncated && { truncated: true }) };
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async getFileInfo(basePath, path) {
      const fullPath = resolvePath(basePath ?? "", path);
      try {
        const s = await lstat(fullPath);
        return { path: fullPath, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink(), isExecutable: (s.mode & 0o111) !== 0 };
      } catch {
        return null;
      }
    },
    async readLink(path) {
      try {
        return await readlink(path);
      } catch {
        return null;
      }
    },
    // Default decoder: Node's readFile(path, "utf8"), as readTextFile above.
    async readWorkingTreeEntry(root, path, options) {
      return readRepoWorkingTreeEntry(root, path, options);
    },
  };
}

async function git(runner: Runner, cwd: string, args: string[], timeoutMs = 30_000): Promise<string | null> {
  const r = await runner("git", ["--no-pager", "-c", "core.quotePath=false", ...args], { cwd, timeoutMs });
  return r.code === 0 ? r.stdout : null;
}

/** The repository at `cwd`, or null when it is not a git work tree. */
export async function getRepoInfo(runner: Runner, cwd: string): Promise<RepoInfo | null> {
  const root = (await git(runner, cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return null;
  const [branchOut, headOut, remoteOut] = await Promise.all([
    git(runner, root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(runner, root, ["rev-parse", "HEAD"]),
    git(runner, root, ["remote", "get-url", "origin"]),
  ]);
  const defaultBranch = await getDefaultBranch(gitRuntime(runner), root);
  const remoteUrl = remoteOut?.trim() || undefined;
  const host = remoteUrl ? parseRemoteHost(remoteUrl) : null;
  const path = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  const segments = path?.split("/").filter(Boolean) ?? [];
  const github = host && /github/i.test(host) && segments.length >= 2 ? { host, owner: segments[0], repo: segments[1] } : undefined;
  const dirName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  return {
    root,
    displayName: github ? `${github.owner}/${github.repo}` : dirName,
    branch: branchOut?.trim() || "HEAD",
    headSha: headOut?.trim() ?? "",
    defaultBranch,
    ...(remoteUrl && { remoteUrl }),
    repoKey: (remoteUrl && deriveGuideRepoKeyFromRemote(remoteUrl)) || deriveGuideRepoKeyFallback(root),
    ...(github && { github }),
  };
}

export type LocalChangesMode = "since-base" | "uncommitted";

export interface LocalChangesSummary {
  mode: LocalChangesMode;
  /** The commit the change is measured from (merge base, or HEAD). */
  baseSha: string;
  /** e.g. `main` or `HEAD`. */
  baseLabel: string;
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
}

/** The merge base of HEAD and the default branch, or HEAD when there is none. */
export async function resolveLocalBase(runner: Runner, repo: RepoInfo, mode: LocalChangesMode): Promise<{ sha: string; label: string }> {
  if (mode === "uncommitted") return { sha: repo.headSha, label: "HEAD" };
  const mb = (await git(runner, repo.root, ["merge-base", repo.defaultBranch, "HEAD"]))?.trim();
  if (mb) return { sha: mb, label: repo.defaultBranch.replace(/^origin\//, "") };
  return { sha: repo.headSha, label: "HEAD" };
}

/** Cheap counts for the dashboard row: no patch is built. */
export async function summarizeLocalChanges(runner: Runner, repo: RepoInfo, mode: LocalChangesMode = "since-base"): Promise<LocalChangesSummary> {
  const base = await resolveLocalBase(runner, repo, mode);
  const [numstat, untrackedOut] = await Promise.all([
    git(runner, repo.root, ["diff", "--numstat", base.sha]),
    git(runner, repo.root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of (numstat ?? "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files += 1;
    if (m[1] !== "-") additions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  const untracked = (untrackedOut ?? "").split("\n").filter(Boolean).length;
  return { mode, baseSha: base.sha, baseLabel: base.label, files: files + untracked, additions, deletions, untracked };
}

export interface LocalChangesPatch {
  baseSha: string;
  baseLabel: string;
  rawPatch: string;
  files: ChangedFileInfo[];
}

/** The full patch of local changes (tracked against the base, plus untracked files). */
export async function buildLocalChangesPatch(runner: Runner, repo: RepoInfo, mode: LocalChangesMode): Promise<LocalChangesPatch> {
  const base = await resolveLocalBase(runner, repo, mode);
  const rawPatch = await getWorkingTreeDiffFromBase(gitRuntime(runner), base.sha, repo.root);
  return { baseSha: base.sha, baseLabel: base.label, rawPatch, files: changedFilesFromPatch(rawPatch) };
}

/** Files of a patch with their head-side hunk ranges. */
export function changedFilesFromPatch(rawPatch: string): ChangedFileInfo[] {
  return parseDiffToFiles(rawPatch).map((f) => ({
    path: f.path,
    ...(f.oldPath && { oldPath: f.oldPath }),
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.status === "deleted" ? [] : hunkRanges(f.patch),
  }));
}

export function hunkRanges(filePatch: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of filePatch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    out.push({ start, end: start + count - 1 });
  }
  return out;
}

/** `git show <rev>:<path>` text, or null when the path does not exist at that revision. */
export async function showFileAt(runner: Runner, cwd: string, rev: string, path: string): Promise<string | null> {
  const r = await runner("git", ["--no-pager", "show", `${rev}:${path}`], { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout : null;
}

export async function commitExists(runner: Runner, cwd: string, sha: string): Promise<boolean> {
  const r = await runner("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, timeoutMs: 10_000 });
  return r.code === 0;
}
