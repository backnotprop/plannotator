/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5): the PRs and MRs that matter to the person, read with their own
 * `gh` and `glab`, only while the Pull requests page is open and Settings →
 * Capabilities → Code review is on. The route (`GET /api/inbox/pulls`)
 * refuses before anything runs while the switch is off.
 *
 * Read only, and kept to what the hover cards already allow (ref-cards.ts):
 * - Hosts: only the hosts of the Inbox projects' `origin` remotes, and only
 *   those the person's own `gh` or `glab` reports as signed in
 *   (`readSignedInHosts`), github.com and gitlab.com included. `--hostname`
 *   is always named, so neither GH_HOST nor a folder's remote picks it.
 * - One GraphQL `query` per host (refused to load otherwise): the PRs whose
 *   review was requested from the person, the ones they opened, and the ones
 *   they merged in the last `INBOX_PULLS_MERGED_DAYS` (to put a stack's
 *   merged layers under it). Only PRs of the projects' repositories are kept.
 * - Cache per host: fresh for `INBOX_PULLS_FRESH_MS`; a `refresh` (the window
 *   got its focus back, or the person asked) reads again what is older than
 *   `INBOX_PULLS_REFRESH_MS`; a failure is held `REF_FAILURE_MS` and the last
 *   answer stays on screen; a rate-limit answer holds the host for
 *   `REF_RATE_LIMIT_MS`. One read per host at a time.
 * - A layer's diff (`diff`) is read only for a PR the last list named: the
 *   PR's own diff, or the compare from the stack's base to that layer's head.
 *
 * Linking a PR to its agent (`linkInboxPulls`) runs here, on this computer,
 * with no forge call: a Board card that links the PR, the PR's URL in an
 * agent's message, or (the person's own PRs only) the PR's head branch being
 * the branch checked out in an agent thread's folder (one `git rev-parse`
 * per folder, cached).
 */

import { createHash } from "node:crypto";
import type { PatchBlobIds } from "@plannotator/core/diff-files";
import { forgeRefKey } from "@plannotator/core/forge-ref-card";
import {
  INBOX_PULLS_MERGED_DAYS,
  INBOX_PULLS_SEARCH_MAX,
  inboxCardRefsOf,
  inboxPullRepoKey,
  inboxPullStacks,
  inboxPullUrlsIn,
  type InboxCard,
  type InboxFileContents,
  type InboxMessage,
  type InboxPull,
  type InboxPullChecks,
  type InboxPullCliState,
  inboxPullCompareBranch,
  type InboxPullDiffAnswer,
  type InboxPullDiffScope,
  type InboxPullHost,
  inboxPullSafeBranch,
  type InboxPullCard,
  type InboxPullLink,
  type InboxPullReview,
  type InboxPullState,
} from "@plannotator/core/inbox-types";
import { parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { reconstructGitlabPatch, type GitLabDiffEntry } from "@plannotator/shared/pr-provider";
import { MAX_REVIEW_FILE_CONTENT_BYTES, readGitObjectBytes } from "@plannotator/shared/review-core";
import { runtime as gitRuntime } from "./git";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCli, type RefCommandResult, type RefRunner } from "./ref-cards";

/** A host's answer is fresh this long. */
export const INBOX_PULLS_FRESH_MS = 60_000;
/** A refresh reads again what is older than this. */
export const INBOX_PULLS_REFRESH_MS = 20_000;
/** A patch larger than this is refused (the review says to open it on the forge). */
export const INBOX_PULL_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** A layer's diff is kept this long (keyed by the PR's last update too). */
export const INBOX_PULL_DIFF_FRESH_MS = 5 * 60_000;

/** One file's text larger than this is not read (the diff stays as it came): the review's own expansion cap. */
export const INBOX_PULL_FILE_MAX_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;
/** Texts kept in memory, across files: past this the oldest go. A commit's file never changes, so nothing else ages them. */
export const INBOX_PULL_FILE_CACHE_BYTES = 64 * 1024 * 1024;
/** And at most this many (a missing or binary file's answer weighs nothing). */
const INBOX_PULL_FILE_CACHE_ENTRIES = 2048;
/** At most this many reads at once: a PR's first screen asks for every file on it together. */
const INBOX_PULL_FILE_READS_AT_ONCE = 6;

/** A commit id as the forge answered it (40 or 64 hex digits), or null. */
function shaOf(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value) ? value.toLowerCase() : null;
}

// --- the queries ---

