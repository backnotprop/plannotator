/**
 * GitHub pull requests through the user's own `gh` CLI: this repo's open PRs,
 * PRs waiting on the user's review, and a PR's head checked out in a git
 * worktree under the extension's storage (SPEC 4.1: the agent and the reader
 * both get real files, and the user's own checkout is never touched).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { deriveGuideRepoKeyFromRemote } from "@plannotator/shared/guide-store";
import type { RepoInfo } from "./git";
import { changedFilesFromPatch, commitExists, getRepoInfo, type ChangedFileInfo } from "./git";
import type { Runner } from "./runner";

export type GhStatus =
  | { state: "ok"; user: string }
  | { state: "missing" }
  | { state: "signed-out"; message: string }
  | { state: "error"; message: string };

export interface PullRequestRow {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  /** The signed-in user wrote it. */
  isMine: boolean;
  /** The signed-in user is asked to review it. */
  reviewRequested: boolean;
}

export interface WaitingRow {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  updatedAt: string;
  isDraft: boolean;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
}

async function gh(runner: Runner, cwd: string | undefined, args: string[], timeoutMs = 30_000) {
  return runner("gh", args, { cwd, timeoutMs, env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function ghStatus(runner: Runner, cwd?: string): Promise<GhStatus> {
  const r = await gh(runner, cwd, ["api", "user", "--jq", ".login"], 15_000);
  if (r.code === 127) return { state: "missing" };
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim();
    if (/auth login|not logged|authenticat/i.test(msg)) return { state: "signed-out", message: msg };
    return { state: "error", message: msg || `gh exited with ${r.code}` };
  }
  return { state: "ok", user: r.stdout.trim() };
}

const PR_LIST_FIELDS = "number,title,url,author,isDraft,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,updatedAt,reviewRequests";

/** Open PRs of the repository at `cwd`, newest activity first. */
export async function listRepoPullRequests(runner: Runner, cwd: string, user: string, limit = 30): Promise<PullRequestRow[]> {
  const r = await gh(runner, cwd, ["pr", "list", "--state", "open", "--limit", String(limit), "--json", PR_LIST_FIELDS]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr list exited with ${r.code}`);
  const raw = parseJson<Array<Record<string, unknown>>>(r.stdout) ?? [];
  const rows = raw.map((p): PullRequestRow => {
    const author = ((p.author as { login?: string } | null)?.login) ?? "";
    const requests = Array.isArray(p.reviewRequests) ? (p.reviewRequests as Array<{ login?: string }>) : [];
    return {
      number: Number(p.number),
      title: String(p.title ?? ""),
      url: String(p.url ?? ""),
      author,
      isDraft: p.isDraft === true,
      headRefName: String(p.headRefName ?? ""),
      headRefOid: String(p.headRefOid ?? ""),
      baseRefName: String(p.baseRefName ?? ""),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      changedFiles: Number(p.changedFiles ?? 0),
      updatedAt: String(p.updatedAt ?? ""),
      isMine: !!user && author === user,
      reviewRequested: !!user && requests.some((q) => q?.login === user),
    };
  });
  // Yours and the ones waiting on you first, then by activity.
  const rank = (p: PullRequestRow) => (p.isMine ? 0 : p.reviewRequested ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Open PRs anywhere on GitHub that ask the user for a review. */
export async function listReviewRequested(runner: Runner, limit = 15): Promise<WaitingRow[]> {
  const r = await gh(runner, undefined, [
    "search", "prs", "--review-requested=@me", "--state=open", "--limit", String(limit),
    "--json", "number,title,url,repository,author,updatedAt,isDraft",
  ]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh search prs exited with ${r.code}`);
  const raw = parseJson<Array<Record<string, unknown>>>(r.stdout) ?? [];
  return raw
    .map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      url: String(p.url ?? ""),
      repo: String((p.repository as { nameWithOwner?: string } | null)?.nameWithOwner ?? ""),
      author: String((p.author as { login?: string } | null)?.login ?? ""),
      updatedAt: String(p.updatedAt ?? ""),
      isDraft: p.isDraft === true,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** `482`, `#482`, or a PR URL of this repository. */
export function parsePullRequestRef(input: string, repo?: RepoInfo): number | null {
  const s = input.trim();
  const n = /^#?(\d+)$/.exec(s);
  if (n) return Number(n[1]);
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(s);
  if (!url) return null;
  if (repo?.github) {
    const same = url[1].toLowerCase() === repo.github.host.toLowerCase()
      && url[2].toLowerCase() === repo.github.owner.toLowerCase()
      && url[3].replace(/\.git$/, "").toLowerCase() === repo.github.repo.toLowerCase();
    if (!same) return null;
  }
  return Number(url[4]);
}

/** `ghRepo` names the repository (`[host/]owner/repo`) instead of the one gh finds from `cwd`'s remotes. */
export async function viewPullRequest(runner: Runner, cwd: string, number: number, ghRepo?: string): Promise<PullRequestDetail> {
  const r = await gh(runner, cwd, ["pr", "view", String(number), ...(ghRepo ? ["--repo", ghRepo] : []), "--json", "number,title,url,body,author,headRefName,headRefOid,baseRefName,baseRefOid"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr view exited with ${r.code}`);
  const p = parseJson<Record<string, unknown>>(r.stdout);
  if (!p) throw new Error("gh pr view returned something that is not JSON");
  return {
    number: Number(p.number),
    title: String(p.title ?? ""),
    url: String(p.url ?? ""),
    body: String(p.body ?? ""),
    author: String((p.author as { login?: string } | null)?.login ?? ""),
    headRefName: String(p.headRefName ?? ""),
    headRefOid: String(p.headRefOid ?? ""),
    baseRefName: String(p.baseRefName ?? ""),
    baseRefOid: String(p.baseRefOid ?? ""),
  };
}

export interface PullRequestWorktree {
  path: string;
  headSha: string;
  mergeBase: string;
  rawPatch: string;
  files: ChangedFileInfo[];
}

/** Where the extension keeps its PR worktrees. Nothing outside it is ever removed. */
export function worktreesRoot(storageDir: string): string {
  return join(storageDir, "worktrees");
}

/**
 * Where a PR's worktree lives under the extension's storage: one per PR head,
 * named by it, so a worktree is never moved under a live run or another saved
 * guide that reads the same head.
 */
export function pullRequestWorktreePath(storageDir: string, repoKey: string, number: number, headSha: string): string {
  return join(worktreesRoot(storageDir), repoKey, `pr-${number}-${headSha.slice(0, 7)}`);
}

/** A branch name safe to put in a refspec. */
const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

type Git = (args: string[], cwd?: string, timeoutMs?: number) => ReturnType<Runner>;

function gitIn(runner: Runner, repoRoot: string): Git {
  return (args, cwd = repoRoot, timeoutMs = 120_000) => runner("git", ["--no-pager", ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
}

/**
 * Bring a PR's head commit into the repository's objects. `--refmap=` keeps
 * every configured fetch refspec out of it, so no ref of the user's moves
 * (only FETCH_HEAD is written, as for any fetch).
 */
export async function fetchPullRequestHead(runner: Runner, repoRoot: string, number: number, headSha: string): Promise<{ ok: boolean; stderr: string }> {
  if (await commitExists(runner, repoRoot, headSha)) return { ok: true, stderr: "" };
  const f = await gitIn(runner, repoRoot)(["fetch", "--no-tags", "--refmap=", "--", "origin", `refs/pull/${number}/head`]);
  return { ok: f.code === 0 && (await commitExists(runner, repoRoot, headSha)), stderr: f.stderr.trim() };
}

/**
 * The PR's base commit, fetched without moving the user's `origin/<base>`:
 * by its sha first, else the branch into a private ref that is deleted again
 * once read (the merge base stays reachable from the PR head).
 */
async function fetchBase(runner: Runner, repoRoot: string, pr: PullRequestDetail): Promise<string | null> {
  const g = gitIn(runner, repoRoot);
  if (pr.baseRefOid && (await commitExists(runner, repoRoot, pr.baseRefOid))) return pr.baseRefOid;
  if (pr.baseRefOid) {
    await g(["fetch", "--no-tags", "--refmap=", "--", "origin", pr.baseRefOid]);
    if (await commitExists(runner, repoRoot, pr.baseRefOid)) return pr.baseRefOid;
  }
  if (!SAFE_REF.test(pr.baseRefName)) return null;
  const privateRef = `refs/plannotator/guides/pr-${pr.number}-base`;
  const f = await g(["fetch", "--no-tags", "--refmap=", "--", "origin", `+refs/heads/${pr.baseRefName}:${privateRef}`]);
  if (f.code !== 0) return null;
  const sha = (await g(["rev-parse", "--verify", "--quiet", `${privateRef}^{commit}`])).stdout.trim();
  await g(["update-ref", "-d", privateRef]);
  return sha || null;
}

/**
 * A detached worktree at `sha` in `path` (under the extension's storage).
 * Reuses it when it is there; never runs `git worktree prune` on the user's
 * repository (`--force` re-adds a path git still lists as missing).
 */
export async function ensureWorktreeAt(runner: Runner, repoRoot: string, path: string, sha: string, storageDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isInside(worktreesRoot(storageDir), path)) return { ok: false, error: `Refusing a worktree outside the extension's storage: ${path}` };
  const g = gitIn(runner, repoRoot);
  if (existsSync(join(path, ".git"))) {
    const at = (await g(["rev-parse", "HEAD"], path, 30_000)).stdout.trim();
    if (at === sha) return { ok: true };
    // The path is named by its head: put it back there.
    const co = await g(["checkout", "--detach", "--force", sha], path);
    return co.code === 0 ? { ok: true } : { ok: false, error: co.stderr.trim() };
  }
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const add = await g(["worktree", "add", "--force", "--detach", "--", path, sha]);
  return add.code === 0 ? { ok: true } : { ok: false, error: add.stderr.trim() };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Fetch a PR's head and base and check the head out in a detached worktree
 * of its own (`pr-<n>-<sha7>`), reused when it exists.
 */
export async function preparePullRequestWorktree(
  runner: Runner,
  repo: RepoInfo,
  pr: PullRequestDetail,
  storageDir: string,
  onStep: (step: string) => void = () => {},
): Promise<PullRequestWorktree> {
  const g = gitIn(runner, repo.root);
  if (!pr.headRefOid) throw new Error(`PR #${pr.number} has no head commit.`);
  if (!(await commitExists(runner, repo.root, pr.headRefOid))) {
    onStep(`Fetching PR #${pr.number}`);
    const f = await fetchPullRequestHead(runner, repo.root, pr.number, pr.headRefOid);
    if (!f.ok) throw new Error(`Could not fetch PR #${pr.number} from origin: ${f.stderr || "the head commit is missing"}`);
  }
  if (pr.baseRefOid && !(await commitExists(runner, repo.root, pr.baseRefOid))) onStep(`Fetching ${pr.baseRefName}`);
  const baseRev = await fetchBase(runner, repo.root, pr);
  if (!baseRev) throw new Error(`Could not fetch ${pr.baseRefName}, the branch PR #${pr.number} merges into.`);
  const mb = await g(["merge-base", baseRev, pr.headRefOid], repo.root, 30_000);
  if (mb.code !== 0 || !mb.stdout.trim()) throw new Error(`Could not find where PR #${pr.number} branches off ${pr.baseRefName}.`);
  const mergeBase = mb.stdout.trim();

  const path = pullRequestWorktreePath(storageDir, repo.repoKey, pr.number, pr.headRefOid);
  onStep(existsSync(join(path, ".git")) ? "Using the PR worktree" : "Creating a worktree at the PR head");
  const wt = await ensureWorktreeAt(runner, repo.root, path, pr.headRefOid, storageDir);
  if (!wt.ok) throw new Error(`Could not create a worktree for PR #${pr.number}: ${wt.error}`);
  const diff = await runner("git", ["--no-pager", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, pr.headRefOid], { cwd: path, timeoutMs: 120_000 });
  if (diff.code !== 0) throw new Error(`Could not diff PR #${pr.number}: ${diff.stderr.trim()}`);
  return { path, headSha: pr.headRefOid, mergeBase, rawPatch: diff.stdout, files: changedFilesFromPatch(diff.stdout) };
}

/** Remove one of the extension's PR worktrees (only ever a path under its storage). */
export async function removePullRequestWorktree(runner: Runner, repoRoot: string, path: string, storageDir: string): Promise<boolean> {
  if (!isInside(worktreesRoot(storageDir), path) || !existsSync(path)) return false;
  const r = await gitIn(runner, repoRoot)(["worktree", "remove", "--force", "--", path], repoRoot, 60_000);
  return r.code === 0;
}

// ---------------------------------------------------------------------------
// Pull requests of a repository that is not open: a blobless clone in storage
// ---------------------------------------------------------------------------

/** A PR URL (`https://<host>/<owner>/<repo>/pull/<n>`), or null. */
export function parsePullRequestUrl(input: string): { host: string; owner: string; repo: string; number: number } | null {
  const m = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(input.trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3].replace(/\.git$/, ""), number: Number(m[4]) };
}

/** `owner/repo` on github.com, else `host/owner/repo`: the form `gh` takes for `--repo` and `repo clone`. */
export function ghRepoArg(ref: { host: string; owner: string; repo: string }): string {
  return ref.host === "github.com" ? `${ref.owner}/${ref.repo}` : `${ref.host}/${ref.owner}/${ref.repo}`;
}

/** `[host/]owner/repo` back into its parts (host github.com when left out). */
export function parseGhRepoArg(arg: string): { host: string; owner: string; repo: string } | null {
  const parts = arg.split("/").filter(Boolean);
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length === 3) return { host: parts[0].toLowerCase(), owner: parts[1], repo: parts[2] };
  return null;
}

/** The guide store shelf of a GitHub repository: the same key a local checkout of it gets. */
export function repoKeyForGhRepo(arg: string): string | null {
  const ref = parseGhRepoArg(arg);
  return ref ? deriveGuideRepoKeyFromRemote(`https://${ref.host}/${ref.owner}/${ref.repo}.git`) : null;
}

/** A shelf key (`github.com__owner__repo`) back into the form gh takes, or null for a key that is not a GitHub repository. */
export function ghRepoOfKey(repoKey: string): string | null {
  const parts = repoKey.split("__");
  if (parts.length !== 3 || !parts[0].includes(".")) return null;
  return ghRepoArg({ host: parts[0], owner: parts[1], repo: parts[2] });
}

/** Where the extension keeps its clone of a repository, by its shelf key. */
export function repoClonePath(storageDir: string, repoKey: string): string {
  return join(storageDir, "repos", repoKey);
}

/**
 * Whether a pull request (by its URL's host, owner and repo) belongs to the
 * repository open in VS Code. Owner and repo compare case-insensitively, and
 * the host only loosely: an SSH host alias (`git@github-work:org/repo`, no
 * dot in the name) or `ssh.github.com` (port 443) is the same GitHub as
 * `github.com`, so the open repository's own PRs never look like another
 * repository's.
 */
export function isOpenRepository(open: RepoInfo | null | undefined, ref: { host: string; owner: string; repo: string }): boolean {
  const gh = open?.github;
  if (!gh) return false;
  if (gh.owner.toLowerCase() !== ref.owner.toLowerCase() || gh.repo.replace(/\.git$/i, "").toLowerCase() !== ref.repo.replace(/\.git$/i, "").toLowerCase()) return false;
  const a = canonicalGitHubHost(gh.host);
  const b = canonicalGitHubHost(ref.host);
  return a === b || !gh.host.includes(".");
}

function canonicalGitHubHost(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return h === "ssh.github.com" || h === "www.github.com" ? "github.com" : h;
}

/** Clones being made in this window, by path: a second caller waits for the first. */
const cloning = new Map<string, Promise<RepoInfo>>();

/** A `*.cloning-*` folder older than this was left by a window that stopped mid-clone. */
const STALE_CLONE_MS = 60 * 60_000;

/**
 * A repository that is not open in VS Code, for guiding one of its pull
 * requests: a blobless, no-checkout clone (`gh repo clone`, so the user's own
 * gh auth and protocol apply) kept in the extension's storage and reused.
 * The PR itself then goes through the same per-PR worktree as any PR.
 *
 * The clone is made in a folder of its own and moved into place only when it
 * is complete, so two callers (or two windows) never delete each other's
 * clone; one that loses the race uses the winner's. gh lends git its
 * credentials only for the clone command itself, so the clone gets gh as its
 * credential helper in its own config (nothing outside it is changed): the
 * later fetches of the PR head, the base and on-demand blobs need it for a
 * private repository over HTTPS.
 */
export function ensureRepoClone(runner: Runner, ghRepo: string, storageDir: string, onStep: (step: string) => void = () => {}, options: { ghPath?: string | null; now?: () => number } = {}): Promise<RepoInfo> {
  const repoKey = repoKeyForGhRepo(ghRepo);
  if (!repoKey) return Promise.reject(new Error(`${ghRepo} is not a GitHub repository name.`));
  const path = repoClonePath(storageDir, repoKey);
  const running = cloning.get(path);
  if (running) return running;
  const job = cloneOnce(runner, ghRepo, path, onStep, options).finally(() => cloning.delete(path));
  cloning.set(path, job);
  return job;
}

async function cloneOnce(runner: Runner, ghRepo: string, path: string, onStep: (step: string) => void, options: { ghPath?: string | null; now?: () => number }): Promise<RepoInfo> {
  const now = options.now ?? Date.now;
  sweepStaleClones(path, now());
  if (!existsSync(join(path, ".git"))) {
    onStep(`Cloning ${ghRepo} (no checkout, files fetched as needed)`);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.cloning-${process.pid}-${now()}`;
    const r = await gh(runner, dirname(path), ["repo", "clone", ghRepo, temp, "--", "--filter=blob:none", "--no-checkout", "--quiet"], 600_000);
    if (r.code !== 0) {
      rmSync(temp, { recursive: true, force: true });
      throw new Error(`Could not clone ${ghRepo}: ${r.stderr.trim().split("\n").pop() || `gh exited with ${r.code}`}`);
    }
    await useGhForCredentials(runner, temp, ghRepo, options.ghPath);
    if (existsSync(join(path, ".git"))) rmSync(temp, { recursive: true, force: true });
    else {
      try {
        renameSync(temp, path);
      } catch (err) {
        // Another window moved its clone in first: use that one.
        rmSync(temp, { recursive: true, force: true });
        if (!existsSync(join(path, ".git"))) throw err;
      }
    }
  }
  const info = await getRepoInfo(runner, path);
  if (!info) throw new Error(`The clone of ${ghRepo} at ${path} is not a git repository.`);
  return info;
}

/** `credential.https://<host>.helper` = gh, in the clone's own config only (what `gh auth setup-git` would set globally). */
async function useGhForCredentials(runner: Runner, clone: string, ghRepo: string, ghPath: string | null | undefined): Promise<void> {
  const ref = parseGhRepoArg(ghRepo);
  if (!ref || !ghPath) return;
  const key = `credential.https://${ref.host}.helper`;
  const g = gitIn(runner, clone);
  await g(["config", "--local", key, ""]);
  await g(["config", "--local", "--add", key, `!${shellQuoteForGit(ghPath)} auth git-credential`]);
}

/**
 * A program path for a git `!` credential helper, which git runs with
 * `sh -c` (Git for Windows too, through its bundled sh): POSIX single quotes,
 * so `$`, backticks and backslashes stay literal (`'` becomes `'\''`). A
 * Windows path comes out as `gh auth setup-git` itself writes it
 * (`'C:\Program Files\GitHub CLI\gh.exe'`).
 */
export function shellQuoteForGit(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Folders left by a clone that never finished (its window closed or was killed). */
function sweepStaleClones(path: string, now: number): void {
  const dir = dirname(path);
  const prefix = `${path.slice(dir.length + 1)}.cloning-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > STALE_CLONE_MS) rmSync(full, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/** A PR's current head commit, by `gh pr view` (`--repo` for another repository, else the one gh finds in `cwd`). */
export async function pullRequestHead(runner: Runner, ghRepo: string | null, number: number, cwd?: string): Promise<string | null> {
  const r = await gh(runner, cwd, ["pr", "view", String(number), ...(ghRepo ? ["--repo", ghRepo] : []), "--json", "headRefOid"]);
  if (r.code !== 0) return null;
  const p = parseJson<{ headRefOid?: string }>(r.stdout);
  return p?.headRefOid || null;
}
