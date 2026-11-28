/**
 * Branch reviews (docs/agent-guides/inbox-files-and-guides.md, "Branch reviews"; rules in
 * packages/core/inbox-branch-reports.ts). An agent that finished work on a branch says so with `send_message`'s
 * `branch` field; this module keeps the latest report per project and branch and reads git for it.
 *
 *   inbox/branch-reports.json   { v: 1, reports: { [project id \0 branch]: InboxBranchReport } }
 *
 * - Nothing here runs on a timer. A report is read once when it arrives (its head, its base, whether the commit is in
 *   the project's checkout here); the by-hand list of branches nobody reported is read only when the person opens it.
 * - Every git command is local and may reach no host (`offlineGit`: no transport at all, `protocol.allow=never`, and no
 *   lazy fetch of a partial clone's missing objects, `GIT_NO_LAZY_FETCH=1`), with no way to ask anything
 *   (`interaction: "forbid"`), in the project's own folder, killed after `BRANCH_GIT_TIMEOUT_MS` (the diff after 5 min).
 * - Bun only: the Inbox is.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_BRANCH_REPORTS_MAX,
  INBOX_UNREPORTED_BRANCH_DAYS,
  INBOX_UNREPORTED_BRANCHES_MAX,
  inboxBranchReportKey,
  type InboxBranchReport,
  type InboxUnreportedBranch,
} from "@plannotator/core/inbox-branch-reports";
import { inboxGitRemoteKey } from "@plannotator/core/inbox-git-url";
import { inboxPullLongLived, inboxPullSafeBranch } from "@plannotator/core/inbox-types";
import { getDefaultBranch, getWorktrees, type GitCommandOptions, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_BRANCH_REPORTS_FILE = "branch-reports.json";
/** One git command of a report's read or the safety net's. */
export const BRANCH_GIT_TIMEOUT_MS = 5_000;
/** A reported branch's diff, read for its risk run, no further than this (as a PR clone's diff). */
export const BRANCH_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** The safety net looks at no more recent branches than this to find its list. */
export const UNREPORTED_SCAN_MAX = 120;

export interface InboxBranchReports {
  get(projectId: string, branch: string): InboxBranchReport | null;
  /** By thread: a thread is one branch's. */
  ofThread(threadId: string): InboxBranchReport | null;
  list(): InboxBranchReport[];
  put(report: InboxBranchReport): void;
}

/** The reports on disk: the latest per project and branch. An unreadable file is moved aside and starts empty. */
export function createInboxBranchReports(dataDir: string): InboxBranchReports {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_BRANCH_REPORTS_FILE);
  let all: Map<string, InboxBranchReport> | null = null;
  const load = (): Map<string, InboxBranchReport> => {
    if (all) return all;
    all = new Map();
    if (!existsSync(file)) return all;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; reports?: Record<string, InboxBranchReport> };
      if (parsed.v !== 1 || !parsed.reports || typeof parsed.reports !== "object") throw new Error("not a reports file");
      for (const report of Object.values(parsed.reports)) {
        if (isReport(report)) all.set(inboxBranchReportKey(report.project_id, report.branch), report);
      }
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Reports come again with the agents' next ones.
      }
    }
    return all;
  };
  const save = () => {
    const map = load();
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, reports: Object.fromEntries(map) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };
  return {
    get: (projectId, branch) => load().get(inboxBranchReportKey(projectId, branch)) ?? null,
    ofThread: (threadId) => [...load().values()].reverse().find((report) => report.thread_id === threadId) ?? null,
    list: () => [...load().values()],
    put(report) {
      const map = load();
      const key = inboxBranchReportKey(report.project_id, report.branch);
      map.delete(key);
      map.set(key, report);
      while (map.size > INBOX_BRANCH_REPORTS_MAX) map.delete(map.keys().next().value!);
      save();
    },
  };
}

function isReport(value: unknown): value is InboxBranchReport {
  const r = value as InboxBranchReport | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.project_id === "string" &&
    typeof r.branch === "string" &&
    inboxPullSafeBranch(r.branch) &&
    typeof r.thread_id === "string" &&
    typeof r.message_id === "string" &&
    typeof r.at === "string" &&
    (r.place === "here" || r.place === "cloud")
  );
}