const GH_PULL = `number title url state isDraft updatedAt mergedAt baseRefName headRefName headRefOid additions deletions changedFiles reviewDecision mergeable
      repository { nameWithOwner } baseRepository { defaultBranchRef { name } } headRepository { nameWithOwner } author { login avatarUrl }
      reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      latestReviews(first: 5) { nodes { state author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** One query per GitHub host: the viewer, and the three searches (the open ones with their full count: more than a read takes is said). */
export const GITHUB_PULLS_QUERY = `query InboxPulls($requested: String!, $authored: String!, $merged: String!) {
  viewer { login }
  requested: search(type: ISSUE, query: $requested, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  authored: search(type: ISSUE, query: $authored, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  merged: search(type: ISSUE, query: $merged, first: 30) { nodes { ... on PullRequest { ${GH_PULL} } } }
}`;

const GL_MR = `iid title webUrl state draft updatedAt mergedAt sourceBranch targetBranch diffHeadSha approved detailedMergeStatus conflicts
      diffStatsSummary { additions deletions fileCount } headPipeline { status }
      project { fullPath repository { rootRef } } sourceProject { fullPath } author { username avatarUrl }
      approvedBy(first: 3) { nodes { username } } reviewers(first: 5) { nodes { username } }`;

/** One query per GitLab host: the current user's requested, opened and merged MRs. */
export const GITLAB_PULLS_QUERY = `query InboxPulls {
  currentUser {
    username
    requested: reviewRequestedMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { count nodes { ${GL_MR} } }
    authored: authoredMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { count nodes { ${GL_MR} } }
    merged: authoredMergeRequests(state: merged, first: 20, sort: MERGED_AT_DESC) { nodes { ${GL_MR} } }
  }
}`;

for (const q of [GITHUB_PULLS_QUERY, GITLAB_PULLS_QUERY]) {
  if (!/^query\b/.test(q)) throw new Error("inbox-pulls: every query must be a query");
}

/** GitHub's search refuses a query past this many characters. */
export const GITHUB_SEARCH_MAX_CHARS = 256;

/**
 * The three GitHub searches (the merged one goes back `INBOX_PULLS_MERGED_DAYS` from `now`), newest first.
 * With the projects' repositories (`owner/repo`) they are scoped to them (`repo:` qualifiers, as many as fit
 * GitHub's length limit in the longest search), so the 50-a-search cap is spent on the projects' PRs; past that
 * the search covers everything and the list keeps the projects' PRs.
 */
export function githubPullSearches(now: number, repos: readonly string[] = []): { requested: string; authored: string; merged: string } {
  const since = new Date(now - INBOX_PULLS_MERGED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const bare = {
    requested: "is:pr is:open archived:false review-requested:@me sort:updated-desc",
    authored: "is:pr is:open archived:false author:@me sort:updated-desc",
    merged: `is:pr is:merged author:@me merged:>=${since} sort:updated-desc`,
  };
  const scope = [...new Set(repos.map((r) => r.toLowerCase()))].sort().map((r) => `repo:${r}`).join(" ");
  const longest = Math.max(...Object.values(bare).map((q) => q.length));
  if (!scope || longest + 1 + scope.length > GITHUB_SEARCH_MAX_CHARS) return bare;
  return { requested: `${bare.requested} ${scope}`, authored: `${bare.authored} ${scope}`, merged: `${bare.merged} ${scope}` };
}

// --- reading the answers ---

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);

function splitPath(path: string): { owner: string; repo: string } | null {
  const at = path.lastIndexOf("/");
  if (at <= 0 || at === path.length - 1) return null;
  return { owner: path.slice(0, at), repo: path.slice(at + 1) };
}

/** A host's answer: the login, its PRs, and how many open ones its searches found past what one read takes. */
export interface ParsedPulls {
  login: string | null;
  pulls: InboxPull[];
  /** The open searches (requested, authored) found more than they answered: how many came back, of how many. */
  capped?: { shown: number; total: number };
  /**
   * By author login: the profile picture's URL as the forge answered it (absolute; GitLab's relative `/uploads/…`
   * resolved on the host). Kept on the server: the window asks the Inbox for the picture, never the forge.
   */
  avatars: Record<string, string>;
}

/** An author's avatar URL as the forge gave it, absolute; "" when it gave none or it is not a URL. */
function avatarOf(value: unknown, host: string): string {
  const raw = str(value);
  if (!raw) return "";
  try {
    return new URL(raw, `https://${host}/`).href;
  } catch {
    return "";
  }
}

/** The open searches' counts (GitHub `issueCount`, GitLab `count`) against the nodes they answered; undefined when nothing was left out. */
function cappedOf(lists: unknown[], countKey: "issueCount" | "count"): ParsedPulls["capped"] {
  let shown = 0;
  let total = 0;
  for (const list of lists) {
    const got = nodes(list).length;
    const count = obj(list)[countKey];
    shown += got;
    total += typeof count === "number" && Number.isFinite(count) && count > got ? count : got;
  }
  return total > shown ? { shown, total } : undefined;
}

/** A GitHub answer as the viewer's login and PRs; null when it is not one. */
export function parseGithubPulls(stdout: string, host: string): ParsedPulls | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = obj(obj(parsed).data);
  if (!data.viewer && !data.authored && !data.requested) return null;
  const login = str(obj(data.viewer).login) || null;
  const out = new Map<string, InboxPull>();
  const avatars: Record<string, string> = {};
  const read = (list: unknown, requested: boolean) => {
    for (const item of nodes(list)) {
      const repo = str(obj(item.repository).nameWithOwner);
      const parts = splitPath(repo);
      const number = num(item.number);
      if (!parts || number < 1) continue;
      const key = forgeRefKey({ platform: "github", host, owner: parts.owner, repo: parts.repo, number, kind: "pull" });
      const author = str(obj(item.author).login) || null;
      const avatar = author ? avatarOf(obj(item.author).avatarUrl, host) : "";
      if (author && avatar) avatars[author] = avatar;
      const defaultBranch = str(obj(obj(item.baseRepository).defaultBranchRef).name);
      const state: InboxPullState = item.state === "MERGED" ? "merged" : item.state === "CLOSED" ? "closed" : item.isDraft === true ? "draft" : "open";
      const rollup = str(obj(obj(obj(nodes(item.commits)[0]).commit).statusCheckRollup).state);
      const checks: InboxPullChecks | null = rollup === "SUCCESS" ? "success" : rollup === "PENDING" || rollup === "EXPECTED" ? "pending" : rollup === "FAILURE" || rollup === "ERROR" ? "failure" : null;
      const review: InboxPullReview | null =
        item.reviewDecision === "APPROVED" ? "approved" : item.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : item.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null;
      const approver = nodes(item.latestReviews).find((r) => r.state === "APPROVED");
      const reviewers = nodes(item.reviewRequests)
        .map((r) => obj(r.requestedReviewer))
        .map((r) => str(r.login) || str(r.slug))
        .filter((name) => name !== "" && name !== login);
      const earlier = out.get(key);
      out.set(key, {
        key,
        platform: "github",
        host,
        repo,
        number,
        url: str(item.url),
        title: str(item.title),
        author,
        mine: login !== null && author === login,
        requested: requested || earlier?.requested === true,
        state,
        base: str(item.baseRefName),
        head: str(item.headRefName),
        head_repo: str(obj(item.headRepository).nameWithOwner) || null,
        head_sha: shaOf(item.headRefOid),
        additions: num(item.additions),
        deletions: num(item.deletions),
        files: num(item.changedFiles),
        review,
        approved_by: approver ? str(obj(approver.author).login) || null : null,
        reviewers,
        checks,
        // `UNKNOWN` (GitHub has not worked it out yet) says nothing.
        ...(state === "open" || state === "draft" ? (item.mergeable === "CONFLICTING" ? { conflicts: true } : item.mergeable === "MERGEABLE" ? { conflicts: false } : {}) : {}),
        ...(defaultBranch ? { default_branch: defaultBranch } : {}),
        updated_at: str(item.updatedAt),
        merged_at: str(item.mergedAt) || null,
      });
    }
  };
  read(data.authored, false);
  read(data.merged, false);
  read(data.requested, true);
  const capped = cappedOf([data.requested, data.authored], "issueCount");
  return { login, pulls: [...out.values()], avatars, ...(capped ? { capped } : {}) };
}

