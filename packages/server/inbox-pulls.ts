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

import { forgeRefKey } from "@plannotator/core/forge-ref-card";
import {
  INBOX_PULLS_MERGED_DAYS,
  INBOX_PULLS_SEARCH_MAX,
  inboxCardRefsOf,
  inboxPullRepoKey,
  inboxPullStacks,
  inboxPullUrlsIn,
  type InboxCard,
  type InboxMessage,
  type InboxPull,
  type InboxPullChecks,
  type InboxPullDiffAnswer,
  type InboxPullDiffScope,
  type InboxPullHost,
  type InboxPullLink,
  type InboxPullReview,
  type InboxPullState,
} from "@plannotator/core/inbox-types";
import { parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { reconstructGitlabPatch, type GitLabDiffEntry } from "@plannotator/shared/pr-provider";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCli, type RefRunner } from "./ref-cards";

/** A host's answer is fresh this long. */
export const INBOX_PULLS_FRESH_MS = 60_000;
/** A refresh reads again what is older than this. */
export const INBOX_PULLS_REFRESH_MS = 20_000;
/** A patch larger than this is refused (the review says to open it on the forge). */
export const INBOX_PULL_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** A layer's diff is kept this long (keyed by the PR's last update too). */
export const INBOX_PULL_DIFF_FRESH_MS = 5 * 60_000;

// --- the queries ---

