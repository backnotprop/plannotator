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
 * - GraphQL `query`s only (refused to load otherwise). The person's own lists,
 *   one query per host: the PRs whose review was requested from the person,
 *   the ones assigned to them, the ones they opened, the ones they merged in
 *   the last `INBOX_PULLS_MERGED_DAYS` (to put a stack's merged layers under
 *   it). Others, a separate optional read that never fails them: every open PR
 *   of the projects' repositories, the most active first, at most
 *   `INBOX_PULLS_OTHERS_CALLS_MAX` searches (GitHub, one request) or queries
 *   (GitLab), within `INBOX_PULLS_OTHERS_DEADLINE_MS`, every
 *   `INBOX_PULLS_OTHERS_FRESH_MS` unless the Others view is open; never an
 *   unscoped search. Only PRs of the projects' repositories are kept. An
 *   answer with any GraphQL error is a failed read.
 * - Cache per host: fresh for `INBOX_PULLS_FRESH_MS`; a `refresh` (the window
 *   got its focus back, or the person asked) reads again what is older than
 *   `INBOX_PULLS_REFRESH_MS`; a failure is held `REF_FAILURE_MS` and the last
 *   answer stays on screen; a rate-limit answer holds the host for
 *   `REF_RATE_LIMIT_MS`; GitHub's GraphQL budget under
 *   `INBOX_PULLS_RATE_FLOOR` holds list reads (not diffs) until it fills. One
 *   read per host at a time, and one read for both of the person's own lists
 *   (Reviews' scoped one and the Pull requests board's everywhere one).
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
  type InboxPullDetailsAnswer,
  type InboxPullDiffAnswer,
  type InboxPullDiffScope,
  type InboxPullHost,
  inboxPullLabel,
  inboxPullSafeBranch,
  type InboxPullCard,
  type InboxPullLink,
  type InboxPullReview,
  type InboxPullState,
} from "@plannotator/core/inbox-types";
import { parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { fetchPRContextWithReviewers, fetchPRFileBytes, fetchPRFileContent, fetchPRTree, ghEntryMissingContent, glEntryMissingContent, parsePaginatedArray, reconstructGhPatch, reconstructGitlabPatch, type GitHubFileEntry, type GitLabDiffEntry } from "@plannotator/shared/pr-provider";
import type { PRContext, PRRef, PRRuntime } from "@plannotator/shared/pr-types";
import { pullDetailsOf, type PullDetailsRead } from "./inbox-pull-details";
import { MAX_REPO_FILE_BYTES } from "@plannotator/shared/repo-file";
import { compareRepoPaths, MAX_REVIEW_FILE_CONTENT_BYTES, prepareGitCommand, readGitObjectBytes, validateFilePath, type RepoFileListing } from "@plannotator/shared/review-core";
import { handleRepoFileRequest, handleRepoFilesRequest, type HandlerResult, type RepoFileRead } from "@plannotator/shared/repo-files";
import { readRepoWorkingTreeFile } from "@plannotator/shared/repo-files-node";
import { childEnv } from "@plannotator/shared/child-env";
import { killGitTree, runtime as gitRuntime, trackIsolatedGitGroup } from "./git";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, refRunnerKill, type RefCli, type RefCommandResult, type RefRunner } from "./ref-cards";

/** A host's answer is fresh this long. */
export const INBOX_PULLS_FRESH_MS = 60_000;
/** A refresh reads again what is older than this. */
export const INBOX_PULLS_REFRESH_MS = 20_000;
/** How long a PR merged from this Inbox shows merged whatever the forge's reads still say (`markMerged`). */
export const INBOX_PULLS_MERGED_HOLD_MS = 10 * 60_000;
/** GitHub's GraphQL budget below this many points: the host is not read again until it fills (`rateLimit.resetAt`). */
export const INBOX_PULLS_RATE_FLOOR = 100;
/** A patch larger than this is refused (the review says to open it on the forge). */
export const INBOX_PULL_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** A PR's details are kept this long (keyed by the PR's last update too): opening the page again does not ask again. */
const INBOX_PULL_DETAILS_FRESH_MS = 60_000;
/** How long the people a read named stay allowed for their pictures: as long as a page is likely to stay open. */
const INBOX_PULL_DETAILS_KEEP_MS = 60 * 60_000;
/** A layer's diff is kept this long (keyed by the PR's last update too). */
export const INBOX_PULL_DIFF_FRESH_MS = 5 * 60_000;

/** The longest description kept: over GitHub's own limit, so only a GitLab description past it is cut. */
export const INBOX_PULL_DESCRIPTION_MAX_CHARS = 66_000;

/**
 * The body as a reader of it on the forge sees it: no HTML comments (an unfilled PR template is mostly these, and one
 * with a blank line in it would otherwise draw as text), outside code. A comment that starts a line and never closes
 * runs to the end, as it does on the forge; one that starts mid-line and never closes is plain text.
 */
function withoutHtmlComments(text: string): string {
  const lines = text.split("\n");
  const lastClose = lines.reduce((last, line, index) => (line.includes("-->") ? index : last), -1);
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  lines.forEach((whole, index) => {
    let line = whole;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) return;
      line = line.slice(end + 3);
      inComment = false;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) fence = null;
      out.push(line);
      return;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      return;
    }
    if (/^(?: {4}|\t)/.test(line) && !out[out.length - 1]?.trim()) {
      out.push(line);
      return;
    }
    let kept = "";
    let at = 0;
    while (at < line.length) {
      if (line[at] === "`") {
        let run = at;
        while (line[run] === "`") run++;
        const tick = line.slice(at, run);
        const close = line.indexOf(tick, run);
        const end = close < 0 ? run : close + tick.length;
        kept += line.slice(at, end);
        at = end;
      } else if (line.startsWith("<!--", at)) {
        // From the opening's own dashes: `<!-->` and `<!--->` are whole comments.
        const close = line.indexOf("-->", at + 2);
        if (close >= 0) {
          at = close + 3;
        } else if (!kept.trim() || index < lastClose) {
          inComment = true;
          at = line.length;
        } else {
          kept += line.slice(at);
          at = line.length;
        }
      } else {
        kept += line[at];
        at++;
      }
    }
    out.push(kept.trim() ? kept : "");
  });
  return out.join("\n");
}