const GL_FAIL = new Set(["FAILED", "CANCELED"]);
const GL_QUIET = new Set(["SKIPPED", "MANUAL"]);

/** A GitLab answer as the current user's name and MRs; null when it is not one. */
export function parseGitlabPulls(stdout: string, host: string): ParsedPulls | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const user = obj(obj(obj(parsed).data).currentUser);
  if (!user.username) return null;
  const login = str(user.username) || null;
  const out = new Map<string, InboxPull>();
  const avatars: Record<string, string> = {};
  const read = (list: unknown, requested: boolean) => {
    for (const item of nodes(list)) {
      const repo = str(obj(item.project).fullPath);
      const parts = splitPath(repo);
      const number = num(item.iid);
      if (!parts || number < 1) continue;
      const key = forgeRefKey({ platform: "gitlab", host, owner: parts.owner, repo: parts.repo, number, kind: "pull" });
      const author = str(obj(item.author).username) || null;
      const avatar = author ? avatarOf(obj(item.author).avatarUrl, host) : "";
      if (author && avatar) avatars[author] = avatar;
      const defaultBranch = str(obj(obj(item.project).repository).rootRef);
      const state: InboxPullState = item.state === "merged" ? "merged" : item.state === "opened" ? (item.draft === true ? "draft" : "open") : "closed";
      const status = str(obj(item.headPipeline).status);
      const checks: InboxPullChecks | null = !status || GL_QUIET.has(status) ? null : status === "SUCCESS" ? "success" : GL_FAIL.has(status) ? "failure" : "pending";
      const merge = str(item.detailedMergeStatus);
      const review: InboxPullReview | null = merge === "REQUESTED_CHANGES" ? "changes_requested" : item.approved === true ? "approved" : merge === "NOT_APPROVED" ? "review_required" : null;
      const stats = obj(item.diffStatsSummary);
      const approvers = nodes(item.approvedBy).map((n) => str(n.username)).filter(Boolean);
      const earlier = out.get(key);
      out.set(key, {
        key,
        platform: "gitlab",
        host,
        repo,
        number,
        url: str(item.webUrl),
        title: str(item.title),
        author,
        mine: login !== null && author === login,
        requested: requested || earlier?.requested === true,
        state,
        base: str(item.targetBranch),
        head: str(item.sourceBranch),
        head_repo: str(obj(item.sourceProject).fullPath) || null,
        head_sha: shaOf(item.diffHeadSha),
        additions: num(stats.additions),
        deletions: num(stats.deletions),
        files: num(stats.fileCount),
        review: state === "merged" || state === "closed" ? null : review,
        approved_by: approvers[0] ?? null,
        reviewers: nodes(item.reviewers)
          .map((n) => str(n.username))
          .filter((name) => name !== "" && name !== login && !approvers.includes(name)),
        checks,
        ...(state === "open" || state === "draft" ? (typeof item.conflicts === "boolean" ? { conflicts: item.conflicts } : {}) : {}),
        ...(defaultBranch ? { default_branch: defaultBranch } : {}),
        updated_at: str(item.updatedAt),
        merged_at: str(item.mergedAt) || null,
      });
    }
  };
  read(user.authored, false);
  read(user.merged, false);
  read(user.requested, true);
  const capped = cappedOf([user.requested, user.authored], "count");
  return { login, pulls: [...out.values()], avatars, ...(capped ? { capped } : {}) };
}

// --- the reader ---

/** A repository the Inbox works in: an Inbox project's `origin`. */
export interface InboxPullRepo {
  host: string;
  /** `owner/repo` (GitLab: the full path). */
  repo: string;
  project_id: string;
}

interface HostAnswer {
  at: number;
  login: string | null;
  pulls: InboxPull[];
  /** The open searches' raw counts: how many nodes came back, of how many they found. */
  capped?: { shown: number; total: number };
  /** Whether the searches were limited to the projects' repositories (GitHub `repo:` qualifiers that fit). */
  scoped: boolean;
  avatars: Record<string, string>;
  /** The repositories the searches were scoped to (lowercased, sorted, space-separated). */
  repos: string;
}

interface HostState {
  cli: RefCli;
  answer: HostAnswer | null;
  failedAt: number;
  error: InboxPullHost["error"] | null;
  pending: Promise<void> | null;
}

export class InboxPullsError extends Error {
  constructor(
    readonly code: "pull_unknown" | "pull_diff_failed" | "pull_diff_too_large" | "pull_diff_fork" | "validation_error",
    message: string,
  ) {
    super(message);
  }
}

export interface InboxPulls {
  /**
   * The PRs of these repositories, with the hosts asked, what each CLI asked was found to be (`clis`), and the
   * repositories' hosts no CLI here is signed in to (`unsigned`). Never throws.
   */
  list(
    repos: readonly InboxPullRepo[],
    options?: { refresh?: boolean },
  ): Promise<{ fetched_at: string | null; hosts: InboxPullHost[]; pulls: InboxPull[]; clis: Partial<Record<RefCli, InboxPullCliState>>; unsigned: string[] }>;
  /** A PR the last list named, by key. */
  find(key: string): InboxPull | null;
  /** The profile pictures' URLs of the authors of the PRs the last list showed on this host, by login. */
  avatarUrls(host: string): Record<string, string>;
  /** One layer's patch, or the stack's from its base up to that layer. Throws InboxPullsError. */
  diff(key: string, scope: InboxPullDiffScope): Promise<InboxPullDiffAnswer>;
  /** The head commit of the last layer patch read for this PR (`diff`'s `head_sha`), or null. */
  readHead(key: string): string | null;
  /**
   * One file's whole text at the commits this PR's diff runs between, for the viewer's expand arrows: read from the
   * first of `roots` (local clones of the repository) that has the commit, else from the forge. Both sides null when
   * either is missing, binary, too large or can't be read, and for a fork's layer. Throws InboxPullsError only for a
   * PR the last list did not name.
   */
  /** `ids` are the blobs the patch on screen names: a text that does not hash to them is not that patch's file, and no arrows open. */
  fileContents(key: string, scope: InboxPullDiffScope, path: string, roots: readonly string[], ids: PatchBlobIds | null): Promise<InboxFileContents>;
}