const GH_PULL = `number title url state isDraft updatedAt mergedAt baseRefName headRefName additions deletions changedFiles reviewDecision
      repository { nameWithOwner } headRepository { nameWithOwner } author { login }
      reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      latestReviews(first: 5) { nodes { state author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** One query per GitHub host: the viewer, and the three searches. */
export const GITHUB_PULLS_QUERY = `query InboxPulls($requested: String!, $authored: String!, $merged: String!) {
  viewer { login }
  requested: search(type: ISSUE, query: $requested, first: ${INBOX_PULLS_SEARCH_MAX}) { nodes { ... on PullRequest { ${GH_PULL} } } }
  authored: search(type: ISSUE, query: $authored, first: ${INBOX_PULLS_SEARCH_MAX}) { nodes { ... on PullRequest { ${GH_PULL} } } }
  merged: search(type: ISSUE, query: $merged, first: 30) { nodes { ... on PullRequest { ${GH_PULL} } } }
}`;

const GL_MR = `iid title webUrl state draft updatedAt mergedAt sourceBranch targetBranch approved detailedMergeStatus
      diffStatsSummary { additions deletions fileCount } headPipeline { status }
      project { fullPath } sourceProject { fullPath } author { username }
      approvedBy(first: 3) { nodes { username } } reviewers(first: 5) { nodes { username } }`;

/** One query per GitLab host: the current user's requested, opened and merged MRs. */
export const GITLAB_PULLS_QUERY = `query InboxPulls {
  currentUser {
    username
    requested: reviewRequestedMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { nodes { ${GL_MR} } }
    authored: authoredMergeRequests(state: opened, first: ${INBOX_PULLS_SEARCH_MAX}) { nodes { ${GL_MR} } }
    merged: authoredMergeRequests(state: merged, first: 20, sort: MERGED_AT_DESC) { nodes { ${GL_MR} } }
  }
}`;

for (const q of [GITHUB_PULLS_QUERY, GITLAB_PULLS_QUERY]) {
  if (!/^query\b/.test(q)) throw new Error("inbox-pulls: every query must be a query");
}

/** The three GitHub searches (the merged one goes back `INBOX_PULLS_MERGED_DAYS` from `now`). */
export function githubPullSearches(now: number): { requested: string; authored: string; merged: string } {
  const since = new Date(now - INBOX_PULLS_MERGED_DAYS * 86_400_000).toISOString().slice(0, 10);
  return {
    requested: "is:pr is:open archived:false review-requested:@me",
    authored: "is:pr is:open archived:false author:@me",
    merged: `is:pr is:merged author:@me merged:>=${since}`,
  };
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

/** A GitHub answer as the viewer's login and PRs; null when it is not one. */
export function parseGithubPulls(stdout: string, host: string): { login: string | null; pulls: InboxPull[] } | null {
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
  const read = (list: unknown, requested: boolean) => {
    for (const item of nodes(list)) {
      const repo = str(obj(item.repository).nameWithOwner);
      const parts = splitPath(repo);
      const number = num(item.number);
      if (!parts || number < 1) continue;
      const key = forgeRefKey({ platform: "github", host, owner: parts.owner, repo: parts.repo, number, kind: "pull" });
      const author = str(obj(item.author).login) || null;
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
        additions: num(item.additions),
        deletions: num(item.deletions),
        files: num(item.changedFiles),
        review,
        approved_by: approver ? str(obj(approver.author).login) || null : null,
        reviewers,
        checks,
        updated_at: str(item.updatedAt),
        merged_at: str(item.mergedAt) || null,
      });
    }
  };
  read(data.authored, false);
  read(data.merged, false);
  read(data.requested, true);
  return { login, pulls: [...out.values()] };
}

const GL_FAIL = new Set(["FAILED", "CANCELED"]);
const GL_QUIET = new Set(["SKIPPED", "MANUAL"]);

/** A GitLab answer as the current user's name and MRs; null when it is not one. */
export function parseGitlabPulls(stdout: string, host: string): { login: string | null; pulls: InboxPull[] } | null {
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
  const read = (list: unknown, requested: boolean) => {
    for (const item of nodes(list)) {
      const repo = str(obj(item.project).fullPath);
      const parts = splitPath(repo);
      const number = num(item.iid);
      if (!parts || number < 1) continue;
      const key = forgeRefKey({ platform: "gitlab", host, owner: parts.owner, repo: parts.repo, number, kind: "pull" });
      const author = str(obj(item.author).username) || null;
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
        additions: num(stats.additions),
        deletions: num(stats.deletions),
        files: num(stats.fileCount),
        review: state === "merged" || state === "closed" ? null : review,
        approved_by: approvers[0] ?? null,
        reviewers: nodes(item.reviewers)
          .map((n) => str(n.username))
          .filter((name) => name !== "" && name !== login && !approvers.includes(name)),
        checks,
        updated_at: str(item.updatedAt),
        merged_at: str(item.mergedAt) || null,
      });
    }
  };
  read(user.authored, false);
  read(user.merged, false);
  read(user.requested, true);
  return { login, pulls: [...out.values()] };
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
    readonly code: "pull_unknown" | "pull_diff_failed" | "pull_diff_too_large" | "validation_error",
    message: string,
  ) {
    super(message);
  }
}

export interface InboxPulls {
  /** The PRs of these repositories, with the hosts asked. Never throws. */
  list(repos: readonly InboxPullRepo[], options?: { refresh?: boolean }): Promise<{ fetched_at: string | null; hosts: InboxPullHost[]; pulls: InboxPull[] }>;
  /** A PR the last list named, by key. */
  find(key: string): InboxPull | null;
  /** One layer's patch, or the stack's from its base up to that layer. Throws InboxPullsError. */
  diff(key: string, scope: InboxPullDiffScope): Promise<InboxPullDiffAnswer>;
}

const BRANCH = /^[A-Za-z0-9._\/-]{1,250}$/;
const safeBranch = (name: string) => BRANCH.test(name) && !name.includes("..") && !name.startsWith("-") && !name.startsWith("/");

export function createInboxPulls(options: { run?: RefRunner; now?: () => number } = {}): InboxPulls {
  const run = options.run ?? refCliRunner;
  const now = options.now ?? Date.now;
  const hosts = new Map<string, HostState>();
  const holdUntil = new Map<string, number>();
  const signed = new Map<RefCli, { at: number; ttl: number; set: Promise<Set<string>> }>();
  const diffs = new Map<string, { at: number; answer: InboxPullDiffAnswer }>();
  let known = new Map<string, InboxPull>();
  let lastRepos = new Set<string>();

  const signedIn = (cli: RefCli): Promise<Set<string>> => {
    const hit = signed.get(cli);
    if (hit && now() - hit.at < hit.ttl) return hit.set;
    const set = readSignedInHosts(run, cli).catch(() => new Set<string>());
    const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, set };
    signed.set(cli, entry);
    void set.then((found) => {
      if (found.size === 0) entry.ttl = REF_FAILURE_MS;
    });
    return set;
  };

  /** The CLI signed in to a host, or null: nothing is asked of a host no CLI here is signed in to. */
  const cliFor = async (host: string): Promise<RefCli | null> => {
    const order: RefCli[] = /gitlab/i.test(host) ? ["glab", "gh"] : ["gh", "glab"];
    for (const cli of order) if ((await signedIn(cli)).has(host)) return cli;
    return null;
  };

  const read = (host: string, state: HostState): Promise<void> => {
    if (state.pending) return state.pending;
    const job = (async () => {
      if (now() < (holdUntil.get(host) ?? 0)) {
        state.error = "rate_limited";
        state.failedAt = now();
        return;
      }
      const args =
        state.cli === "gh"
          ? (() => {
              const s = githubPullSearches(now());
              return ["api", "graphql", "--hostname", host, "-f", `query=${GITHUB_PULLS_QUERY}`, "-f", `requested=${s.requested}`, "-f", `authored=${s.authored}`, "-f", `merged=${s.merged}`];
            })()
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
      state.answer = { at: now(), login: parsed.login, pulls: parsed.pulls };
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
      await Promise.all(
        [...byHost.keys()].map(async (host) => {
          const cli = await cliFor(host);
          if (!cli) return;
          let state = hosts.get(host);
          if (!state || state.cli !== cli) {
            state = { cli, answer: null, failedAt: 0, error: null, pending: null };
            hosts.set(host, state);
          }
          if (due(state, refresh)) await read(host, state);
          asked.push({ host, state });
        }),
      );
      asked.sort((a, b) => a.host.localeCompare(b.host));
      const pulls: InboxPull[] = [];
      for (const { state } of asked) for (const pull of state.answer?.pulls ?? []) if (wanted.has(inboxPullRepoKey(pull.host, pull.repo))) pulls.push(pull);
      known = new Map(pulls.map((p) => [p.key, p]));
      lastRepos = wanted;
      const times = asked.map((a) => a.state.answer?.at).filter((t): t is number => typeof t === "number");
      return {
        fetched_at: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
        hosts: asked.map(({ host, state }) => ({ cli: state.cli, host, login: state.answer?.login ?? null, ...(state.error ? { error: state.error } : {}) })),
        pulls,
      };
    },
    find(key) {
      return known.get(key) ?? null;
    },
    async diff(key, scope) {
      const pull = known.get(key);
      if (!pull || !lastRepos.has(inboxPullRepoKey(pull.host, pull.repo))) throw new InboxPullsError("pull_unknown", "That pull request is not in the list. Refresh the list and try again.");
      let base = pull.base;
      if (scope === "stack") {
        const stack = inboxPullStacks([...known.values()].filter((p) => p.host === pull.host && p.repo === pull.repo)).find((s) => s.layers.some((l) => l.key === key));
        base = stack?.base ?? pull.base;
      }
      const cacheKey = `${key}\u0000${scope}\u0000${base}\u0000${pull.updated_at}`;
      const hit = diffs.get(cacheKey);
      if (hit && now() - hit.at < INBOX_PULL_DIFF_FRESH_MS) return hit.answer;
      if (scope === "stack" && (!safeBranch(base) || !safeBranch(pull.head))) throw new InboxPullsError("pull_diff_failed", "This stack's branch names can't be compared here. Open it on the forge.");
      const state = hosts.get(pull.host);
      const cli: RefCli = state?.cli ?? (pull.platform === "github" ? "gh" : "glab");
      if (now() < (holdUntil.get(pull.host) ?? 0)) throw new InboxPullsError("pull_diff_failed", `${pull.host} asked to slow down. Try again in a minute.`);
      const parts = splitPath(pull.repo)!;
      let args: string[];
      if (pull.platform === "github") {
        const endpoint = scope === "layer" ? `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}` : `repos/${parts.owner}/${parts.repo}/compare/${base}...${pull.head}`;
        args = ["api", "--hostname", pull.host, endpoint, "-H", "Accept: application/vnd.github.v3.diff"];
      } else {
        const project = encodeURIComponent(pull.repo);
        const endpoint =
          scope === "layer"
            ? `projects/${project}/merge_requests/${pull.number}/raw_diffs`
            : `projects/${project}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(pull.head)}&straight=false`;
        args = ["api", "--hostname", pull.host, endpoint];
      }
      const result = await run(cli, args);
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
      if (patch.length > INBOX_PULL_DIFF_MAX_BYTES) throw new InboxPullsError("pull_diff_too_large", "This diff is too large to read here. Open it on the forge.");
      const answer: InboxPullDiffAnswer = { key, scope, base, head: pull.head, patch };
      diffs.set(cacheKey, { at: now(), answer });
      // Bounded: only the last few diffs are kept.
      while (diffs.size > 24) diffs.delete(diffs.keys().next().value!);
      return answer;
    },
  };
}

// --- linking a PR to its agent ---

/** The parts of the store linking reads. */
export interface InboxPullLinkStore {
  listCards(): InboxCard[];
  threadsOf(projectId: string): { thread_id: string; last_at: string }[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  threadSubject(threadId: string): string | null;
  project(id: string): { root: string } | null;
  cursor(): number;
}

/** Threads read for a branch match: active in this many days. */
export const INBOX_PULL_BRANCH_DAYS = 14;
/** At most this many folders are asked their branch per list. */
export const INBOX_PULL_BRANCH_FOLDERS = 40;
/** A folder's branch is kept this long. */
export const INBOX_PULL_BRANCH_MS = 60_000;

function previewOf(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]+/g, " ")
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
 * Which agent thread each PR is tied to, in order of trust: a Board card
 * that links the PR (its first thread), the PR's URL in an agent's message
 * (the latest), or, for the person's own PRs, the PR's head branch checked
 * out in the folder an agent thread works in (the latest thread per folder).
 * `branchOf` reads a folder's branch (null when it can't).
 */
export async function linkInboxPulls(
  pulls: readonly InboxPull[],
  store: InboxPullLinkStore,
  projectsByRepo: ReadonlyMap<string, string>,
  branchOf: (folder: string) => Promise<string | null>,
  now: number = Date.now(),
): Promise<Record<string, InboxPullLink>> {
  const links: Record<string, InboxPullLink> = {};
  if (pulls.length === 0) return links;
  const wanted = new Set(pulls.map((p) => p.key));
  const keyOfUrl = (url: string) => {
    const ref = parseForgeRefUrl(url);
    return ref && ref.kind === "pull" ? forgeRefKey(ref) : null;
  };

  // 1. Board cards.
  const cardOf = new Map<string, InboxCard>();
  const cardOfThread = new Map<string, InboxCard>();
  for (const card of store.listCards()) {
    for (const ref of inboxCardRefsOf(card)) {
      if (ref.kind !== "pr") continue;
      const key = keyOfUrl(ref.url);
      if (key && wanted.has(key) && !cardOf.has(key)) cardOf.set(key, card);
    }
    for (const thread of card.threads) if (!cardOfThread.has(thread)) cardOfThread.set(thread, card);
  }

  // 2. URLs in agents' messages, and 3. the threads whose folders may hold the branch.
  const projectIds = [...new Set(projectsByRepo.values())];
  const urlThread = new Map<string, { thread: string; project: string; at: string }>();
  const folders = new Map<string, { thread: string; project: string; at: string }>();
  for (const projectId of projectIds) {
    const root = store.project(projectId)?.root ?? null;
    for (const summary of store.threadsOf(projectId)) {
      const recent = now - Date.parse(summary.last_at) < INBOX_PULL_BRANCH_DAYS * 86_400_000;
      let folder: string | null = null;
      for (const id of store.threadMessageIds(summary.thread_id)) {
        const message = store.message(id);
        if (!message || message.author.kind !== "agent") continue;
        folder = message.base_path ?? root;
        for (const url of inboxPullUrlsIn(message.body)) {
          const key = keyOfUrl(url);
          if (!key || !wanted.has(key)) continue;
          const seen = urlThread.get(key);
          if (!seen || seen.at <= message.created_at) urlThread.set(key, { thread: summary.thread_id, project: projectId, at: message.created_at });
        }
      }
      if (recent && folder) {
        const seen = folders.get(folder);
        if (!seen || seen.at < summary.last_at) folders.set(folder, { thread: summary.thread_id, project: projectId, at: summary.last_at });
      }
    }
  }

  const branchThread = new Map<string, { thread: string; project: string }>();
  const needBranch = pulls.some((p) => p.mine && !cardOf.has(p.key) && !urlThread.has(p.key));
  if (needBranch) {
    const newest = [...folders.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, INBOX_PULL_BRANCH_FOLDERS);
    const branches = await Promise.all(newest.map(async ([folder, at]) => ({ at, branch: await branchOf(folder).catch(() => null) })));
    for (const { at, branch } of branches) {
      if (!branch || branch === "HEAD") continue;
      const key = `${at.project}\u0000${branch}`;
      if (!branchThread.has(key)) branchThread.set(key, at);
    }
  }

  const linkOf = (via: InboxPullLink["via"], threadId: string, projectId: string, card: InboxCard | null): InboxPullLink => {
    const { last, guide } = threadFacts(store, threadId);
    const linkedCard = card ?? cardOfThread.get(threadId) ?? null;
    return {
      via,
      thread_id: threadId,
      thread_subject: store.threadSubject(threadId),
      project_id: projectId,
      agent: last && last.author.kind === "agent" ? { host: last.author.host, session: last.author.session, name: last.author.name } : null,
      last: last ? { message_id: last.id, preview: previewOf(last.body), at: last.created_at } : null,
      guide: guide?.guide ? { message_id: guide.id, title: guide.guide.title, steps: guide.guide.sections } : null,
      card: linkedCard ? { id: linkedCard.id, title: linkedCard.title, column: linkedCard.column } : null,
    };
  };

  for (const pull of pulls) {
    const project = projectsByRepo.get(inboxPullRepoKey(pull.host, pull.repo));
    const card = cardOf.get(pull.key);
    if (card && card.threads[0]) {
      links[pull.key] = linkOf("card", card.threads[0], card.project_id, card);
      continue;
    }
    const url = urlThread.get(pull.key);
    if (url) {
      links[pull.key] = linkOf("url", url.thread, url.project, null);
      continue;
    }
    if (pull.mine && project && (pull.state === "open" || pull.state === "draft")) {
      const branch = branchThread.get(`${project}\u0000${pull.head}`);
      if (branch) links[pull.key] = linkOf("branch", branch.thread, branch.project, null);
    }
  }
  return links;
}

/** A folder's checked-out branch through `git rev-parse`, cached per folder for `INBOX_PULL_BRANCH_MS`. */
export function createBranchReader(git: (folder: string) => Promise<string | null>, now: () => number = Date.now): (folder: string) => Promise<string | null> {
  const cache = new Map<string, { at: number; branch: Promise<string | null> }>();
  return (folder) => {
    const hit = cache.get(folder);
    if (hit && now() - hit.at < INBOX_PULL_BRANCH_MS) return hit.branch;
    const branch = git(folder).catch(() => null);
    cache.set(folder, { at: now(), branch });
    while (cache.size > 200) cache.delete(cache.keys().next().value!);
    return branch;
  };
}