/** A PR's description as the forge answered it, or null when it has none: no words left is none, a lone rule too. */
function descriptionOf(value: unknown): string | null {
  const text = typeof value === "string" ? withoutHtmlComments(value).trim() : "";
  if (text.split("\n").every((line) => !line.trim() || /^ {0,3}([-*_])(?: *\1){2,} *$/.test(line))) return null;
  return text.length > INBOX_PULL_DESCRIPTION_MAX_CHARS ? `${text.slice(0, INBOX_PULL_DESCRIPTION_MAX_CHARS)}\n\n…` : text;
}

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
      reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Team { slug } } } }
      latestReviews(first: 5) { nodes { state author { login avatarUrl } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** One query per GitHub host: the viewer, the rate limit, and the person's own searches (the open ones with their full count). */
export const GITHUB_PULLS_QUERY = `query InboxPulls($requested: String!, $authored: String!, $merged: String!, $assigned: String!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  requested: search(type: ISSUE, query: $requested, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  authored: search(type: ISSUE, query: $authored, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  assigned: search(type: ISSUE, query: $assigned, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  merged: search(type: ISSUE, query: $merged, first: 30) { nodes { ... on PullRequest { ${GH_PULL} } } }
}`;

/**
 * Reviews' list and the Pull requests board in one call (the person's own lists, scoped to the projects' repositories,
 * and the same searches everywhere, `every…`): opening Reviews, which shows the board, is one read per host.
 */
export const GITHUB_PULLS_BOTH_QUERY = `query InboxPulls($requested: String!, $authored: String!, $merged: String!, $assigned: String!, $everyRequested: String!, $everyAuthored: String!, $everyMerged: String!, $everyAssigned: String!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  requested: search(type: ISSUE, query: $requested, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  authored: search(type: ISSUE, query: $authored, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  assigned: search(type: ISSUE, query: $assigned, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  merged: search(type: ISSUE, query: $merged, first: 30) { nodes { ... on PullRequest { ${GH_PULL} } } }
  everyRequested: search(type: ISSUE, query: $everyRequested, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  everyAuthored: search(type: ISSUE, query: $everyAuthored, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  everyAssigned: search(type: ISSUE, query: $everyAssigned, first: ${INBOX_PULLS_SEARCH_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }
  everyMerged: search(type: ISSUE, query: $everyMerged, first: 30) { nodes { ... on PullRequest { ${GH_PULL} } } }
}`;

// --- Others: every open PR of the projects' repositories, a separate, optional, bounded read ---

/** An Others search answers this many PRs at most. */
export const INBOX_PULLS_OTHERS_MAX = 100;
/** At most this many Others searches (GitHub) or queries (GitLab) per host per read: the most active repositories first. */
export const INBOX_PULLS_OTHERS_CALLS_MAX = 3;
/** Others is read again this often at most, unless the person has the Others view open (then as the list is). */
export const INBOX_PULLS_OTHERS_FRESH_MS = 5 * 60_000;
/** The whole Others read of one host gives up after this long (its last answer stays). */
export const INBOX_PULLS_OTHERS_DEADLINE_MS = 12_000;

/**
 * The Others query for one GitHub host: the viewer (whose PRs are the person's own), the rate limit, and `n` searches
 * (`others0`, …), each a share of the projects' repositories.
 */
export function githubOthersQuery(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$others${i}: String!`).join(", ");
  const searches = Array.from(
    { length: n },
    (_, i) => `\n  others${i}: search(type: ISSUE, query: $others${i}, first: ${INBOX_PULLS_OTHERS_MAX}) { issueCount nodes { ... on PullRequest { ${GH_PULL} } } }`,
  ).join("");
  return `query InboxPullsOthers(${vars}) {
  viewer { login }
  rateLimit { cost remaining resetAt }${searches}
}`;
}

const GL_MR = `iid title webUrl state draft updatedAt mergedAt sourceBranch targetBranch diffHeadSha approved detailedMergeStatus conflicts
      diffStatsSummary { additions deletions fileCount } headPipeline { status }
      project { fullPath repository { rootRef } } sourceProject { fullPath } author { username avatarUrl }
      approvedBy(first: 3) { nodes { username avatarUrl } } reviewers(first: 5) { nodes { username avatarUrl } }`;

/** A GitLab query asks this many projects' open MRs at most: GitLab refuses a query past its complexity limit (250). */
export const GITLAB_PROJECTS_PER_QUERY = 4;

/** A project's full path as a GraphQL string (only the characters a GitLab path may hold; anything else is dropped). */
function gqlPath(path: string): string {
  return JSON.stringify(path.replace(/[^A-Za-z0-9._/-]/g, ""));
}

/** One query per GitLab host: the current user's requested, opened, assigned and merged MRs. */
export const GITLAB_PULLS_QUERY = `query InboxPulls {
  currentUser {
    username
    requested: reviewRequestedMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { count nodes { ${GL_MR} } }
    authored: authoredMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { count nodes { ${GL_MR} } }
    assigned: assignedMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { count nodes { ${GL_MR} } }
    merged: authoredMergeRequests(state: merged, first: 20, sort: MERGED_AT_DESC) { nodes { ${GL_MR} } }
  }
}`;

/**
 * The Others queries for one GitLab host: the projects (full paths, the most active first) `GITLAB_PROJECTS_PER_QUERY`
 * to a query, at most `INBOX_PULLS_OTHERS_CALLS_MAX` queries; each asks the user's name and its projects' open MRs
 * (`p0`, `p1`, … numbered across them, so the answers merge into one). `covered`: the projects asked.
 */
export function gitlabOthersQueries(projects: readonly string[]): { queries: string[]; covered: string[] } {
  const paths = [...new Set(projects.map((p) => p.toLowerCase()))];
  const covered = paths.slice(0, GITLAB_PROJECTS_PER_QUERY * INBOX_PULLS_OTHERS_CALLS_MAX);
  const alias = (path: string, i: number) => `\n  p${i}: project(fullPath: ${gqlPath(path)}) { mergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}, sort: UPDATED_DESC) { count nodes { ${GL_MR} } } }`;
  const queries: string[] = [];
  for (let at = 0; at < covered.length; at += GITLAB_PROJECTS_PER_QUERY) {
    const chunk = covered.slice(at, at + GITLAB_PROJECTS_PER_QUERY).map((p, i) => alias(p, at + i)).join("");
    queries.push(`query InboxPullsOthers {\n  currentUser { username }${chunk}\n}`);
  }
  return { queries, covered };
}

for (const q of [GITHUB_PULLS_QUERY, GITHUB_PULLS_BOTH_QUERY, GITLAB_PULLS_QUERY, githubOthersQuery(2), ...gitlabOthersQueries(["a/b"]).queries]) {
  if (!/^query\b/.test(q)) throw new Error("inbox-pulls: every query must be a query");
}

/**
 * The repositories, the most recently active first (the latest update of any PR the Inbox has read of each), then
 * those it knows nothing of, by name: the Others read spends its few searches on where work is happening.
 */
export function byActivity(repos: readonly string[], pulls: readonly Pick<InboxPull, "repo" | "updated_at">[]): string[] {
  const latest = new Map<string, string>();
  for (const p of pulls) {
    const key = p.repo.toLowerCase();
    if ((latest.get(key) ?? "") < p.updated_at) latest.set(key, p.updated_at);
  }
  return [...new Set(repos.map((r) => r.toLowerCase()))].sort((a, b) => {
    const at = latest.get(a) ?? "";
    const bt = latest.get(b) ?? "";
    return at !== bt ? (at < bt ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** GitHub's search refuses a query past this many characters. */
export const GITHUB_SEARCH_MAX_CHARS = 256;

/** The person's own GitHub searches, by alias. */
export interface GithubPersonalSearches {
  requested: string;
  authored: string;
  assigned: string;
  merged: string;
}

/**
 * The person's own GitHub searches (the merged one goes back `INBOX_PULLS_MERGED_DAYS` from `now`), newest first. With
 * the projects' repositories (`owner/repo`) they are scoped to them (`repo:` qualifiers, as many as fit GitHub's
 * length limit in the longest search), so the 50-a-search cap is spent on the projects' PRs; past that the search
 * covers everything and the list keeps the projects' PRs.
 */
export function githubPullSearches(now: number, repos: readonly string[] = []): GithubPersonalSearches {
  const since = new Date(now - INBOX_PULLS_MERGED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const bare: GithubPersonalSearches = {
    requested: "is:pr is:open archived:false review-requested:@me sort:updated-desc",
    authored: "is:pr is:open archived:false author:@me sort:updated-desc",
    assigned: "is:pr is:open archived:false assignee:@me sort:updated-desc",
    merged: `is:pr is:merged author:@me merged:>=${since} sort:updated-desc`,
  };
  const scope = [...new Set(repos.map((r) => r.toLowerCase()))].sort().map((r) => `repo:${r}`).join(" ");
  const longest = Math.max(...Object.values(bare).map((q) => q.length));
  if (!scope || longest + 1 + scope.length > GITHUB_SEARCH_MAX_CHARS) return bare;
  return {
    requested: `${bare.requested} ${scope}`,
    authored: `${bare.authored} ${scope}`,
    assigned: `${bare.assigned} ${scope}`,
    merged: `${bare.merged} ${scope}`,
  };
}

/**
 * The Others searches for one GitHub host: every open PR of the repositories (`owner/repo`, the most active first),
 * packed into at most `INBOX_PULLS_OTHERS_CALLS_MAX` searches under GitHub's length limit. Never unscoped (that would
 * search all of GitHub): no repositories, no search. `covered`: the repositories searched; the rest are not read.
 */
export function githubOthersSearches(repos: readonly string[]): { searches: string[]; covered: string[] } {
  const bare = "is:pr is:open archived:false sort:updated-desc";
  const searches: string[] = [];
  const covered: string[] = [];
  for (const repo of [...new Set(repos.map((r) => r.toLowerCase()))]) {
    const q = `repo:${repo}`;
    const fits = searches.findIndex((s) => s.length + 1 + q.length <= GITHUB_SEARCH_MAX_CHARS);
    if (fits >= 0) searches[fits] = `${searches[fits]} ${q}`;
    else if (searches.length < INBOX_PULLS_OTHERS_CALLS_MAX && bare.length + 1 + q.length <= GITHUB_SEARCH_MAX_CHARS) searches.push(`${bare} ${q}`);
    else continue;
    covered.push(repo);
  }
  return { searches, covered };
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
  /** The person's open searches (requested, authored, assigned) found more than they answered: how many came back, of how many. */
  capped?: { shown: number; total: number };
  /**
   * An Others answer (`part: "others"`): every open PR of the repositories it searched, as it counted them (GitHub
   * `issueCount`, GitLab `count`).
   */
  open_total?: number;
  /** GitHub's GraphQL budget after this read: what is left, and when it fills again (ISO). */
  rate?: { remaining: number; reset_at: string };
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

/** The Others reads' total count (GitHub `issueCount`, GitLab `count`). */
function totalOf(lists: unknown[], countKey: "issueCount" | "count"): number {
  return lists.reduce<number>((sum, list) => sum + Math.max(num(obj(list)[countKey]), nodes(list).length), 0);
}

/** Which lists an answer is read for: the person's own (requested, authored, assigned, merged), or Others. */
/** `every`: the everywhere half of `GITHUB_PULLS_BOTH_QUERY`'s answer (its `every…` searches). */
export type PullsPart = "own" | "others" | "every";

/** A GraphQL answer that reports any error is a failed read: a part left out would read as "nothing there". */
function hasErrors(parsed: unknown): boolean {
  const errors = obj(parsed).errors;
  return Array.isArray(errors) && errors.length > 0;
}

/** A GitHub answer (the person's own lists, or Others) as the viewer's login and PRs; null when it is not one. */
export function parseGithubPulls(stdout: string, host: string, part: PullsPart = "own"): ParsedPulls | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (hasErrors(parsed)) return null;
  const data = obj(obj(parsed).data);
  if (!data.viewer && !data.authored && !data.requested) return null;
  const login = str(obj(data.viewer).login) || null;
  const out = new Map<string, InboxPull>();
  const avatars: Record<string, string> = {};
  const read = (list: unknown, flag: "requested" | "assigned" | null) => {
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
      // The reviewers' and approvers' pictures too: their names show with a face (the owner, q-331c0466). A team has none.
      for (const who of [...nodes(item.reviewRequests).map((n) => obj(n.requestedReviewer)), ...nodes(item.latestReviews).map((n) => obj(n.author))]) {
        const name = str(who.login);
        const url = name ? avatarOf(who.avatarUrl, host) : "";
        if (name && url) avatars[name] ??= url;
      }
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
        requested: flag === "requested" || earlier?.requested === true,
        ...(flag === "assigned" || earlier?.assigned === true ? { assigned: true } : {}),
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
  const rate = obj(data.rateLimit);
  const reset = str(rate.resetAt);
  const budget = typeof rate.remaining === "number" && reset ? { rate: { remaining: rate.remaining, reset_at: reset } } : {};
  if (part === "others") {
    const others = Object.keys(data)
      .filter((k) => /^others\d+$/.test(k))
      .map((k) => data[k]);
    for (const list of others) read(list, null);
    return { login, pulls: [...out.values()], avatars, open_total: totalOf(others, "issueCount"), ...budget };
  }
  const list = (name: "authored" | "merged" | "assigned" | "requested") => (part === "every" ? data[`every${name[0]!.toUpperCase()}${name.slice(1)}`] : data[name]);
  read(list("authored"), null);
  read(list("merged"), null);
  read(list("assigned"), "assigned");
  read(list("requested"), "requested");
  const capped = cappedOf([list("requested"), list("authored"), list("assigned")], "issueCount");
  return { login, pulls: [...out.values()], avatars, ...(capped ? { capped } : {}), ...budget };
}

const GL_FAIL = new Set(["FAILED", "CANCELED"]);
const GL_QUIET = new Set(["SKIPPED", "MANUAL"]);

/**
 * A GitLab answer (the person's own lists, or the answers of one host's Others queries, `gitlabOthersQueries`) as the
 * current user's name and MRs; null when it is not one, or when any of them is not.
 */
export function parseGitlabPulls(stdout: string | readonly string[], host: string, part: PullsPart = "own"): ParsedPulls | null {
  const data: Json = {};
  for (const one of typeof stdout === "string" ? [stdout] : stdout) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(one);
    } catch {
      return null;
    }
    if (hasErrors(parsed) || !obj(parsed).data) return null;
    Object.assign(data, obj(obj(parsed).data));
  }
  const user = obj(data.currentUser);
  if (!user.username) return null;
  const login = str(user.username) || null;
  const out = new Map<string, InboxPull>();
  const avatars: Record<string, string> = {};
  const read = (list: unknown, flag: "requested" | "assigned" | null) => {
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
      for (const who of [...nodes(item.approvedBy), ...nodes(item.reviewers)]) {
        const name = str(who.username);
        const url = name ? avatarOf(who.avatarUrl, host) : "";
        if (name && url) avatars[name] ??= url;
      }
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
        requested: flag === "requested" || earlier?.requested === true,
        ...(flag === "assigned" || earlier?.assigned === true ? { assigned: true } : {}),
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
  if (part === "others") {
    const projects = Object.keys(data)
      .filter((k) => /^p\d+$/.test(k))
      .map((k) => obj(data[k]).mergeRequests);
    for (const list of projects) read(list, null);
    return { login, pulls: [...out.values()], avatars, open_total: totalOf(projects, "count") };
  }
  read(user.authored, null);
  read(user.merged, null);
  read(user.assigned, "assigned");
  read(user.requested, "requested");
  const capped = cappedOf([user.requested, user.authored, user.assigned], "count");
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

/** A host's last good Others answer: every open PR of the repositories it searched. */
interface OthersAnswer {
  at: number;
  pulls: InboxPull[];
  avatars: Record<string, string>;
  /** How many open PRs the searched repositories have; null when not every repository was searched (capped). */
  total: number | null;
  /** The projects' repositories when it was read (as `HostAnswer.repos`). */
  repos: string;
}

/** The Others read of a host: separate from the person's own lists, which never fail with it. */
interface OthersState {
  answer: OthersAnswer | null;
  failedAt: number;
  error: InboxPullHost["error"] | null;
  pending: Promise<void> | null;
}

/** One read of the person's own lists: scoped to the projects' repositories (the Reviews page), or everywhere. */
interface OwnState {
  answer: HostAnswer | null;
  failedAt: number;
  error: InboxPullHost["error"] | null;
  pending: Promise<void> | null;
}

interface HostState extends OwnState {
  cli: RefCli;
  others: OthersState;
  /**
   * The person's own lists read everywhere (the Pull requests board, `everywhere`): the same searches with no `repo:`
   * qualifier, answered apart from the scoped list but by the same read (`read` fills both; its `pending` is shared).
   */
  wide: OwnState;
}

export class InboxPullsError extends Error {
  constructor(
    readonly code: "pull_unknown" | "pull_details_failed" | "pull_details_held" | "pull_diff_failed" | "pull_diff_too_large" | "pull_diff_fork" | "validation_error",
    message: string,
    /** For `pull_details_held`: when the forge may be asked again (ms since the epoch). */
    readonly retryAt?: number,
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
    /**
     * `others`: the person has the Others view open, so Others is read as often as the list (else every 5 min at most).
     * `everywhere`: the Pull requests page: the person's own lists in any repository on any host a CLI here is signed in
     * to (requested of them, theirs, assigned to them), plus every open PR of the projects' repositories as always.
     */
    options?: { refresh?: boolean; others?: boolean; everywhere?: boolean },
  ): Promise<{ fetched_at: string | null; hosts: InboxPullHost[]; pulls: InboxPull[]; clis: Partial<Record<RefCli, InboxPullCliState>>; unsigned: string[] }>;
  /** A PR the last list named, by key. */
  find(key: string): InboxPull | null;
  /**
   * This Inbox merged the PR (the Pull requests page's Merge): every list from now on shows it merged, even a cached
   * answer read before the merge or a forge read that still says open (GitHub's search lags), for
   * `INBOX_PULLS_MERGED_HOLD_MS` or until a read says it is no longer open.
   */
  markMerged(key: string): void;
  /** Whether this CLI says it's signed in to the host: nothing is asked of a host it isn't. */
  signedInTo(cli: RefCli, host: string): Promise<boolean>;
  /**
   * Waits for the Others reads in flight, each within its own deadline (at once when none is), so a caller that
   * needs a key Others may hold (an Inbox just restarted) can list again after. Never throws.
   */
  othersSettled(): Promise<void>;
  /** The profile pictures' URLs of the authors of the PRs the last list showed on this host, by login. */
  avatarUrls(host: string): Record<string, string>;
  /** One layer's patch, or the stack's from its base up to that layer. Throws InboxPullsError. */
  diff(key: string, scope: InboxPullDiffScope): Promise<InboxPullDiffAnswer>;
  /** What the forge has beside the diff: reviewers, checks, labels, comments. Only for a PR the last list named. */
  details(key: string): Promise<InboxPullDetailsAnswer>;
  /**
   * The PR's own text as the details read answered it (description, comments, reviews, threads), the PR, and the
   * person's CLI for its host: what the PR media route checks a URL against and fetches with. Reads the details when
   * none is kept. Throws InboxPullsError as `details` does.
   */
  text(key: string): Promise<{ pull: InboxPull; context: PRContext; runtime: PRRuntime }>;
  /**
   * One layer's diff for an agent to read: no limit of ours on its size, and when the forge won't serve it as one
   * document, whatever its per-file read gives; `partial` when that is known to be less than the whole diff.
   * When that read is partial or empty and `roots` holds a clone of the PR's repository on this computer, git reads
   * the whole diff there instead (`localWholeDiff`), and it is not partial; `held_back` is then the forge's own read
   * (its held-back files as their headers), for an agent the whole is too long for.
   * `per_file` when the forge would not serve the diff as one document (the per-file read or a clone gave it): the
   * PR's diff on screen (`diff`) reads only that document, so it shows none of this.
   * `head_sha` as `diff`'s. Throws InboxPullsError when there is nothing.
   */
  wholeDiff(key: string, signal?: AbortSignal, roots?: readonly string[]): Promise<{ patch: string; head_sha: string | null; partial: boolean; held_back?: string; per_file?: true }>;
  /** The head commit of the last patch read for this PR, either scope (`diff`'s `head_sha`), or null. */
  readHead(key: string): string | null;
  /**
   * A file as this PR has it at its head commit, read from the forge with the person's own CLI, so it needs no checkout.
   * Null when the PR is not in the last list, has no known head, or has no such text file there. Never throws.
   */
  file(key: string, path: string, repos?: InboxPullRepo[]): Promise<InboxPullFile | null>;
  /** Whether a GitHub PR still has this commit (a force-push takes it off); null when the forge did not say. */
  hasCommit(key: string, sha: string): Promise<boolean | null>;
  /**
   * The rail's All files: every file of the PR's repository at a head commit this Inbox read for it (`snapshot`, the
   * head the patch on screen was read at, or the list's), as the review app's `GET /api/repo-files` answers
   * (`RepoFilesResponse`), from the forge's tree API. Any other commit is refused as stale (409).
   */
  repoFiles(key: string, params: URLSearchParams): Promise<HandlerResult>;
  /** One file of that listing as text, as the review app's `GET /api/repo-file` answers (`RepoFileResponse`). */
  repoFile(key: string, params: URLSearchParams): Promise<HandlerResult>;
  /**
   * One file's whole text at the commits this PR's diff runs between, for the viewer's expand arrows: read from the
   * first of `roots` (local clones of the repository) that has the commit, else from the forge, a fork's commits too:
   * they are reachable by id from the base repository. `oldPath`: a renamed file's old side. Both sides null when either
   * is missing, binary or too large, with `failed` when the forge did not answer. Throws InboxPullsError only for a PR
   * the last list did not name.
   */
  /** `ids` are the blobs the patch on screen names: a text that does not hash to them is not that patch's file, and no arrows open. */
  fileContents(key: string, scope: InboxPullDiffScope, path: string, roots: readonly string[], ids: PatchBlobIds | null, oldPath?: string): Promise<InboxFileContents>;
}

/** The most listings All files keeps (one per PR and head). */
const REPO_LISTINGS_KEPT = 8;

/** A file at a PR's head commit: its text, and its address on the forge. */
export interface InboxPullFile {
  contents: string;
  label: string;
  platform: InboxPull["platform"];
  url: string;
}

/** The files read at a head commit, kept while the Inbox runs: a commit never changes, so nor do they. */
const INBOX_PULL_FILES_KEPT = 64;
/** A file's read stops here: the local limit, as the base64 GitHub answers with. */
const INBOX_PULL_FILE_READ_BYTES = Math.ceil((MAX_REPO_FILE_BYTES * 4) / 3) + 1024 * 1024;

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
/** The most commits GitHub lists for a pull request. */
const PULL_COMMITS_LISTED_MAX = 250;
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
export type PullDiffRunner = (cli: RefCli, args: string[], maxBytes: number, reading?: { timeoutMs: number; signal?: AbortSignal }) => Promise<RefCommandResult & { tooLarge?: boolean }>;

/**
 * A git command in a clone on this computer, for an agent's diff read. Ends at `timeoutMs` and at `signal`, and, with
 * `maxBytes`, once its output passes that (`tooLarge`, its output dropped).
 */
export type PullGitRunner = (root: string, args: string[], reading: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number }) => Promise<RefCommandResult & { tooLarge?: boolean }>;

/**
 * The most a clone's git diff is read to, well past any model's context (about 4 MB of prompt): past it the read
 * stops, and the forge's own read stands, rather than an agent run that is sure to fail.
 */
export const INBOX_PULL_GIT_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Whether a network git call to this remote URL (`git remote get-url`, so `insteadOf` already applied) may go through
 * ssh, or a transport we don't know: an SSH agent can ask for approval there (1Password, a Touch ID key), and
 * `BatchMode` doesn't stop it. Only https, http, git, file and a local path are quiet.
 */
export function pullRemoteMayPrompt(url: string): boolean {
  const remote = url.trim();
  if (!remote) return true;
  if (/^(https?|git|file):\/\//i.test(remote)) return false;
  // Any other URL scheme (ssh://, git+ssh://) or a remote helper (ext::, <helper>::<address>).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || /^[a-z][a-z0-9+.-]*::/i.test(remote)) return true;
  // A local path: absolute, relative, or a Windows drive or share.
  if (remote.startsWith("/") || remote.startsWith(".") || /^[a-z]:[\\/]/i.test(remote) || remote.startsWith("\\\\")) return false;
  // scp-like `[user@]host:path` (a colon before any slash) is ssh; anything else is a local path.
  const colon = remote.indexOf(":");
  const slash = remote.indexOf("/");
  return colon > 0 && (slash < 0 || colon < slash);
}

/**
 * git with no way to ask anything (no credential or SSH prompt: `prepareGitCommand`'s "forbid"), and no automatic gc
 * or maintenance started by a fetch. It runs in its own process group, as git.ts's `runGit` does, so the timeout and
 * `signal` stop what it started too (ssh, git-remote-https), and no window opens on Windows. `environment`: tests
 * give git a scratch HOME.
 */
export function createPullGitRunner(environment: () => Readonly<Record<string, string | undefined>> = () => childEnv()): PullGitRunner {
  return async (root, args, reading) => {
    if (reading.signal?.aborted) return { stdout: "", stderr: "git: stopped", exitCode: 130 };
    const prepared = prepareGitCommand(args, { interaction: "forbid", timeoutMs: reading.timeoutMs, config: { "maintenance.auto": "false", "gc.auto": "0" } }, environment());
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["git", ...prepared.args], {
        cwd: root,
        detached: prepared.isolateProcessGroup,
        env: { ...environment(), ...prepared.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
    } catch {
      return { stdout: "", stderr: "git: could not start", exitCode: 127 };
    }
    const untrack = prepared.isolateProcessGroup ? trackIsolatedGitGroup(proc.pid) : undefined;
    const stop = () => killGitTree(proc, prepared.isolateProcessGroup);
    const timer = setTimeout(stop, reading.timeoutMs);
    reading.signal?.addEventListener("abort", stop, { once: true });
    const readOut = async (): Promise<string | null> => {
      if (reading.maxBytes === undefined) return new Response(proc.stdout as ReadableStream).text();
      // Counted as it comes: past the cap, git is stopped and nothing more is held.
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks).toString("utf8");
        bytes += value.byteLength;
        if (bytes > reading.maxBytes) {
          stop();
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    };
    try {
      const [stdout, stderr, exitCode] = await Promise.all([readOut(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
      if (stdout === null) return { stdout: "", stderr, exitCode: exitCode || 1, tooLarge: true };
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
      reading.signal?.removeEventListener("abort", stop);
      untrack?.();
    }
  };
}

/** A diff can take longer than a card's query. */
export const INBOX_PULL_DIFF_TIMEOUT_MS = 30_000;
/** An agent's read of a whole diff has the time the agent has. */
export const INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS = 5 * 60_000;
/** GitHub's files API stops listing here, whatever the PR holds. */
const GITHUB_FILES_API_STOP = 3000;
/**
 * For a judgment, where wrongly calling a read complete costs more: older GitLab sends neither flag, so an empty added
 * or deleted file may be one it held back. A review shows such a file as it is, so its own check doesn't count it.
 */
const glMayBeHeldBack = (d: GitLabDiffEntry): boolean =>
  glEntryMissingContent(d) || (d.diff.trim() === "" && d.too_large == null && d.collapsed == null && (d.new_file || d.deleted_file));

/**
 * gh / glab for a diff, read as a stream: the bytes are counted as they come and the CLI is stopped past
 * `maxBytes`, so a huge diff is never held whole in memory.
 */
export const pullDiffCliRunner: PullDiffRunner = async (cli, args, maxBytes, reading) => {
  // Its own process group (POSIX), so the deadline ends everything the CLI started too (refRunnerKill: TERM, then
  // KILL): a CLI that catches TERM, or a child holding the pipes, can never keep this read open.
  const group = process.platform !== "win32";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cli, ...args], {
      env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: group,
    });
  } catch {
    return { stdout: "", stderr: `${cli}: not found`, exitCode: 127 };
  }
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const end = () => {
    refRunnerKill((signal) => (group ? process.kill(-proc.pid, signal) : proc.kill(signal)));
    void reader.cancel().catch(() => {});
  };
  if (reading?.signal?.aborted) end();
  reading?.signal?.addEventListener("abort", end, { once: true });
  const timer = setTimeout(end, reading?.timeoutMs ?? INBOX_PULL_DIFF_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let tooLarge = false;
    const stderr = new Response(proc.stderr as ReadableStream).text();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        end();
        break;
      }
      chunks.push(value);
    }
    const exitCode = await proc.exited;
    if (tooLarge) return { stdout: "", stderr: "", exitCode: 1, tooLarge: true };
    return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: await stderr, exitCode };
  } finally {
    clearTimeout(timer);
    reading?.signal?.removeEventListener("abort", end);
  }
};

/** A runner that buffers (the tests' scripted one) under the same byte cap. */
function cappedDiffRunner(run: RefRunner): PullDiffRunner {
  return async (cli, args, maxBytes) => {
    const result = await run(cli, args);
    return Buffer.byteLength(result.stdout, "utf8") > maxBytes ? { stdout: "", stderr: "", exitCode: 1, tooLarge: true } : result;
  };
}

/**
 * One host's list: the person's own PRs first (they say what a PR is to them), then Others' (every open PR of the
 * projects' repositories) that the own lists did not find, each PR once. Scoped (the Reviews page) keeps only the
 * projects' repositories; `everywhere` (the Pull requests page) keeps the person's own PRs in any repository, and
 * Others only in the projects' (Others never reads anything else).
 */
export function mergeListedPulls(own: readonly InboxPull[], others: readonly InboxPull[], wanted: ReadonlySet<string>, everywhere = false): InboxPull[] {
  const out = new Map<string, InboxPull>();
  for (const pull of own) {
    if ((everywhere || wanted.has(inboxPullRepoKey(pull.host, pull.repo))) && !out.has(pull.key)) out.set(pull.key, pull);
  }
  for (const pull of others) {
    if (wanted.has(inboxPullRepoKey(pull.host, pull.repo)) && !out.has(pull.key)) out.set(pull.key, pull);
  }
  return [...out.values()];
}

export function createInboxPulls(options: { run?: RefRunner; diffRun?: PullDiffRunner; gitRead?: PullFileGitReader; gitRun?: PullGitRunner; now?: () => number } = {}): InboxPulls {
  const run = options.run ?? refCliRunner;
  const gitRun = options.gitRun ?? createPullGitRunner();
  const diffRun = options.diffRun ?? (options.run ? cappedDiffRunner(options.run) : pullDiffCliRunner);
  const gitRead = options.gitRead ?? pullFileGitRead;
  const now = options.now ?? Date.now;
  const hosts = new Map<string, HostState>();
  const holdUntil = new Map<string, number>();
  const fileHoldUntil = new Map<string, number>();
  /** GitHub's GraphQL budget nearly spent: list reads of the host wait until `resetAt` (diffs do not). */
  const budgetHold = new Map<string, number>();
  const signed =new Map<RefCli, { at: number; ttl: number; set: Promise<Set<string>>; missing: boolean }>();
  const diffs = new Map<string, { at: number; answer: InboxPullDiffAnswer }>();
  const readHeads = new Map<string, string>();
  /** One read a PR, while it is fresh; the people's pictures it named stay allowed while the PR is on the list. */
  const detailReads = new Map<string, { at: number; updated: string; read: Promise<PullDetailsRead>; avatars?: Record<string, string>; partial?: boolean; context?: PRContext }>();
  /**
   * A PR's whole diff at `head`, read with git in a clone of its repository on this computer (its `origin` is the
   * PR's repository: that is how the clone is one of its projects). What the clone lacks is fetched by the PR's own
   * ref and the base branch, with no ref written: no branch, remote-tracking ref, tag or FETCH_HEAD changes, and the
   * worktree, index and stash are never touched. The diff runs from where the head left the base's tip, as the
   * forge's does. Null when no clone gives it, or the diff passes `INBOX_PULL_GIT_DIFF_MAX_BYTES`; the forge's read
   * stands then.
   *
   * An `origin` reached over ssh (`pullRemoteMayPrompt`) gets no network git at all: this runs in the background, and
   * an SSH agent could ask the person to approve a key they never chose to use. The forge gives the base's tip
   * instead, and only a clone that already has both commits is read.
   */
  const localWholeDiff = async (pull: InboxPull, head: string, roots: readonly string[], cli: RefCli, signal?: AbortSignal): Promise<string | null> => {
    if (!compareBranch(pull.base)) return null;
    const baseRef = `refs/heads/${pull.base}`;
    const pullRef = pull.platform === "github" ? `refs/pull/${pull.number}/head` : `refs/merge-requests/${pull.number}/head`;
    const deadline = Date.now() + INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS;
    let forgeBase: Promise<string | null> | undefined;
    for (const root of new Set(roots)) {
      if (signal?.aborted) return null;
      const reading = () => ({ timeoutMs: Math.max(1_000, deadline - Date.now()), signal });
      const git = async (args: string[]) => {
        const result = await gitRun(root, args, reading()).catch(() => null);
        return result && result.exitCode === 0 ? result.stdout : null;
      };
      const quiet = !pullRemoteMayPrompt((await git(["remote", "get-url", "origin"])) ?? "");
      let base: string | null;
      if (quiet) {
        const listed = await git(["ls-remote", "--refs", "origin", baseRef]);
        base = shaOf(listed?.split("\n").map((line) => line.split("\t")).find(([, ref]) => ref === baseRef)?.[0]);
      } else {
        base = await (forgeBase ??= readBaseNow(pull, cli));
      }
      if (!base) continue;
      const tip = base;
      const has = async (sha: string) => (await git(["cat-file", "-e", `${sha}^{commit}`])) !== null;
      const both = async () => (await has(head)) && (await has(tip));
      if (!(await both())) {
        if (!quiet) continue;
        // `--refmap=` with no destination: nothing but objects is written, not even the remote-tracking branch.
        await git(["fetch", "--no-write-fetch-head", "--refmap=", "--no-tags", "--no-prune", "--no-recurse-submodules", "--quiet", "origin", pullRef, baseRef]);
        if (!(await both())) continue;
      }
      const from = shaOf((await git(["merge-base", tip, head]))?.trim());
      if (!from) continue;
      // The person's own diff settings never apply: no external diff or textconv runs, and the prefixes are the forge's.
      const diff = await gitRun(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", from, head, "--"], { ...reading(), maxBytes: INBOX_PULL_GIT_DIFF_MAX_BYTES }).catch(() => null);
      // Past any model's context: another clone has the same diff, so the forge's read stands.
      if (diff?.tooLarge) return null;
      if (diff && diff.exitCode === 0 && diff.stdout.trim()) return diff.stdout;
    }
    return null;
  };
  /** The tip of a PR's base branch, from the forge (over its API, never ssh). */
  const readBaseNow = async (pull: InboxPull, cli: RefCli): Promise<string | null> => {
    const parts = splitPath(pull.repo)!;
    const github = pull.platform === "github";
    const endpoint = github ? `repos/${parts.owner}/${parts.repo}/git/ref/heads/${compareRef(pull.base)}` : `projects/${encodeURIComponent(pull.repo)}/repository/branches/${encodeURIComponent(pull.base)}`;
    const read = await run(cli, ["api", "--hostname", pull.host, endpoint, ...(github ? ["--jq", ".object.sha"] : [])]).catch(() => null);
    if (!read || read.exitCode !== 0) return null;
    if (github) return shaOf(read.stdout.trim());
    try {
      return shaOf(obj(obj(JSON.parse(read.stdout)).commit).id);
    } catch {
      return null;
    }
  };
  const readHeadNow = async (pull: InboxPull, cli: RefCli): Promise<string | null> => {
    const parts = splitPath(pull.repo)!;
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
  const headFiles = new Map<string, string | null>();
  let known = new Map<string, InboxPull>();
  let lastRepos = new Set<string>();
  /** The last everywhere list's PRs and repositories (the Pull requests page): `find` and All files take them too. */
  let knownWide = new Map<string, InboxPull>();
  let lastWideRepos = new Set<string>();
  const findKnown = (key: string): InboxPull | undefined => known.get(key) ?? knownWide.get(key);
  /** PRs merged from this Inbox, by key: when (`markMerged`). */
  const mergedHere = new Map<string, number>();
  const asMerged = (pull: InboxPull, at: number): InboxPull => ({ ...pull, state: "merged", merged_at: pull.merged_at ?? new Date(at).toISOString() });
  /** A list's PRs with the ones this Inbox merged shown merged (a read that says they are not open any more ends the hold). */
  const withMergedHere = (pulls: InboxPull[]): InboxPull[] => {
    if (mergedHere.size === 0) return pulls;
    return pulls.map((pull) => {
      const at = mergedHere.get(pull.key);
      if (at === undefined) return pull;
      if (now() - at > INBOX_PULLS_MERGED_HOLD_MS || (pull.state !== "open" && pull.state !== "draft")) {
        mergedHere.delete(pull.key);
        return pull;
      }
      return asMerged(pull, at);
    });
  };
  /** A repository one of the last lists (scoped or everywhere) showed. */
  const listedRepo = (pull: InboxPull): boolean => lastRepos.has(inboxPullRepoKey(pull.host, pull.repo)) || lastWideRepos.has(inboxPullRepoKey(pull.host, pull.repo));
  let avatars = new Map<string, Record<string, string>>();
  const listings = new Map<string, Promise<RepoFileListing | null>>();
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

  // --- All files (the rail's "All files"): the forge's tree at a head this Inbox read ---
  const snapshot = (params: URLSearchParams): string => (params.get("snapshot") ?? "").toLowerCase();
  /** The heads All files may list for a PR: the one its patch was read at, and the list's. */
  const headsOf = (key: string): Set<string> => {
    const heads = new Set<string>();
    const read = readHeads.get(key);
    if (read) heads.add(read);
    const listed = findKnown(key)?.head_sha;
    if (listed) heads.add(listed.toLowerCase());
    return heads;
  };
  const forgeRef = (pull: InboxPull): PRRef | null => {
    if (pull.platform === "github") {
      const parts = splitPath(pull.repo);
      return parts ? { platform: "github", host: pull.host, owner: parts.owner, repo: parts.repo, number: pull.number } : null;
    }
    return { platform: "gitlab", host: pull.host, projectPath: pull.repo, iid: pull.number };
  };
  /** The CLI the list reads the host with, watched: a rate limit holds the host's reads as a diff's does. */
  const forgeRuntime = (pull: InboxPull): PRRuntime => ({
    runCommand: async (cmd, args, options) => {
      const cli = cmd as RefCli;
      const result = await run(cli, args, options?.env);
      if (result.exitCode !== 0 && refErrorOf(cli, result) === "rate_limited") holdUntil.set(pull.host, now() + REF_RATE_LIMIT_MS);
      return result;
    },
  });
  const repoAt = (key: string): { pull: InboxPull | null; unavailable: { reason: "unsupported" | "failed"; message: string } | null } => {
    const pull = findKnown(key);
    if (!pull || !listedRepo(pull)) {
      return { pull: null, unavailable: { reason: "unsupported", message: "That pull request is not in the list. Refresh the list and try again." } };
    }
    if (!forgeRef(pull)) return { pull: null, unavailable: { reason: "unsupported", message: "The repository's files could not be listed." } };
    return { pull, unavailable: null };
  };
  /** One listing per PR and head, kept while it holds (a failure is asked again next time). */
  const listingOf = (pull: InboxPull, sha: string): Promise<RepoFileListing | null> => {
    const id = `${pull.key}\u0000${sha}`;
    const hit = listings.get(id);
    if (hit) return hit;
    if (now() < (holdUntil.get(pull.host) ?? 0)) return Promise.resolve(null);
    const pending = fetchPRTree(forgeRuntime(pull), forgeRef(pull)!, sha)
      .then((tree): RepoFileListing | null =>
        tree
          ? { paths: [...tree.paths].sort(compareRepoPaths), revision: { kind: "commit", label: sha.slice(0, 7) }, live: false, ...(tree.truncated ? { truncated: true } : {}) }
          : null,
      )
      .catch(() => null);
    listings.set(id, pending);
    void pending.then((listing) => {
      if (!listing) listings.delete(id);
    });
    while (listings.size > REPO_LISTINGS_KEPT) listings.delete(listings.keys().next().value!);
    return pending;
  };

  /**
   * The person's own lists for one host, for Reviews (scoped to the projects' repositories, `state`) and the Pull
   * requests board (everywhere, `state.wide`) in one read: Reviews shows the board, so whichever asks first reads
   * both, and the other is answered by the same read (in flight, or cached). GitHub: one GraphQL call with both sets of
   * searches (`GITHUB_PULLS_BOTH_QUERY`), or one set when the repositories don't fit the scope (the searches are the
   * same then). GitLab: its own lists are never scoped, so one answer serves both.
   */
  const read = (host: string, cli: RefCli, state: HostState, repos: readonly string[]): Promise<void> => {
    if (state.pending) return state.pending;
    const wide = state.wide;
    const reposKey = [...repos].map((r) => r.toLowerCase()).sort().join(" ");
    const failBoth = (error: InboxPullHost["error"]) => {
      for (const own of [state, wide]) {
        own.error = error;
        own.failedAt = now();
      }
    };
    const job = (async () => {
      if (listHeld(host)) {
        failBoth("rate_limited");
        return;
      }
      const searches = cli === "gh" ? githubPullSearches(now(), repos) : null;
      // GitLab's own lists are the user's, never limited to the projects; GitHub's are while the repositories fit.
      const scoped = !!searches && searches.authored.includes(" repo:");
      const every = scoped ? githubPullSearches(now(), []) : null;
      const args = searches
        ? [
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            `query=${every ? GITHUB_PULLS_BOTH_QUERY : GITHUB_PULLS_QUERY}`,
            "-f",
            `requested=${searches.requested}`,
            "-f",
            `authored=${searches.authored}`,
            "-f",
            `assigned=${searches.assigned}`,
            "-f",
            `merged=${searches.merged}`,
            ...(every
              ? ["-f", `everyRequested=${every.requested}`, "-f", `everyAuthored=${every.authored}`, "-f", `everyAssigned=${every.assigned}`, "-f", `everyMerged=${every.merged}`]
              : []),
          ]
        : ["api", "--hostname", host, "graphql", "-f", `query=${GITLAB_PULLS_QUERY}`];
      const result = await run(cli, args);
      const parsed = result.exitCode === 0 ? (cli === "gh" ? parseGithubPulls(result.stdout, host) : parseGitlabPulls(result.stdout, host)) : null;
      const parsedWide = parsed && every ? parseGithubPulls(result.stdout, host, "every") : parsed;
      if (!parsed || !parsedWide) {
        fail(host, state, cli, result);
        wide.error = state.error;
        wide.failedAt = state.failedAt;
        return;
      }
      spent(host, parsed);
      const at = now();
      state.answer = { at, login: parsed.login, pulls: parsed.pulls, avatars: parsed.avatars, scoped, repos: reposKey, ...(parsed.capped ? { capped: parsed.capped } : {}) };
      wide.answer = { at, login: parsedWide.login, pulls: parsedWide.pulls, avatars: parsedWide.avatars, scoped: false, repos: "", ...(parsedWide.capped ? { capped: parsedWide.capped } : {}) };
      state.error = null;
      wide.error = null;
    })()
      .catch(() => failBoth("unavailable"))
      .finally(() => {
        state.pending = null;
        wide.pending = null;
      });
    state.pending = job;
    wide.pending = job;
    return job;
  };

  /** A list read (own or Others) is held: the forge asked to slow down, or GitHub's GraphQL budget is nearly spent. */
  const heldUntil = (host: string): number => Math.max(holdUntil.get(host) ?? 0, budgetHold.get(host) ?? 0);
  const listHeld = (host: string): boolean => now() < heldUntil(host);

  /** A failed list read: a rate-limit answer holds the host (diffs too); anything else is "unavailable". */
  const fail = (host: string, state: { error: InboxPullHost["error"] | null; failedAt: number }, cli: RefCli, result: RefCommandResult) => {
    const error = refErrorOf(cli, { ...result, exitCode: result.exitCode || 1 });
    if (error === "rate_limited") holdUntil.set(host, now() + REF_RATE_LIMIT_MS);
    state.error = error === "rate_limited" ? "rate_limited" : "unavailable";
    state.failedAt = now();
  };

  /** GitHub's GraphQL budget nearly spent: no list read of this host until it fills again (diffs are REST: not held). */
  const spent = (host: string, parsed: ParsedPulls) => {
    if (!parsed.rate || parsed.rate.remaining >= INBOX_PULLS_RATE_FLOOR) return;
    const reset = Date.parse(parsed.rate.reset_at);
    if (Number.isFinite(reset) && reset > now()) budgetHold.set(host, reset);
  };

  /**
   * Others for one host: every open PR of its repositories, the most active first, at most
   * `INBOX_PULLS_OTHERS_CALLS_MAX` searches (GitHub, one request) or queries (GitLab, one after the other), all within
   * `INBOX_PULLS_OTHERS_DEADLINE_MS`. Apart from the person's own lists: a failure here keeps the last Others answer
   * and never touches them.
   */
  const readOthers = (host: string, state: HostState, repos: readonly string[]): Promise<void> => {
    const others = state.others;
    if (others.pending) return others.pending;
    const reposKey = [...repos].map((r) => r.toLowerCase()).sort().join(" ");
    const job = (async () => {
      if (listHeld(host)) {
        others.error = "rate_limited";
        others.failedAt = now();
        return;
      }
      const ordered = byActivity(repos, [...(state.answer?.pulls ?? []), ...(others.answer?.pulls ?? [])]);
      const cli = state.cli;
      let calls: string[][];
      let covered: string[];
      if (cli === "gh") {
        const plan = githubOthersSearches(ordered);
        covered = plan.covered;
        calls = plan.searches.length ? [["api", "graphql", "--hostname", host, "-f", `query=${githubOthersQuery(plan.searches.length)}`, ...plan.searches.flatMap((q, i) => ["-f", `others${i}=${q}`])]] : [];
      } else {
        const plan = gitlabOthersQueries(ordered);
        covered = plan.covered;
        calls = plan.queries.map((query) => ["api", "--hostname", host, "graphql", "-f", `query=${query}`]);
      }
      if (calls.length === 0) {
        others.answer = { at: now(), pulls: [], avatars: {}, total: 0, repos: reposKey };
        others.error = null;
        return;
      }
      // One deadline for the whole read; no call starts past it.
      let late = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"late">((done) => {
        timer = setTimeout(() => {
          late = true;
          done("late");
        }, INBOX_PULLS_OTHERS_DEADLINE_MS);
      });
      const work = (async (): Promise<{ outputs: string[] } | { failed: RefCommandResult }> => {
        const outputs: string[] = [];
        for (const args of calls) {
          if (late) return { failed: { stdout: "", stderr: "timed out", exitCode: 1 } };
          const result = await run(cli, args);
          if (result.exitCode !== 0) return { failed: result };
          outputs.push(result.stdout);
        }
        return { outputs };
      })();
      const done = await Promise.race([work, deadline]).finally(() => clearTimeout(timer));
      if (done === "late" || "failed" in done) {
        fail(host, others, cli, done === "late" ? { stdout: "", stderr: "timed out", exitCode: 1 } : done.failed);
        return;
      }
      const parsed = cli === "gh" ? parseGithubPulls(done.outputs[0]!, host, "others") : parseGitlabPulls(done.outputs, host, "others");
      if (!parsed) {
        fail(host, others, cli, { stdout: done.outputs.join("\n"), stderr: "", exitCode: 1 });
        return;
      }
      spent(host, parsed);
      const all = covered.length >= new Set(repos.map((r) => r.toLowerCase())).size;
      others.answer = { at: now(), pulls: parsed.pulls, avatars: parsed.avatars, total: all ? (parsed.open_total ?? 0) : null, repos: reposKey };
      others.error = null;
    })()
      .catch(() => {
        others.error = "unavailable";
        others.failedAt = now();
      })
      .finally(() => {
        others.pending = null;
      });
    others.pending = job;
    return job;
  };

  const due = (state: OwnState, refresh: boolean): boolean => {
    if (state.error && now() - state.failedAt < REF_FAILURE_MS) return false;
    if (!state.answer) return true;
    return now() - state.answer.at >= (refresh ? INBOX_PULLS_REFRESH_MS : INBOX_PULLS_FRESH_MS);
  };

  /** Others is read every `INBOX_PULLS_OTHERS_FRESH_MS` at most, or as the list is while the Others view is open (`eager`). */
  const othersDue = (others: OthersState, reposKey: string, refresh: boolean, eager: boolean): boolean => {
    if (others.error && now() - others.failedAt < REF_FAILURE_MS) return false;
    if (!others.answer || others.answer.repos !== reposKey) return true;
    const age = now() - others.answer.at;
    if (eager) return age >= (refresh ? INBOX_PULLS_REFRESH_MS : INBOX_PULLS_FRESH_MS);
    return age >= INBOX_PULLS_OTHERS_FRESH_MS;
  };

  return {
    async list(repos, { refresh = false, others: eager = false, everywhere = false } = {}) {
      const wanted = new Set(repos.map((r) => inboxPullRepoKey(r.host, r.repo)));
      const byHost = new Map<string, InboxPullRepo[]>();
      for (const repo of repos) {
        const host = repo.host.toLowerCase();
        byHost.set(host, [...(byHost.get(host) ?? []), repo]);
      }
      const asked: { host: string; state: HostState; own: OwnState; reposKey: string }[] = [];
      const unsigned: string[] = [];
      const cliStates: Partial<Record<RefCli, InboxPullCliState>> = {};
      if (everywhere) {
        // Any host a CLI here is signed in to, not only the projects' (the projects' hosts no CLI is signed in to stay
        // "unsigned", as always).
        for (const cli of ["gh", "glab"] as const) {
          for (const host of await signedIn(cli)) if (!byHost.has(host)) byHost.set(host, []);
        }
      }
      await Promise.all(
        [...byHost.keys()].map(async (host) => {
          const cli = await cliFor(host, cliStates);
          if (!cli) {
            unsigned.push(host);
            return;
          }
          let state = hosts.get(host);
          if (!state || state.cli !== cli) {
            state = {
              cli,
              answer: null,
              failedAt: 0,
              error: null,
              pending: null,
              others: { answer: null, failedAt: 0, error: null, pending: null },
              wide: { answer: null, failedAt: 0, error: null, pending: null },
            };
            hosts.set(host, state);
          }
          const repoNames = byHost.get(host)!.map((r) => r.repo);
          // The searches are scoped to the projects' repositories: a new set of them reads again.
          const reposKey = [...repoNames].map((r) => r.toLowerCase()).sort().join(" ");
          const own: OwnState = everywhere ? state.wide : state;
          // One read serves both lists (`read`): a list whose answer is fresh is answered from it, or waits for it.
          if (everywhere) {
            if (due(own, refresh)) await read(host, cli, state, repoNames);
          } else if (due(state, refresh) || (state.answer && state.answer.repos !== reposKey && !(state.error && now() - state.failedAt < REF_FAILURE_MS))) await read(host, cli, state, repoNames);
          // Others after the person's own lists (its order follows their activity), on its own path and clock, and never
          // waited for: this answer carries its last answer (and `others_pending`); a new one lands on the next list.
          if (othersDue(state.others, reposKey, refresh, eager)) void readOthers(host, state, repoNames);
          asked.push({ host, state, own, reposKey });
        }),
      );
      asked.sort((a, b) => a.host.localeCompare(b.host));
      const listed: InboxPull[] = [];
      for (const { state, own } of asked) listed.push(...mergeListedPulls(own.answer?.pulls ?? [], state.others.answer?.pulls ?? [], wanted, everywhere));
      const pulls = withMergedHere(listed);
      if (everywhere) {
        knownWide = new Map(pulls.map((p) => [p.key, p]));
        lastWideRepos = new Set(pulls.map((p) => inboxPullRepoKey(p.host, p.repo)));
      } else {
        known = new Map(pulls.map((p) => [p.key, p]));
        lastRepos = wanted;
      }
      // Only the people this list names (a PR's author, its reviewers, who approved it): the window may ask for their
      // pictures, no one else's.
      const nextAvatars = new Map<string, Record<string, string>>();
      for (const { host, state, own } of asked) {
        const urls: Record<string, string> = {};
        for (const pull of pulls) {
          if (pull.host.toLowerCase() !== host) continue;
          for (const who of [pull.author, ...pull.reviewers, pull.approved_by]) {
            if (!who || urls[who]) continue;
            const url = own.answer?.avatars[who] ?? state.others.answer?.avatars[who];
            if (url) urls[who] = url;
          }
        }
        // Both pages read in turn (the sidebar's count, the Pull requests page): an everywhere list keeps the other's.
        nextAvatars.set(host, everywhere ? { ...(avatars.get(host) ?? {}), ...urls } : urls);
      }
      avatars = nextAvatars;
      /**
       * What the list shows of a host whose reads left PRs out: its open PRs in this list (`shown`), and how many there
       * are (`total`): Others' count when it searched every repository, or the person's own searches' count when they
       * were limited to the projects' repositories (the larger); null when that is not known (Others searched only
       * the most active repositories, or the own searches were not limited and Others has no answer). `of: "others"`:
       * only Others left PRs out (the person's own lists are whole). An Others answer read for another set of
       * repositories counts nothing: no count from the old set until Others answers for this one.
       */
      const cappedOfHost = (host: string, state: HostState, own: OwnState, reposKey: string): InboxPullHost["capped"] | undefined => {
        const { answer } = own;
        const others = state.others.answer?.repos === reposKey ? state.others.answer : null;
        if (!answer && !others) return undefined;
        const shown = pulls.filter((p) => p.host.toLowerCase() === host && (p.state === "open" || p.state === "draft")).length;
        const ownCut = !!answer?.capped && answer.capped.total > answer.capped.shown;
        // The person's own searches cut and not limited to the projects (and no whole Others count): the cut is theirs.
        if (ownCut && !answer!.scoped && (!others || others.total === null)) return { shown, total: null };
        const ownTotal = ownCut && answer!.scoped ? shown + (answer!.capped!.total - answer!.capped!.shown) : shown;
        if (others && others.total === null) return ownTotal > shown ? { shown, total: ownTotal } : { shown, total: null, of: "others" };
        const othersTotal = others?.total ?? 0;
        if (ownTotal >= othersTotal) return ownTotal > shown ? { shown, total: ownTotal } : undefined;
        return othersTotal > shown ? { shown, total: othersTotal, of: "others" } : undefined;
      };
      const times = asked.map((a) => a.own.answer?.at).filter((t): t is number => typeof t === "number");
      return {
        fetched_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        hosts: asked.map(({ host, state, own, reposKey }): InboxPullHost => {
          const capped = cappedOfHost(host, state, own, reposKey);
          const others = state.others;
          return {
            cli: state.cli,
            host,
            login: own.answer?.login ?? null,
            // A host that failed this time still shows its last answer, when there is one: the window says so.
            ...(own.error ? { error: own.error, ...(own.answer ? { last_read: new Date(own.answer.at).toISOString() } : {}) } : {}),
            // Others failed on its own: the person's own lists stand; the window says Others is the last read, or missing.
            ...(others.error ? { others_error: others.error, ...(others.answer ? { others_last_read: new Date(others.answer.at).toISOString() } : {}) } : {}),
            // Others is being read in the background (never waited for): the window asks again shortly.
            ...(others.pending ? { others_pending: true as const } : {}),
            ...(capped ? { capped } : {}),
          };
        }),
        pulls,
        clis: { ...cliStates },
        unsigned: unsigned.sort(),
      };
    },
    find(key) {
      return findKnown(key) ?? null;
    },
    markMerged(key) {
      const at = now();
      mergedHere.set(key, at);
      for (const map of [known, knownWide]) {
        const pull = map.get(key);
        if (pull) map.set(key, asMerged(pull, at));
      }
    },
    signedInTo: async (cli, host) => (await signedIn(cli)).has(host),
    async othersSettled() {
      await Promise.all([...hosts.values()].map((state) => state.others.pending));
    },
    avatarUrls(host) {
      const named: Record<string, string> = {};
      const asked = host.toLowerCase();
      for (const [key, entry] of detailReads) {
        const pull = findKnown(key);
        if (!pull || now() - entry.at > INBOX_PULL_DETAILS_KEEP_MS) {
          detailReads.delete(key);
          continue;
        }
        if (pull.host.toLowerCase() === asked && entry.avatars) Object.assign(named, entry.avatars);
      }
      return { ...named, ...(avatars.get(asked) ?? {}) };
    },
    async details(key) {
      const pull = findKnown(key);
      if (!pull || !listedRepo(pull)) throw new InboxPullsError("pull_unknown", "That pull request is not in the list.");
      const forge = pull.platform === "github" ? "GitHub" : "GitLab";
      const failed = () => new InboxPullsError("pull_details_failed", `${forge} did not answer. Try again in a minute.`);
      const hit = detailReads.get(key);
      if (hit && !hit.partial && hit.updated === pull.updated_at && now() - hit.at < INBOX_PULL_DETAILS_FRESH_MS) {
        try {
          return (await hit.read).answer;
        } catch {
          // Another asker's read, still in flight when it failed: the same answer, not an internal error.
          throw failed();
        }
      }
      // Held (a rate limit: a minute; GitHub's budget spent: until it fills, up to an hour): the window says until when.
      if (listHeld(pull.host)) throw new InboxPullsError("pull_details_held", `${pull.host} asked to slow down.`, heldUntil(pull.host));
      const parts = splitPath(pull.repo);
      if (!parts) throw failed();
      const ref: PRRef = pull.platform === "github"
        ? { platform: "github", host: pull.host, owner: parts.owner, repo: parts.repo, number: pull.number }
        : { platform: "gitlab", host: pull.host, projectPath: pull.repo, iid: pull.number };
      const runtime = forgeRuntime(pull);
      const entry: { at: number; updated: string; read: Promise<PullDetailsRead>; avatars?: Record<string, string>; partial?: boolean; context?: PRContext } = {
        at: now(),
        updated: pull.updated_at,
        read: fetchPRContextWithReviewers(runtime, ref).then((context) => {
          // Kept for the PR media route: the only text whose pictures it fetches.
          entry.context = context;
          return pullDetailsOf(key, context, pull.author);
        }),
        // The faces already shown stay allowed while the next read is out.
        ...(hit?.avatars ? { avatars: hit.avatars } : {}),
      };
      detailReads.set(key, entry);
      try {
        const read = await entry.read;
        entry.avatars = { ...entry.avatars, ...read.avatars };
        // Part of an answer is shown, and asked again on the next opening; its faces stay allowed meanwhile.
        if (read.answer.threads_incomplete) entry.partial = true;
        return read.answer;
      } catch {
        // A failure is not kept: the next opening asks again.
        if (detailReads.get(key) === entry) detailReads.delete(key);
        throw failed();
      }
    },
    async text(key) {
      // The text kept from the last details read serves every picture while the PR has not moved: no read per picture.
      const known = findKnown(key);
      const kept = detailReads.get(key);
      if (!known || !kept?.context || kept.updated !== known.updated_at) await this.details(key);
      const pull = findKnown(key);
      const context = detailReads.get(key)?.context;
      if (!pull || !context) throw new InboxPullsError("pull_unknown", "That pull request is not in the list.");
      return { pull, context, runtime: forgeRuntime(pull) };
    },
    readHead: (key) => readHeads.get(key) ?? null,
    async file(key, path, repos) {
      // The PR may have moved since the last read of the list: its head is what the code is read at.
      if (repos) await this.list(repos, { refresh: false }).catch(() => {});
      const pull = findKnown(key);
      const sha = pull ? (pull.head_sha ?? readHeads.get(key)) : null;
      const parts = pull ? splitPath(pull.repo) : null;
      if (!pull || !sha || !parts) return null;
      const kept = `${pull.host}/${pull.repo}@${sha}:${path}`;
      let contents = headFiles.get(kept);
      if (contents === undefined) {
        if (now() < (holdUntil.get(pull.host) ?? 0)) return null;
        const ref: PRRef =
          pull.platform === "github"
            ? { platform: "github", host: pull.host, owner: parts.owner, repo: parts.repo, number: pull.number }
            : { platform: "gitlab", host: pull.host, projectPath: pull.repo, iid: pull.number };
        // Only a real answer is kept: a read that failed says nothing about the file, and asks again next time.
        let failed = false;
        // The host always named, as for every read here: neither GH_HOST nor a folder's remote picks it.
        const runtime: PRRuntime = {
          runCommand: async (cli, args) => {
            const result = await diffRun(cli as RefCli, args.includes("--hostname") ? args : [...args, "--hostname", pull.host], INBOX_PULL_FILE_READ_BYTES);
            if (result.exitCode !== 0 && !result.tooLarge && !/\b404\b/.test(`${result.stderr} ${result.stdout}`)) failed = true;
            return result;
          },
        };
        const read = await fetchPRFileContent(runtime, ref, sha, path).catch(() => {
          failed = true;
          return null;
        });
        // Text only, and no larger than a file on this computer: what is not, the preview cannot show.
        contents = read === null || read.includes("\0") || Buffer.byteLength(read, "utf8") > MAX_REPO_FILE_BYTES ? null : read;
        if (!failed) {
          headFiles.set(kept, contents);
          while (headFiles.size > INBOX_PULL_FILES_KEPT) headFiles.delete(headFiles.keys().next().value!);
        }
      }
      if (contents === null) return null;
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const url = `https://${pull.host}/${pull.repo}/${pull.platform === "gitlab" ? "-/" : ""}blob/${sha}/${encoded}`;
      return { contents, label: inboxPullLabel(pull), platform: pull.platform, url };
    },
    async hasCommit(key, sha) {
      const pull = findKnown(key);
      const parts = pull ? splitPath(pull.repo) : null;
      if (!pull || !parts || pull.platform !== "github") return null;
      const read = await run("gh", ["api", "--hostname", pull.host, `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}/commits?per_page=100`, "--paginate", "--jq", ".[].sha"]).catch(() => null);
      if (!read || read.exitCode !== 0) return null;
      const commits = read.stdout.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
      if (commits.includes(sha.toLowerCase())) return true;
      // GitHub lists at most 250: past that, not listed says nothing.
      return commits.length >= PULL_COMMITS_LISTED_MAX ? null : false;
    },
    async repoFiles(key, params) {
      const at = repoAt(key);
      return handleRepoFilesRequest({
        params,
        unavailable: at.unavailable,
        isCurrentSnapshot: (snapshot) => !!at.pull && headsOf(key).has(snapshot.toLowerCase()),
        loadListing: () => listingOf(at.pull!, snapshot(params)),
      });
    },
    async repoFile(key, params) {
      const at = repoAt(key);
      const sha = snapshot(params);
      return handleRepoFileRequest({
        params,
        unavailable: at.unavailable,
        isCurrentSnapshot: (asked) => !!at.pull && headsOf(key).has(asked.toLowerCase()),
        loadListing: () => listingOf(at.pull!, sha),
        read: (path, maxBytes): Promise<RepoFileRead> => {
          const pull = at.pull!;
          if (now() < (holdUntil.get(pull.host) ?? 0)) return Promise.resolve({ kind: "unavailable" });
          return fetchPRFileBytes(forgeRuntime(pull), forgeRef(pull)!, sha, path, maxBytes);
        },
        // A forge's listing is never on disk; the shared reader keeps the one way in should that change.
        readWorkingTree: readRepoWorkingTreeFile,
      });
    },
    async diff(key, scope) {
      const pull = findKnown(key);
      if (!pull || !listedRepo(pull)) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
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
      // By what makes the diff: a label or a comment moves `updated_at` and costs no read.
      const cacheKey = `${key}\u0000${scope}\u0000${bases[0]}\u0000${pull.head_sha ?? pull.updated_at}`;
      const hit = diffs.get(cacheKey);
      // Only an answer naming the head last read here: a list gone back to an older head reads the forge, and so does a
      // head the forge did not pin down.
      if (hit && now() - hit.at < INBOX_PULL_DIFF_FRESH_MS && readHeads.get(key) === hit.answer.head_sha) return hit.answer;
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
      // The PR as the forge has it now, one call: its head commit, read around the patch (a push between the two reads
      // leaves it unknown; a layer posts nothing), and its description.
      // `tojson`: gh colours an object answer under CLICOLOR_FORCE, whatever NO_COLOR says, and prints a string raw.
      const pullNow = async (): Promise<{ sha: string | null; description: string | null } | null> => {
        const endpoint = pull.platform === "github" ? `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}` : `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`;
        const read = await run(cli, ["api", "--hostname", pull.host, endpoint, ...(pull.platform === "github" ? ["--jq", "{sha: .head.sha, body: .body} | tojson"] : [])]).catch(() => null);
        if (!read || read.exitCode !== 0) return null;
        try {
          const answer = obj(JSON.parse(read.stdout));
          if (pull.platform === "github") return { sha: shaOf(answer.sha), description: descriptionOf(answer.body) };
          return { sha: shaOf(answer.sha) ?? shaOf(obj(answer.diff_refs).head_sha), description: descriptionOf(answer.description) };
        } catch {
          return null;
        }
      };
      const before = await pullNow();
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
      const headBefore = before?.sha ?? null;
      const headAfter = headBefore ? ((await pullNow())?.sha ?? null) : null;
      const head_sha = headBefore && headBefore === headAfter ? headBefore : null;
      const description = before?.description ?? null;
      if (head_sha) readHeads.set(key, head_sha);
      const answer: InboxPullDiffAnswer = { key, scope, base, head, patch, description, head_sha };
      diffs.set(cacheKey, { at: now(), answer });
      // Bounded: only the last few diffs are kept.
      while (diffs.size > 24) diffs.delete(diffs.keys().next().value!);
      return answer;
    },
    async wholeDiff(key, signal, roots = []) {
      const pull = findKnown(key);
      if (!pull || !listedRepo(pull)) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
      const cli: RefCli = hosts.get(pull.host)?.cli ?? (pull.platform === "github" ? "gh" : "glab");
      if (now() < (holdUntil.get(pull.host) ?? 0)) throw new InboxPullsError("pull_diff_failed", `${pull.host} asked to slow down. Try again in a minute.`);
      const github = pull.platform === "github";
      const parts = splitPath(pull.repo)!;
      const project = `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`;
      const read = (endpoint: string, ...more: string[]) => diffRun(cli, ["api", "--hostname", pull.host, endpoint, ...more], Number.POSITIVE_INFINITY, { timeoutMs: INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS, signal });
      /** Not the forge's limit on one document: asking it again some other way wouldn't help. */
      const stopFor = (result: RefCommandResult) => {
        // By stderr alone, where gh and glab write their errors: stdout here is a diff, and a diff can say anything.
        const error = refErrorOf(cli, { ...result, stdout: "" });
        if (error === "rate_limited") holdUntil.set(pull.host, now() + REF_RATE_LIMIT_MS);
        if (error === "signed_out") return `${cli} is not signed in to ${pull.host}.`;
        return error === "rate_limited" || error === "cli_missing" ? `${cli} could not read this diff. Try again, or open it on the forge.` : null;
      };
      const headBefore = await readHeadNow(pull, cli);
      const whole = github
        ? await read(`repos/${parts.owner}/${parts.repo}/pulls/${pull.number}`, "-H", "Accept: application/vnd.github.v3.diff")
        : await read(`${project}/raw_diffs`);
      let patch = whole.exitCode === 0 ? whole.stdout : "";
      let partial = false;
      let heldBack: string | undefined;
      const perFile = !patch.trim();
      if (perFile) {
        const stop = whole.exitCode === 0 ? null : stopFor(whole);
        if (stop) throw new InboxPullsError("pull_diff_failed", stop);
        // The forge's per-file read: a file it holds back still comes by name, and a page that failed leaves the ones before it.
        const paged = github ? await read(`repos/${parts.owner}/${parts.repo}/pulls/${pull.number}/files?per_page=100`, "--paginate") : await read(`${project}/diffs?per_page=100`, "--paginate");
        const gather = <Entry,>(entries: Entry[], rebuild: (all: Entry[]) => string, heldBack: (one: Entry) => boolean) => {
          patch = rebuild(entries);
          partial = paged.exitCode !== 0 || entries.length < pull.files || (github && entries.length >= GITHUB_FILES_API_STOP) || entries.some(heldBack);
        };
        try {
          if (github) gather(parsePaginatedArray<GitHubFileEntry>(paged.stdout), reconstructGhPatch, ghEntryMissingContent);
          else gather(parsePaginatedArray<GitLabDiffEntry>(paged.stdout), reconstructGitlabPatch, glMayBeHeldBack);
        } catch {
          patch = "";
        }
        // Less than the whole diff, or nothing: a clone on this computer gives the whole of it, when there is one.
        const local = (partial || !patch.trim()) && headBefore && roots.length > 0 ? await localWholeDiff(pull, headBefore, roots, cli, signal) : null;
        if (local) {
          if (patch.trim()) heldBack = patch;
          patch = local;
          partial = false;
        }
        if (!patch.trim()) {
          if (paged.exitCode !== 0) throw new InboxPullsError("pull_diff_failed", stopFor(paged) ?? `${cli} could not read this diff. Try again, or open it on the forge.`);
          throw new InboxPullsError("pull_diff_failed", "The forge returned no diff for this pull request.");
        }
      }
      const headAfter = headBefore ? await readHeadNow(pull, cli) : null;
      return { patch, partial, head_sha: headBefore && headBefore === headAfter ? headBefore : null, ...(heldBack ? { held_back: heldBack } : {}), ...(perFile ? { per_file: true as const } : {}) };
    },
    async fileContents(key, scope, path, roots, ids, oldPath) {
      const none: InboxFileContents = { oldContent: null, newContent: null };
      // Nothing to check a text against (GitLab's whole-stack patches carry no index line): no arrows, and nothing runs.
      if (!ids) return none;
      // A rename's old path comes from the patch, which a guide's author wrote: it must not walk out of the forge's route.
      if (oldPath !== undefined) {
        try {
          validateFilePath(oldPath);
        } catch {
          return none;
        }
      }
      const pull = findKnown(key);
      if (!pull || !listedRepo(pull)) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
      // The commit the patch on screen was read at, when the Inbox read one, else the list's. A patch whose head moved
      // during its read is the client's to catch (its answer has no head_sha, so it asks nothing); the blob ids catch the rest.
      const head = shaOf(readHeads.get(key) ?? pull.head_sha);
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
        // Only a commit is kept: "no base" can be a passing sign-in problem, and the next click asks again.
        const drop = () => {
          if (mergeBases.get(baseKey) === read) mergeBases.delete(baseKey);
        };
        read.then((base) => {
          if (!base) drop();
        }, drop);
        while (mergeBases.size > 64) mergeBases.delete(mergeBases.keys().next().value!);
        return read;
      };
      const textAt = (sha: string, filePath: string): Promise<string | null> => {
        const textKey = `${pull.host}/${pull.repo}\u0000${sha}\u0000${filePath}`;
        const hit = fileTexts.get(textKey);
        if (hit) {
          // Used again: the last to go.
          fileTexts.delete(textKey);
          fileTexts.set(textKey, hit);
          return hit.read;
        }
        const read = inTurn(async () => {
          for (const root of roots) {
            const local = await gitRead(root, sha, filePath, INBOX_PULL_FILE_MAX_BYTES).catch(() => null);
            if (local === "none") return null;
            if (local !== null) return local;
          }
          const endpoint =
            pull.platform === "github"
              ? `repos/${parts.owner}/${parts.repo}/contents/${compareRef(filePath)}?ref=${sha}`
              : `projects/${project}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${sha}`;
          const text = await ask(endpoint, pull.platform === "github" ? ["-H", "Accept: application/vnd.github.v3.raw"] : []);
          return text === null || text.slice(0, 8000).includes("\u0000") ? null : text;
        });
        const entry = { read, bytes: 0 };
        fileTexts.set(textKey, entry);
        read.then(
          (text) => {
            // Still the one kept (the bound may have dropped it while it ran).
            if (fileTexts.get(textKey) !== entry) return;
            // Only a text is kept: an empty answer or a 404 can be a passing sign-in problem, and the next click asks again.
            if (!text) {
              fileTexts.delete(textKey);
              return;
            }
            entry.bytes = Buffer.byteLength(text, "utf8");
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
        const newContent = await textAt(head, path);
        if (newContent === null || !isBlob(newContent, ids.newId)) return none;
        const base = await mergeBase();
        if (!base) return none;
        const oldContent = await textAt(base, oldPath ?? path);
        // The list can be behind the patch, and a merged PR's base can be its head: only the patch's own blobs open.
        return oldContent === null || !isBlob(oldContent, ids.oldId) ? none : { oldContent, newContent };
      } catch {
        // A forge that did not answer (rate limited, offline, signed out, not JSON): the next click asks again.
        return { ...none, failed: true };
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
  /** A launched thread whose start failed, or whose agent never connected. */
  launchDead?(threadId: string): boolean;
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
/**
 * The agent working in a thread. A thread the person just handed over: its agent has not written yet, so it is the
 * session the first message went to. Ended: a session that sent with a wake polls while it runs, so one not polling now
 * has ended; the session a hand-off went to was live then. An agent that only reads the Inbox (no wake) is never called ended.
 */
export function threadAgent(store: InboxPullLinkStore, threadId: string): InboxPullLink["agent"] {
  const { last } = threadFacts(store, threadId);
  const root = store.message(threadId);
  const to = last ? null : (root?.to ?? null);
  const ended = (session: string | null, wakes: boolean): boolean => !!store.sessionLive && !!session && wakes && !store.sessionLive(session);
  if (last && last.author.kind === "agent") return { host: last.author.host, session: last.author.session, name: last.author.name, ...(ended(last.author.session, last.wakes === true) ? { ended: true } : {}) };
  // A session the Inbox launched polls only once it has started: until it writes, not polling isn't ended, its run state is.
  return to ? { host: to.host, session: to.session, name: null, ...((root?.launch ? store.launchDead?.(threadId) : ended(to.session, true)) ? { ended: true } : {}) } : null;
}

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
    return {
      via,
      ...(via === "owner" && root?.session ? { handed_to: root.session } : {}),
      thread_id: threadId,
      thread_subject: store.threadSubject(threadId),
      project_id: projectId,
      agent: threadAgent(store, threadId),
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
