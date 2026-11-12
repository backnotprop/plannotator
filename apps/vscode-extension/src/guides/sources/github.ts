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
  isMine: boolean;
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
  const rank = (p: PullRequestRow) => (p.isMine ? 0 : p.reviewRequested ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

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

export function worktreesRoot(storageDir: string): string {
  return join(storageDir, "worktrees");
}

export function pullRequestWorktreePath(storageDir: string, repoKey: string, number: number, headSha: string): string {
  return join(worktreesRoot(storageDir), repoKey, `pr-${number}-${headSha.slice(0, 7)}`);
}

const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

type Git = (args: string[], cwd?: string, timeoutMs?: number) => ReturnType<Runner>;

function gitIn(runner: Runner, repoRoot: string): Git {
  return (args, cwd = repoRoot, timeoutMs = 120_000) => runner("git", ["--no-pager", ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
}

export async function fetchPullRequestHead(runner: Runner, repoRoot: string, number: number, headSha: string): Promise<{ ok: boolean; stderr: string }> {
  if (await commitExists(runner, repoRoot, headSha)) return { ok: true, stderr: "" };
  const f = await gitIn(runner, repoRoot)(["fetch", "--no-tags", "--refmap=", "--", "origin", `refs/pull/${number}/head`]);
  return { ok: f.code === 0 && (await commitExists(runner, repoRoot, headSha)), stderr: f.stderr.trim() };
}

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

export async function ensureWorktreeAt(runner: Runner, repoRoot: string, path: string, sha: string, storageDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isInside(worktreesRoot(storageDir), path)) return { ok: false, error: `Refusing a worktree outside the extension's storage: ${path}` };
  const g = gitIn(runner, repoRoot);
  if (existsSync(join(path, ".git"))) {
    const at = (await g(["rev-parse", "HEAD"], path, 30_000)).stdout.trim();
    if (at === sha) return { ok: true };
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

export async function removePullRequestWorktree(runner: Runner, repoRoot: string, path: string, storageDir: string): Promise<boolean> {
  if (!isInside(worktreesRoot(storageDir), path) || !existsSync(path)) return false;
  const r = await gitIn(runner, repoRoot)(["worktree", "remove", "--force", "--", path], repoRoot, 60_000);
  return r.code === 0;
}

export function parsePullRequestUrl(input: string): { host: string; owner: string; repo: string; number: number } | null {
  const m = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(input.trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3].replace(/\.git$/, ""), number: Number(m[4]) };
}

export function ghRepoArg(ref: { host: string; owner: string; repo: string }): string {
  return ref.host === "github.com" ? `${ref.owner}/${ref.repo}` : `${ref.host}/${ref.owner}/${ref.repo}`;
}

export function parseGhRepoArg(arg: string): { host: string; owner: string; repo: string } | null {
  const parts = arg.split("/").filter(Boolean);
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length === 3) return { host: parts[0].toLowerCase(), owner: parts[1], repo: parts[2] };
  return null;
}

export function repoKeyForGhRepo(arg: string): string | null {
  const ref = parseGhRepoArg(arg);
  return ref ? deriveGuideRepoKeyFromRemote(`https://${ref.host}/${ref.owner}/${ref.repo}.git`) : null;
}

export function ghRepoOfKey(repoKey: string): string | null {
  const parts = repoKey.split("__");
  if (parts.length !== 3 || !parts[0].includes(".")) return null;
  return ghRepoArg({ host: parts[0], owner: parts[1], repo: parts[2] });
}

export function repoClonePath(storageDir: string, repoKey: string): string {
  return join(storageDir, "repos", repoKey);
}

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

const cloning = new Map<string, Promise<RepoInfo>>();

const STALE_CLONE_MS = 60 * 60_000;

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
        rmSync(temp, { recursive: true, force: true });
        if (!existsSync(join(path, ".git"))) throw err;
      }
    }
  }
  const info = await getRepoInfo(runner, path);
  if (!info) throw new Error(`The clone of ${ghRepo} at ${path} is not a git repository.`);
  return info;
}

async function useGhForCredentials(runner: Runner, clone: string, ghRepo: string, ghPath: string | null | undefined): Promise<void> {
  const ref = parseGhRepoArg(ghRepo);
  if (!ref || !ghPath) return;
  const key = `credential.https://${ref.host}.helper`;
  const g = gitIn(runner, clone);
  await g(["config", "--local", key, ""]);
  await g(["config", "--local", "--add", key, `!${shellQuoteForGit(ghPath)} auth git-credential`]);
}

export function shellQuoteForGit(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

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
    }
  }
}

export async function pullRequestHead(runner: Runner, ghRepo: string | null, number: number, cwd?: string): Promise<string | null> {
  const r = await gh(runner, cwd, ["pr", "view", String(number), ...(ghRepo ? ["--repo", ghRepo] : []), "--json", "headRefOid"]);
  if (r.code !== 0) return null;
  const p = parseJson<{ headRefOid?: string }>(r.stdout);
  return p?.headRefOid || null;
}