/**
 * The oldest git whose guards hold: `GIT_CONFIG_COUNT` (how `protocol.allow=never` is given) is read from git 2.31.
 * `GIT_NO_LAZY_FETCH` needs 2.44, but below it `protocol.allow=never` already stops a partial clone's lazy fetch.
 */
export const OFFLINE_GIT_MIN: readonly [number, number] = [2, 31];
/** What a read answers when this git would ignore the guards: it fails, and nothing ran that could reach a host. */
export const OFFLINE_GIT_TOO_OLD = `git ${OFFLINE_GIT_MIN.join(".")} or newer is needed for Branch reviews to read git without any network.`;

/** `git version 2.39.5 (Apple Git-154)` → whether its guards hold; false when it can't be read. */
export function offlineGitVersionOk(text: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > OFFLINE_GIT_MIN[0] || (major === OFFLINE_GIT_MIN[0] && minor >= OFFLINE_GIT_MIN[1]);
}

/**
 * Each runtime's git, checked once for the process (`git --version`, guarded too). Only a check that could not run (git
 * missing, killed) is made again on the next read.
 */
const versionChecks = new WeakMap<ReviewGitRuntime, Promise<boolean | null>>();

const guardedOptions = (options: GitCommandOptions | undefined): GitCommandOptions => ({
  timeoutMs: BRANCH_GIT_TIMEOUT_MS,
  ...options,
  interaction: "forbid",
  config: { ...options?.config, "protocol.allow": "never" },
  env: { ...options?.env, GIT_NO_LAZY_FETCH: "1" },
});

const guardedRun = (runtime: ReviewGitRuntime): ReviewGitRuntime["runGit"] => (args, options) => runtime.runGit(args, guardedOptions(options));

async function versionAnswer(runtime: ReviewGitRuntime, cwd?: string): Promise<boolean | null> {
  let check = versionChecks.get(runtime);
  if (!check) {
    check = guardedRun(runtime)(["--version"], { cwd }).then(
      (answer) => (answer.exitCode === 0 ? offlineGitVersionOk(answer.stdout) : null),
      () => null,
    );
    versionChecks.set(runtime, check);
  }
  const ok = await check;
  if (ok === null && versionChecks.get(runtime) === check) versionChecks.delete(runtime);
  return ok;
}

/**
 * The runtime every read here goes through, the shared helpers' too (`getDefaultBranch`, `getWorktrees`): no prompt, a
 * kill after `BRANCH_GIT_TIMEOUT_MS` unless the caller gives its own, and no way to reach a host. A git too old to take
 * the guards (checked once) runs nothing: every read fails closed, never unguarded.
 */
export function offlineGit(runtime: ReviewGitRuntime): ReviewGitRuntime {
  const guarded = guardedRun(runtime);
  const bytes = runtime.runGitBytes;
  return {
    ...runtime,
    runGit: async (args, options) => {
      if ((await versionAnswer(runtime, options?.cwd)) !== true) return { stdout: "", stderr: OFFLINE_GIT_TOO_OLD, exitCode: 1 };
      return guarded(args, options);
    },
    // The capped reader (`maxOutputBytes` held to), under the same guards; absent where the runtime has none.
    runGitBytes: bytes
      ? async (args, options) => {
          if ((await versionAnswer(runtime, options?.cwd)) !== true) return { stdout: new Uint8Array(0), stderr: OFFLINE_GIT_TOO_OLD, exitCode: 1 };
          return bytes(args, guardedOptions(options));
        }
      : undefined,
  };
}

const git = (runtime: ReviewGitRuntime, root: string, args: string[]) => offlineGit(runtime).runGit(args, { cwd: root });