/** A local clone's read of one file at one commit (`<sha>:<path>`), capped. Null: this clone can't say. "none": it has the commit but no usable text. */
export type PullFileGitReader = (root: string, sha: string, path: string, maxBytes: number) => Promise<string | "none" | null>;

/** The id git gives a blob of these bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\u0000`).update(bytes).digest("hex");
}

/** This text is the blob a patch's `index` line names (the line carries a prefix of the id). */
function isBlob(text: string, id: string): boolean {
  return gitBlobId(Buffer.from(text, "utf8")).startsWith(id);
}

/** The text in these bytes, or null when they are binary (a NUL early on, git's own test). */
export function textOfBytes(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

const pullFileGitRead: PullFileGitReader = async (root, sha, path, maxBytes) => {
  const read = await readGitObjectBytes(gitRuntime, `${sha}:${path}`, maxBytes, root);
  if (read.kind === "too-large") return "none";
  if (read.kind !== "ok") return null;
  return textOfBytes(read.bytes) ?? "none";
};

/** A GitHub owner as `owner:branch` takes it in a compare (a fork's head). */
const FORK_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Core's branch check for words (`inboxPullSafeBranch`): the hand-off names a branch only when it passes. */
export const safeBranch = inboxPullSafeBranch;
/** Core's branch check for the compare (`inboxPullCompareBranch`): any branch name git takes, percent-encoded into the URL. */
export const compareBranch = inboxPullCompareBranch;

/** A branch in a compare's path: each character percent-encoded but the `/` between its parts (`übersetzung/x` → `%C3%BCbersetzung/x`). */
function compareRef(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** A diff read: the CLI's answer, or `tooLarge` once its output passed `maxBytes` (it is stopped there). */
export type PullDiffRunner = (cli: RefCli, args: string[], maxBytes: number) => Promise<RefCommandResult & { tooLarge?: boolean }>;

/** A diff can take longer than a card's query. */
export const INBOX_PULL_DIFF_TIMEOUT_MS = 30_000;

/**
 * gh / glab for a diff, read as a stream: the bytes are counted as they come and the CLI is stopped past
 * `maxBytes`, so a huge diff is never held whole in memory.
 */
export const pullDiffCliRunner: PullDiffRunner = async (cli, args, maxBytes) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cli, ...args], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { stdout: "", stderr: `${cli}: not found`, exitCode: 127 };
  }
  const timer = setTimeout(() => proc.kill(), INBOX_PULL_DIFF_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let tooLarge = false;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stderr = new Response(proc.stderr as ReadableStream).text();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        proc.kill();
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const exitCode = await proc.exited;
    if (tooLarge) return { stdout: "", stderr: "", exitCode: 1, tooLarge: true };
    return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: await stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

/** A runner that buffers (the tests' scripted one) under the same byte cap. */
function cappedDiffRunner(run: RefRunner): PullDiffRunner {
  return async (cli, args, maxBytes) => {
    const result = await run(cli, args);
    return Buffer.byteLength(result.stdout, "utf8") > maxBytes ? { stdout: "", stderr: "", exitCode: 1, tooLarge: true } : result;
  };
}

export function createInboxPulls(options: { run?: RefRunner; diffRun?: PullDiffRunner; gitRead?: PullFileGitReader; now?: () => number } = {}): InboxPulls {
  const run = options.run ?? refCliRunner;
  const diffRun = options.diffRun ?? (options.run ? cappedDiffRunner(options.run) : pullDiffCliRunner);
  const gitRead = options.gitRead ?? pullFileGitRead;
  const now = options.now ?? Date.now;
  const hosts = new Map<string, HostState>();
  const holdUntil = new Map<string, number>();
  const fileHoldUntil = new Map<string, number>();
  const signed = new Map<RefCli, { at: number; ttl: number; set: Promise<Set<string>>; missing: boolean }>();
  const diffs = new Map<string, { at: number; answer: InboxPullDiffAnswer }>();
  const readHeads = new Map<string, string | null>();
  let known = new Map<string, InboxPull>();
  let lastRepos = new Set<string>();
  let avatars = new Map<string, Record<string, string>>();
  // A diff's base commit, by its head (a pushed head has its own), and each file's text by commit: a commit's file
  // never changes, so a settled answer stays until the bound. A failed read is forgotten, for the next look to retry.
  const mergeBases = new Map<string, Promise<string | null>>();
  const fileTexts = new Map<string, { read: Promise<string | null>; bytes: number }>();
  let fileTextBytes = 0;
  let readsRunning = 0;
  const readsWaiting: (() => void)[] = [];
  const inTurn = async <T>(task: () => Promise<T>): Promise<T> => {
    if (readsRunning >= INBOX_PULL_FILE_READS_AT_ONCE) await new Promise<void>((resolve) => readsWaiting.push(resolve));
    readsRunning++;
    try {
      return await task();
    } finally {
      readsRunning--;
      readsWaiting.shift()?.();
    }
  };

  const signedIn = (cli: RefCli): Promise<Set<string>> => {
    const hit = signed.get(cli);
    if (hit && now() - hit.at < hit.ttl) return hit.set;
    // The same calls `readSignedInHosts` makes, watched: a CLI that is not installed is told apart from one signed out.
    const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, set: Promise.resolve(new Set<string>()), missing: false };
    const watched: RefRunner = async (c, args, env) => {
      const result = await run(c, args, env);
      if (refErrorOf(c, result) === "cli_missing") entry.missing = true;
      return result;
    };
    const set = readSignedInHosts(watched, cli).catch(() => new Set<string>());
    entry.set = set;
    signed.set(cli, entry);
    void set.then((found) => {
      if (found.size === 0) entry.ttl = REF_FAILURE_MS;
    });
    return set;
  };

  /**
   * The CLI signed in to a host, or null: nothing is asked of a host no CLI here is signed in to. What each CLI asked
   * turned out to be goes into `states`, the one list call's own (two lists at once never share it).
   */
  const cliFor = async (host: string, states: Partial<Record<RefCli, InboxPullCliState>>): Promise<RefCli | null> => {
    const order: RefCli[] = /gitlab/i.test(host) ? ["glab", "gh"] : ["gh", "glab"];
    for (const cli of order) {
      const set = await signedIn(cli);
      states[cli] = signed.get(cli)?.missing ? "missing" : set.size > 0 ? "signed_in" : "signed_out";
      if (set.has(host)) return cli;
    }
    return null;
  };

  const read = (host: string, state: HostState, repos: readonly string[]): Promise<void> => {
    if (state.pending) return state.pending;
    const reposKey = [...repos].map((r) => r.toLowerCase()).sort().join(" ");
    const job = (async () => {
      if (now() < (holdUntil.get(host) ?? 0)) {
        state.error = "rate_limited";
        state.failedAt = now();
        return;
      }
      const searches = state.cli === "gh" ? githubPullSearches(now(), repos) : null;
      // GitLab's lists are the user's own, never limited to the projects; GitHub's are while the repositories fit.
      const scoped = !!searches && searches.authored.includes(" repo:");
      const args = searches
        ? ["api", "graphql", "--hostname", host, "-f", `query=${GITHUB_PULLS_QUERY}`, "-f", `requested=${searches.requested}`, "-f", `authored=${searches.authored}`, "-f", `merged=${searches.merged}`]
        : ["api", "--hostname", host, "graphql", "-f", `query=${GITLAB_PULLS_QUERY}`];
      const result = await run(state.cli, args);
      const parsed = result.exitCode === 0 ? (state.cli === "gh" ? parseGithubPulls(result.stdout, host) : parseGitlabPulls(result.stdout, host)) : null;
      if (!parsed) {
        const error = refErrorOf(state.cli, { ...result, exitCode: result.exitCode || 1 });
        if (error === "rate_limited") holdUntil.set(host, now() + REF_RATE_LIMIT_MS);
        state.error = error === "rate_limited" ? "rate_limited" : "unavailable";
        state.failedAt = now();
        return;
      }
      state.answer = { at: now(), login: parsed.login, pulls: parsed.pulls, avatars: parsed.avatars, scoped, repos: reposKey, ...(parsed.capped ? { capped: parsed.capped } : {}) };
      state.error = null;
    })()
      .catch(() => {
        state.error = "unavailable";
        state.failedAt = now();
      })
      .finally(() => {
        state.pending = null;
      });
    state.pending = job;
    return job;
  };

  const due = (state: HostState, refresh: boolean): boolean => {
    if (state.error && now() - state.failedAt < REF_FAILURE_MS) return false;
    if (!state.answer) return true;
    return now() - state.answer.at >= (refresh ? INBOX_PULLS_REFRESH_MS : INBOX_PULLS_FRESH_MS);
  };

  return {
    async list(repos, { refresh = false } = {}) {
      const wanted = new Set(repos.map((r) => inboxPullRepoKey(r.host, r.repo)));
      const byHost = new Map<string, InboxPullRepo[]>();
      for (const repo of repos) {
        const host = repo.host.toLowerCase();
        byHost.set(host, [...(byHost.get(host) ?? []), repo]);
      }
      const asked: { host: string; state: HostState }[] = [];
      const unsigned: string[] = [];
      const cliStates: Partial<Record<RefCli, InboxPullCliState>> = {};
      await Promise.all(
        [...byHost.keys()].map(async (host) => {
          const cli = await cliFor(host, cliStates);
          if (!cli) {
            unsigned.push(host);
            return;
          }
          let state = hosts.get(host);
          if (!state || state.cli !== cli) {
            state = { cli, answer: null, failedAt: 0, error: null, pending: null };
            hosts.set(host, state);
          }
          const repoNames = byHost.get(host)!.map((r) => r.repo);
          // The searches are scoped to the projects' repositories: a new set of them reads again.
          const reposKey = [...repoNames].map((r) => r.toLowerCase()).sort().join(" ");
          if (due(state, refresh) || (state.answer && state.answer.repos !== reposKey && !(state.error && now() - state.failedAt < REF_FAILURE_MS))) await read(host, state, repoNames);
          asked.push({ host, state });
        }),
      );
      asked.sort((a, b) => a.host.localeCompare(b.host));
      const pulls: InboxPull[] = [];
      for (const { state } of asked) for (const pull of state.answer?.pulls ?? []) if (wanted.has(inboxPullRepoKey(pull.host, pull.repo))) pulls.push(pull);
      known = new Map(pulls.map((p) => [p.key, p]));
      lastRepos = wanted;
      // Only the authors of PRs this list shows: the window may ask for their pictures, no one else's.
      const nextAvatars = new Map<string, Record<string, string>>();
      for (const { host, state } of asked) {
        const urls: Record<string, string> = {};
        for (const pull of pulls) {
          if (pull.host.toLowerCase() !== host || !pull.author) continue;
          const url = state.answer?.avatars[pull.author];
          if (url) urls[pull.author] = url;
        }
        nextAvatars.set(host, urls);
      }
      avatars = nextAvatars;
      /**
       * What the list shows of a host whose searches left PRs out: its open PRs in this list, and (searches limited
       * to the projects' repositories) those plus the ones left out; else how many of those are the projects' is not
       * known (null).
       */
      const cappedOfHost = (host: string, answer: HostAnswer | null): InboxPullHost["capped"] | undefined => {
        if (!answer?.capped || answer.capped.total <= answer.capped.shown) return undefined;
        const shown = pulls.filter((p) => p.host.toLowerCase() === host && (p.state === "open" || p.state === "draft")).length;
        return { shown, total: answer.scoped ? shown + (answer.capped.total - answer.capped.shown) : null };
      };
      const times = asked.map((a) => a.state.answer?.at).filter((t): t is number => typeof t === "number");
      return {
        fetched_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        hosts: asked.map(({ host, state }): InboxPullHost => {
          const capped = cappedOfHost(host, state.answer);
          return {
            cli: state.cli,
            host,
            login: state.answer?.login ?? null,
            // A host that failed this time still shows its last answer, when there is one: the window says so.
            ...(state.error ? { error: state.error, ...(state.answer ? { last_read: new Date(state.answer.at).toISOString() } : {}) } : {}),
            ...(capped ? { capped } : {}),
          };
        }),
        pulls,
        clis: { ...cliStates },
        unsigned: unsigned.sort(),
      };
    },
    find(key) {
      return known.get(key) ?? null;
    },
    avatarUrls(host) {
      return { ...(avatars.get(host.toLowerCase()) ?? {}) };
    },
    readHead: (key) => readHeads.get(key) ?? null,
    async diff(key, scope) {
      const pull = known.get(key);
      if (!pull || !lastRepos.has(inboxPullRepoKey(pull.host, pull.repo))) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
      // Whole stack: from the branch the lowest open layer is based on (merged layers are not read again), and from
      // the stack's own base when that branch is gone (a merged layer's branch, deleted).
      let bases = [pull.base];
      if (scope === "stack") {
        const stack = inboxPullStacks([...known.values()].filter((p) => p.host === pull.host && p.repo === pull.repo)).find((s) => s.layers.some((l) => l.key === key));
        bases = [...new Set([stack?.open_base ?? pull.base, stack?.base ?? pull.base])];
      }
      // A layer from a fork: its branch lives in the fork, never under the same name upstream.
      const fork = !!pull.head_repo && pull.head_repo.toLowerCase() !== pull.repo.toLowerCase();
      let head = pull.head;
      // The compare's head as its URL takes it: the branch percent-encoded, a fork's owner before it.
      let headRef = compareRef(pull.head);
      if (scope === "stack" && fork) {
        const owner = splitPath(pull.head_repo!)?.owner ?? "";
        if (pull.platform !== "github" || !FORK_OWNER.test(owner)) {
          throw new InboxPullsError("pull_diff_fork", `This layer comes from a fork, which ${pull.platform === "gitlab" ? "GitLab" : "the forge"} can't compare with the stack here. Review it layer by layer, or open it on the forge.`);
        }
        head = `${owner}:${pull.head}`;
        headRef = `${owner}:${compareRef(pull.head)}`;
      }
      const cacheKey = `${key}\u0000${scope}\u0000${bases[0]}\u0000${pull.updated_at}`;
      const hit = diffs.get(cacheKey);
      if (hit && now() - hit.at < INBOX_PULL_DIFF_FRESH_MS) return hit.answer;
      if (scope === "stack" && (!bases.every(compareBranch) || !compareBranch(pull.head))) throw new InboxPullsError("pull_diff_failed", "This stack's branch names can't be compared here. Open it on the forge.");
      const state = hosts.get(pull.host);
      const cli: RefCli = state?.cli ?? (pull.platform === "github" ? "gh" : "glab");
      if (now() < (holdUntil.get(pull.host) ?? 0)) throw new InboxPullsError("pull_diff_failed", `${pull.host} asked to slow down. Try again in a minute.`);
      const parts = splitPath(pull.repo)!;
      const argsFor = (base: string): string[] => {
        if (pull.platform === "github") {
          const endpoint = scope === "layer" ? `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}` : `repos/${parts.owner}/${parts.repo}/compare/${compareRef(base)}...${headRef}`;
          return ["api", "--hostname", pull.host, endpoint, "-H", "Accept: application/vnd.github.v3.diff"];
        }
        const project = encodeURIComponent(pull.repo);
        const endpoint =
          scope === "layer"
            ? `projects/${project}/merge_requests/${pull.number}/raw_diffs`
            : `projects/${project}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(pull.head)}&straight=false`;
        return ["api", "--hostname", pull.host, endpoint];
      };
      // A layer's head commit, read around its patch: a push between the two reads leaves it unknown (no post).
      const headNow = async (): Promise<string | null> => {
        const endpoint = pull.platform === "github" ? `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}` : `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`;
        const read = await run(cli, ["api", "--hostname", pull.host, endpoint, ...(pull.platform === "github" ? ["--jq", ".head.sha"] : [])]).catch(() => null);
        if (!read || read.exitCode !== 0) return null;
        if (pull.platform === "github") return shaOf(read.stdout.trim());
        try {
          const mr = obj(JSON.parse(read.stdout));
          return shaOf(mr.sha) ?? shaOf(obj(mr.diff_refs).head_sha);
        } catch {
          return null;
        }
      };
      const headBefore = scope === "layer" ? await headNow() : null;
      let base = bases[0]!;
      let result = await diffRun(cli, argsFor(base), INBOX_PULL_DIFF_MAX_BYTES);
      if (result.exitCode !== 0 && !result.tooLarge && bases.length > 1 && /\b404\b|not found|no common ancestor|could not compare/i.test(`${result.stderr}\n${result.stdout}`)) {
        base = bases[1]!;
        result = await diffRun(cli, argsFor(base), INBOX_PULL_DIFF_MAX_BYTES);
      }
      if (result.tooLarge) throw new InboxPullsError("pull_diff_too_large", "This diff is too large to read here. Open it on the forge.");
      if (result.exitCode !== 0) {
        const error = refErrorOf(cli, result);
        if (error === "rate_limited") holdUntil.set(pull.host, now() + REF_RATE_LIMIT_MS);
        if (/too_large|maximum number of (lines|files)|diff is taking too long|\b406\b/i.test(`${result.stderr}\n${result.stdout}`)) {
          throw new InboxPullsError("pull_diff_too_large", "This diff is too large to read here. Open it on the forge.");
        }
        throw new InboxPullsError("pull_diff_failed", error === "signed_out" ? `${cli} is not signed in to ${pull.host}.` : `${cli} could not read this diff. Try again, or open it on the forge.`);
      }
      let patch = result.stdout;
      if (pull.platform === "gitlab" && scope === "stack") {
        try {
          const diffsOf = obj(JSON.parse(result.stdout)).diffs;
          patch = reconstructGitlabPatch((Array.isArray(diffsOf) ? diffsOf : []) as GitLabDiffEntry[]);
        } catch {
          throw new InboxPullsError("pull_diff_failed", "glab answered something other than a compare.");
        }
      }
      const headAfter = headBefore ? await headNow() : null;
      const head_sha = headBefore && headBefore === headAfter ? headBefore : null;
      if (scope === "layer") readHeads.set(key, head_sha);
      const answer: InboxPullDiffAnswer = { key, scope, base, head, patch, ...(scope === "layer" ? { head_sha } : {}) };
      diffs.set(cacheKey, { at: now(), answer });
      // Bounded: only the last few diffs are kept.
      while (diffs.size > 24) diffs.delete(diffs.keys().next().value!);
      return answer;
    },
    async fileContents(key, scope, path, roots, ids) {
      const none: InboxFileContents = { oldContent: null, newContent: null };
      // Nothing to check a text against (GitLab's whole-stack patches carry no index line): no arrows, and nothing runs.
      if (!ids) return none;
      const pull = known.get(key);
      if (!pull || !lastRepos.has(inboxPullRepoKey(pull.host, pull.repo))) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
      // A fork's commits live in the fork; the diff stays as it came.
      if (!!pull.head_repo && pull.head_repo.toLowerCase() !== pull.repo.toLowerCase()) return none;
      // The commit the patch on screen was read at, when the Inbox read one; a stack's is the list's. A layer whose head
      // moved during its read (readHeads holds null) has no commit to read at.
      const head = shaOf(scope === "layer" ? (readHeads.has(key) ? readHeads.get(key) : pull.head_sha) : pull.head_sha);
      if (!head) return none;
      const cli: RefCli = hosts.get(pull.host)?.cli ?? (pull.platform === "github" ? "gh" : "glab");
      const parts = splitPath(pull.repo)!;
      const project = encodeURIComponent(pull.repo);
      /** A forge read: the command's output, null when the forge says there is none, and a throw for anything passing. */
      const ask = async (endpoint: string, extra: string[] = []): Promise<string | null> => {
        if (now() < Math.max(holdUntil.get(pull.host) ?? 0, fileHoldUntil.get(pull.host) ?? 0)) throw new InboxPullsError("pull_diff_failed", "rate limited");
        const result = await diffRun(cli, ["api", "--hostname", pull.host, endpoint, ...extra], INBOX_PULL_FILE_MAX_BYTES);
        if (result.tooLarge) return null;
        if (result.exitCode === 0) return result.stdout;
        // Its own hold: scrolling a big PR must not refuse the next layer's diff.
        if (refErrorOf(cli, result) === "rate_limited") fileHoldUntil.set(pull.host, now() + REF_RATE_LIMIT_MS);
        else if (/\b404\b|not found/i.test(`${result.stderr}\n${result.stdout}`)) return null;
        throw new InboxPullsError("pull_diff_failed", `${cli} could not read this file.`);
      };
      /** The commit the diff runs from: where the head left its base branch, not the branch's tip. */
      const mergeBase = (): Promise<string | null> => {
        const bases =
          scope === "layer"
            ? [pull.base]
            : (() => {
                const stack = inboxPullStacks([...known.values()].filter((p) => p.host === pull.host && p.repo === pull.repo)).find((s) => s.layers.some((l) => l.key === key));
                return [...new Set([stack?.open_base ?? pull.base, stack?.base ?? pull.base])];
              })();
        // With the bases: a retarget keeps the head and moves where the diff runs from.
        const baseKey = `${key}\u0000${scope}\u0000${head}\u0000${bases.join("\u0000")}`;
        const hit = mergeBases.get(baseKey);
        if (hit) return hit;
        const read = (async () => {
          if (pull.platform === "gitlab" && scope === "layer") {
            const answer = await ask(`projects/${project}/merge_requests/${pull.number}`);
            return answer === null ? null : shaOf(obj(obj(JSON.parse(answer)).diff_refs).base_sha);
          }
          for (const base of bases) {
            const answer =
              pull.platform === "github"
                ? await ask(`repos/${parts.owner}/${parts.repo}/compare/${compareRef(base)}...${head}?per_page=1`, ["--jq", ".merge_base_commit.sha"])
                : await ask(`projects/${project}/repository/merge_base?refs%5B%5D=${encodeURIComponent(base)}&refs%5B%5D=${head}`);
            if (answer === null) continue;
            return pull.platform === "github" ? shaOf(answer.trim()) : shaOf(obj(JSON.parse(answer)).id);
          }
          return null;
        })();
        mergeBases.set(baseKey, read);
        read.catch(() => mergeBases.delete(baseKey));
        while (mergeBases.size > 64) mergeBases.delete(mergeBases.keys().next().value!);
        return read;
      };
      const textAt = (sha: string): Promise<string | null> => {
        const textKey = `${pull.host}/${pull.repo}\u0000${sha}\u0000${path}`;
        const hit = fileTexts.get(textKey);
        if (hit) {
          // Used again: the last to go.
          fileTexts.delete(textKey);
          fileTexts.set(textKey, hit);
          return hit.read;
        }
        const read = inTurn(async () => {
          for (const root of roots) {
            const local = await gitRead(root, sha, path, INBOX_PULL_FILE_MAX_BYTES).catch(() => null);
            if (local === "none") return null;
            if (local !== null) return local;
          }
          const endpoint =
            pull.platform === "github"
              ? `repos/${parts.owner}/${parts.repo}/contents/${compareRef(path)}?ref=${sha}`
              : `projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${sha}`;
          const text = await ask(endpoint, pull.platform === "github" ? ["-H", "Accept: application/vnd.github.v3.raw"] : []);
          return text === null || text.slice(0, 8000).includes("\u0000") ? null : text;
        });
        const entry = { read, bytes: 0 };
        fileTexts.set(textKey, entry);
        read.then(
          (text) => {
            // Still the one kept (the bound may have dropped it while it ran).
            if (fileTexts.get(textKey) !== entry) return;
            entry.bytes = text === null ? 0 : Buffer.byteLength(text, "utf8");
            fileTextBytes += entry.bytes;
            for (const [oldest, kept] of fileTexts) {
              if (fileTextBytes <= INBOX_PULL_FILE_CACHE_BYTES && fileTexts.size <= INBOX_PULL_FILE_CACHE_ENTRIES) break;
              if (oldest === textKey) continue;
              fileTexts.delete(oldest);
              fileTextBytes -= kept.bytes;
            }
          },
          () => {
            if (fileTexts.get(textKey) === entry) fileTexts.delete(textKey);
          },
        );
        return read;
      };
      try {
        const newContent = await textAt(head);
        if (newContent === null || !isBlob(newContent, ids.newId)) return none;
        const base = await mergeBase();
        if (!base) return none;
        const oldContent = await textAt(base);
        // The list can be behind the patch, and a merged PR's base can be its head: only the patch's own blobs open.
        return oldContent === null || !isBlob(oldContent, ids.oldId) ? none : { oldContent, newContent };
      } catch {
        // A forge that did not answer (rate limited, offline, signed out, not JSON): no arrows, and the next look asks again.
        return none;
      }
    },
  };
}

// --- linking a PR to its agent ---

/** The parts of the store linking reads. */
export interface InboxPullLinkStore {
  threadsOf(projectId: string): { thread_id: string; last_at: string }[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  threadSubject(threadId: string): string | null;
  /** The project a thread is in (canonical id), or null when there is no such thread. */
  threadProject(threadId: string): string | null;
  /** Whether an agent session polls now (the live sessions); absent: every agent is taken as live. */
  sessionLive?(session: string): boolean;
}

/**
 * An agent message's words as one line for the stack view: Markdown's own markers out (code fences, images, link
 * targets, headings, quotes, list bullets, emphasis and code ticks), the words and code inside them kept as written
 * (`settle_batch()` stays `settle_batch()`, "from `main`." stays "from main."), cut at 240 characters.
 */
export function previewOf(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(`+)([^`]+?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 240).replace(/\s+\S*$/, "")}…` : text;
}

/** What a thread says about the agent behind it. */
function threadFacts(store: InboxPullLinkStore, threadId: string) {
  const ids = store.threadMessageIds(threadId);
  let last: InboxMessage | null = null;
  let guide: InboxMessage | null = null;
  for (let i = ids.length - 1; i >= 0 && (!last || !guide); i--) {
    const message = store.message(ids[i]!);
    if (!message || message.author.kind !== "agent") continue;
    if (!last) last = message;
    if (!guide && message.guide) guide = message;
  }
  return { last, guide };
}

/**
 * Which agent thread each PR is tied to: the owner the person chose (Hand to
 * an agent, Launch an agent; `owners`, kept by inbox-pull-links.ts), else the
 * PR's link in an agent's own message in a project of the PR's repository (the
 * agent opened it; the latest such message). A link in another project's
 * thread ("depends on org/a#7") is not that project's PR. `projectsByRepo`:
 * every Inbox project whose origin is that repository (two clones are two
 * projects). Nothing else ties a PR to a thread: no branch guess, no Board card.
 */
export function linkInboxPulls(
  pulls: readonly InboxPull[],
  store: InboxPullLinkStore,
  projectsByRepo: ReadonlyMap<string, readonly string[]>,
  owners: ReadonlyMap<string, { thread_id: string; ask?: "guide" | "custom" }> = new Map(),
): Record<string, InboxPullLink> {
  const links: Record<string, InboxPullLink> = {};
  if (pulls.length === 0) return links;
  const wanted = new Set(pulls.map((p) => p.key));
  const projectsOf = (pull: InboxPull) => projectsByRepo.get(inboxPullRepoKey(pull.host, pull.repo)) ?? [];
  const byKey = new Map(pulls.map((p) => [p.key, p]));
  const keyOfUrl = (url: string) => {
    const ref = parseForgeRefUrl(url);
    return ref && ref.kind === "pull" ? forgeRefKey(ref) : null;
  };

  // The PR links in agents' own messages, per project of the PR's repository.
  const urlThread = new Map<string, { thread: string; project: string; at: string }>();
  for (const projectId of new Set([...projectsByRepo.values()].flat())) {
    for (const summary of store.threadsOf(projectId)) {
      for (const id of store.threadMessageIds(summary.thread_id)) {
        const message = store.message(id);
        if (!message || message.author.kind !== "agent") continue;
        for (const url of inboxPullUrlsIn(message.body)) {
          const key = keyOfUrl(url);
          if (!key || !wanted.has(key)) continue;
          if (!projectsOf(byKey.get(key)!).includes(projectId)) continue;
          const seen = urlThread.get(key);
          if (!seen || seen.at <= message.created_at) urlThread.set(key, { thread: summary.thread_id, project: projectId, at: message.created_at });
        }
      }
    }
  }

  const linkOf = (via: InboxPullLink["via"], threadId: string, projectId: string): InboxPullLink => {
    const { last, guide } = threadFacts(store, threadId);
    const root = store.message(threadId)?.to ?? null;
    // A thread the person just handed over: its agent has not written yet, so it is the session the first message went to.
    const to = last ? null : root;
    // Ended: a session that sent with a wake polls while it runs, so one not polling now has ended; the session a
    // hand-off went to was live then. An agent that only reads the Inbox (no wake) is never called ended.
    const ended = (session: string | null, wakes: boolean): boolean => !!store.sessionLive && !!session && wakes && !store.sessionLive(session);
    return {
      via,
      ...(via === "owner" && root?.session ? { handed_to: root.session } : {}),
      thread_id: threadId,
      thread_subject: store.threadSubject(threadId),
      project_id: projectId,
      agent:
        last && last.author.kind === "agent"
          ? { host: last.author.host, session: last.author.session, name: last.author.name, ...(ended(last.author.session, last.wakes === true) ? { ended: true } : {}) }
          : to
            ? { host: to.host, session: to.session, name: null, ...(ended(to.session, true) ? { ended: true } : {}) }
            : null,
      last: last ? { message_id: last.id, preview: previewOf(last.body), at: last.created_at } : null,
      guide: guide?.guide ? { message_id: guide.id, title: guide.guide.title, steps: guide.guide.sections, review: guide.guide.review === true } : null,
    };
  };

  for (const pull of pulls) {
    const owner = owners.get(pull.key);
    const ownerProject = owner ? store.threadProject(owner.thread_id) : null;
    if (owner && ownerProject) {
      links[pull.key] = { ...linkOf("owner", owner.thread_id, ownerProject), ...(owner.ask ? { ask: owner.ask } : {}) };
      continue;
    }
    const url = urlThread.get(pull.key);
    if (url) links[pull.key] = linkOf("url", url.thread, url.project);
  }
  return links;
}

/** The Board cards that link the PRs (a card's `pr` or `ref`), by pull key: read only while the Board is on. */
export function pullCards(pulls: readonly InboxPull[], cards: readonly InboxCard[]): Record<string, InboxPullCard> {
  const wanted = new Set(pulls.map((p) => p.key));
  const out: Record<string, InboxPullCard> = {};
  for (const card of cards) {
    for (const ref of inboxCardRefsOf(card)) {
      if (ref.kind !== "pr") continue;
      const parsed = parseForgeRefUrl(ref.url);
      const key = parsed && parsed.kind === "pull" ? forgeRefKey(parsed) : null;
      if (key && wanted.has(key) && !out[key]) out[key] = { id: card.id, title: card.title, column: card.column };
    }
  }
  return out;
}