/** A commit id when `ref` names one in this repository, else null. */
async function commitOf(runtime: ReviewGitRuntime, root: string, ref: string): Promise<string | null> {
  if (ref.startsWith("-")) return null;
  const answer = await git(runtime, root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = answer.exitCode === 0 ? answer.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** The base as words: `origin/main` reads `main`. */
export function branchBaseName(ref: string): string {
  return ref.replace(/^origin\//, "");
}

/** Long-lived names (`inboxPullLongLived`'s) a repository's own default may have besides main and master. */
const LOCAL_DEFAULT_NAMES = ["trunk", "develop", "dev"] as const;

/**
 * The default branch's ref here, the one a branch's count and its diff both use (Reviews' "On this computer", New
 * review's branch summary): `getDefaultBranch`'s answer when it names a commit. Its last answer is a blind "master";
 * when that names nothing (a local-only `trunk`, no origin), the repository's own: `init.defaultBranch`, a long-lived
 * name, the branch checked out in its main worktree, then the one checked out here. None: the guess, so the read that
 * uses it fails, never reads as "nothing". Only for these reads: `getDefaultBranch` is unchanged for its other callers.
 */
export async function readDefaultBranch(runtime: ReviewGitRuntime, root: string): Promise<string> {
  const guarded = offlineGit(runtime);
  const guess = await getDefaultBranch(guarded, root);
  if (await commitOf(runtime, root, guess)) return guess;
  const has = async (name: string | null | undefined): Promise<boolean> => !!name && inboxPullSafeBranch(name) && (await commitOf(runtime, root, `refs/heads/${name}`)) !== null;
  const named = async (args: string[]) => {
    const answer = await git(runtime, root, args).catch(() => null);
    return answer?.exitCode === 0 ? answer.stdout.trim() : "";
  };
  const configured = await named(["config", "--get", "init.defaultBranch"]);
  if (await has(configured)) return configured;
  for (const name of LOCAL_DEFAULT_NAMES) if (await has(name)) return name;
  const main = (await getWorktrees(guarded, root).catch(() => []))[0]?.branch?.replace(/^refs\/heads\//, "");
  if (main && (await has(main))) return main;
  const here = await named(["symbolic-ref", "-q", "--short", "HEAD"]);
  return (await has(here)) ? here : guess;
}

/**
 * What git here says of a reported branch: its head (the agent's, else, with `localTip`, the branch's tip here), its
 * base (the agent's, else the repository's default branch) and whether the head is a commit in this checkout. A cloud
 * agent's report never reads a local tip (`localTip: false`): what branches this computer has is none of its business.
 * Never throws: a folder that is no repository reads as nothing here.
 */
export async function readReportedBranch(
  runtime: ReviewGitRuntime,
  root: string | null,
  input: { name: string; base?: string; head?: string },
  options: { localTip: boolean } = { localTip: true },
): Promise<{ head: string | null; base: string | null; reachable: boolean; defaultBranch: string | null }> {
  if (!root) return { head: input.head ?? null, base: input.base ?? null, reachable: false, defaultBranch: null };
  try {
    const inside = await git(runtime, root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0) return { head: input.head ?? null, base: input.base ?? null, reachable: false, defaultBranch: null };
    const tip = options.localTip ? ((await commitOf(runtime, root, `refs/heads/${input.name}`)) ?? (await commitOf(runtime, root, `refs/remotes/origin/${input.name}`))) : null;
    const named = input.head ? await commitOf(runtime, root, input.head) : null;
    const head = named ?? input.head ?? tip;
    const defaultBranch = branchBaseName(await getDefaultBranch(offlineGit(runtime), root));
    const base = input.base ?? defaultBranch;
    return { head, base, reachable: !!(named ?? (input.head ? null : tip)), defaultBranch };
  } catch {
    return { head: input.head ?? null, base: input.base ?? null, reachable: false, defaultBranch: null };
  }
}

/**
 * A cloud agent's commit counts as pushed only when a remote-tracking ref here contains it, of a remote whose URL is
 * the repository it says it pushed to. Only then is its diff ever read for risk: never a commit that exists here only
 * locally. Reads `remote.*.url` and the refs; fetches nothing.
 */
export async function pushedHere(runtime: ReviewGitRuntime, root: string, head: string, remoteUrl: string | null): Promise<boolean> {
  const wanted = remoteUrl ? inboxGitRemoteKey(remoteUrl) : null;
  if (!wanted || !/^[0-9a-f]{7,64}$/i.test(head)) return false;
  try {
    const remotes = await git(runtime, root, ["config", "--get-regexp", "--", "^remote\\..*\\.url$"]);
    if (remotes.exitCode !== 0) return false;
    const names = remotes.stdout
      .split("\n")
      .map((line) => /^remote\.(.+)\.url (.+)$/.exec(line.trim()))
      .flatMap((m) => (m && inboxGitRemoteKey(m[2]!) === wanted && /^[A-Za-z0-9._-]+$/.test(m[1]!) ? [m[1]!] : []));
    for (const name of names) {
      const holding = await git(runtime, root, ["for-each-ref", "--count=1", "--format=%(refname)", `--contains=${head}`, `refs/remotes/${name}/`]);
      if (holding.exitCode === 0 && holding.stdout.trim() !== "") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Whether a reported head is a commit here (read again when the list is: a fetch may have brought it). */
export async function branchHeadHere(runtime: ReviewGitRuntime, root: string | null, head: string | null): Promise<boolean> {
  if (!root || !head) return false;
  try {
    return (await commitOf(runtime, root, head)) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether `head` is contained in `merged` here (`merge-base --is-ancestor`): true or false when git can say, null when it
 * can't (a commit not here, a git too old). Local and offline, as every read here.
 */
export async function commitContains(runtime: ReviewGitRuntime, root: string | null, head: string, merged: string): Promise<boolean | null> {
  if (!root || !/^[0-9a-f]{7,64}$/i.test(head) || !/^[0-9a-f]{7,64}$/i.test(merged)) return null;
  try {
    const answer = await git(runtime, root, ["merge-base", "--is-ancestor", "--end-of-options", head, merged]);
    return answer.exitCode === 0 ? true : answer.exitCode === 1 && answer.stderr.trim() === "" ? false : null;
  } catch {
    return null;
  }
}

/** This computer's git answered a version older than the guards need (`offlineGit`): checked once per process. */
export async function offlineGitTooOld(runtime: ReviewGitRuntime): Promise<boolean> {
  return (await versionAnswer(runtime)) === false;
}

/** The ref a base names here: the local branch, else origin's. Null when neither is a commit. */
async function baseRef(runtime: ReviewGitRuntime, root: string, base: string): Promise<string | null> {
  if (await commitOf(runtime, root, base)) return base;
  if (await commitOf(runtime, root, `origin/${base}`)) return `origin/${base}`;
  return null;
}

/** A branch's diff past `BRANCH_DIFF_MAX_BYTES`: git was stopped there and nothing of it is kept. */
export class BranchDiffTooLarge extends Error {
  constructor() {
    super("This diff is too large to read here.");
    this.name = "BranchDiffTooLarge";
  }
}

/**
 * A reported branch's whole diff from its merge base with the base to its head (its risk run; an "On this computer"
 * row's diff). Held to `BRANCH_DIFF_MAX_BYTES` by the capped reader (`runGitBytes`; the Bun `runGit` reads whole):
 * past it, `BranchDiffTooLarge`, never a cut diff. Throws a sentence.
 */
export async function readBranchDiff(runtime: ReviewGitRuntime, root: string, base: string, head: string): Promise<string> {
  const ref = await baseRef(runtime, root, base);
  if (!ref) throw new Error(`The base ${base} isn't in the project's checkout on this computer.`);
  return diffFrom(runtime, root, ref, head);
}

/**
 * `readBranchDiff` against `ref` exactly as given, never a same-named local branch in its place: the ref
 * `readDefaultBranch` answered, so the diff and the count of commits not on it agree (a stale local main would add
 * every commit merged since to the diff).
 */
export async function readBranchDiffFrom(runtime: ReviewGitRuntime, root: string, ref: string, head: string): Promise<string> {
  if (!(await commitOf(runtime, root, ref))) throw new Error(`The base ${branchBaseName(ref)} isn't in the project's checkout on this computer.`);
  return diffFrom(runtime, root, ref, head);
}

async function diffFrom(runtime: ReviewGitRuntime, root: string, ref: string, head: string): Promise<string> {
  if (!(await commitOf(runtime, root, head))) throw new Error("The reported commit isn't in the project's checkout on this computer.");
  const git = offlineGit(runtime);
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--no-color", "--end-of-options", `${ref}...${head}`];
  const options = { cwd: root, timeoutMs: 5 * 60_000, maxOutputBytes: BRANCH_DIFF_MAX_BYTES };
  const answer = git.runGitBytes ? await git.runGitBytes(args, options) : await git.runGit(args, options);
  if (answer.truncated) throw new BranchDiffTooLarge();
  if (answer.exitCode !== 0) throw new Error("git couldn't read the branch's diff.");
  return typeof answer.stdout === "string" ? answer.stdout : new TextDecoder().decode(answer.stdout);
}

/**
 * The safety net: local branches with a commit in the last `INBOX_UNREPORTED_BRANCH_DAYS` days and commits not on the
 * default branch, newest first, at most `INBOX_UNREPORTED_BRANCHES_MAX` of them (counted after the ones with nothing of
 * their own are dropped; no more than `UNREPORTED_SCAN_MAX` are looked at), each with the worktree it is checked out in.
 * `skip`: branches reported or in a PR (given the branch's head commit). A branch whose upstream is gone (`[gone]`: its
 * remote branch was deleted, as after a squash or rebase merge) is not listed. `caps`: Reviews' "On this computer" looks at fewer (inbox-local-work.ts).
 * Read only, when the person opens the list. A read that fails or times out throws (the list says it could not be read),
 * never "nothing".
 */
export async function readUnreportedBranches(
  runtime: ReviewGitRuntime,
  root: string,
  projectId: string,
  skip: (branch: string, head: string) => boolean,
  now: number = Date.now(),
  caps: { scan: number; list: number } = { scan: UNREPORTED_SCAN_MAX, list: INBOX_UNREPORTED_BRANCHES_MAX },
): Promise<{ git: boolean; branches: InboxUnreportedBranch[] }> {
  const inside = await git(runtime, root, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  if (inside?.stderr === OFFLINE_GIT_TOO_OLD) throw new Error(OFFLINE_GIT_TOO_OLD);
  if (!inside || inside.exitCode !== 0) return { git: false, branches: [] };
  const baseRefName = await readDefaultBranch(runtime, root);
  const base = branchBaseName(baseRefName);
  const listed = await git(runtime, root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(committerdate:unix)%00%(objectname)%00%(upstream:track)", "refs/heads/"]);
  if (listed.exitCode !== 0) throw new Error("git couldn't list the branches.");
  const since = now / 1000 - INBOX_UNREPORTED_BRANCH_DAYS * 86_400;
  const candidates: { branch: string; at: number }[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [ref, at, head = "", track = ""] = line.split("\u0000");
    const seconds = Number(at);
    // The full ref, never `%(refname:short)`: a name that is also a tag would read `heads/x` there.
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
    if (!branch || !Number.isFinite(seconds) || seconds < since) continue;
    if (!inboxPullSafeBranch(branch) || inboxPullLongLived(branch) || branch === base || track === "[gone]" || skip(branch, head)) continue;
    candidates.push({ branch, at: seconds });
    if (candidates.length >= caps.scan) break;
  }
  if (candidates.length === 0) return { git: true, branches: [] };
  const worktrees = await getWorktrees(offlineGit(runtime), root).catch(() => []);
  const checkedOut = new Map(worktrees.flatMap((tree) => (tree.branch ? [[tree.branch.replace(/^refs\/heads\//, ""), tree.path] as const] : [])));
  const branches: InboxUnreportedBranch[] = [];
  for (const { branch, at } of candidates) {
    const ahead = await git(runtime, root, ["rev-list", "--count", "--end-of-options", `${baseRefName}..refs/heads/${branch}`]);
    if (ahead.exitCode !== 0) throw new Error("git couldn't read the branches.");
    const count = Number(ahead.stdout.trim());
    if (!Number.isFinite(count) || count <= 0) continue;
    branches.push({ project_id: projectId, branch, base, ahead: count, last_commit_at: new Date(at * 1000).toISOString(), worktree: checkedOut.get(branch) ?? null });
    if (branches.length >= caps.list) break;
  }
  return { git: true, branches };
}
