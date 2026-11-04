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
  inboxPullSafeBranch,
  type InboxPullCard,
  type InboxPullLink,
  type InboxPullReview,
  type InboxPullState,
} from "@plannotator/core/inbox-types";
import { parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { reconstructGitlabPatch, type GitLabDiffEntry } from "@plannotator/shared/pr-provider";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCli, type RefCommandResult, type RefRunner } from "./ref-cards";

/** A host's answer is fresh this long. */
export const INBOX_PULLS_FRESH_MS = 60_000;
/** A refresh reads again what is older than this. */
export const INBOX_PULLS_REFRESH_MS = 20_000;
/** A patch larger than this is refused (the review says to open it on the forge). */
export const INBOX_PULL_DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** A layer's diff is kept this long (keyed by the PR's last update too). */
export const INBOX_PULL_DIFF_FRESH_MS = 5 * 60_000;

/** A commit id as the forge answered it (40 or 64 hex digits), or null. */
function shaOf(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value) ? value.toLowerCase() : null;
}

// --- the queries ---

const GH_PULL = `number title url state isDraft updatedAt mergedAt baseRefName headRefName headRefOid additions deletions changedFiles reviewDecision
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

const GL_MR = `iid title webUrl state draft updatedAt mergedAt sourceBranch targetBranch diffHeadSha approved detailedMergeStatus
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
        head_sha: shaOf(item.headRefOid),
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
  /** The PRs of these repositories, with the hosts asked. Never throws. */
  list(repos: readonly InboxPullRepo[], options?: { refresh?: boolean }): Promise<{ fetched_at: string | null; hosts: InboxPullHost[]; pulls: InboxPull[] }>;
  /** A PR the last list named, by key. */
  find(key: string): InboxPull | null;
  /** One layer's patch, or the stack's from its base up to that layer. Throws InboxPullsError. */
  diff(key: string, scope: InboxPullDiffScope): Promise<InboxPullDiffAnswer>;
}

/** A GitHub owner as `owner:branch` takes it in a compare (a fork's head). */
const FORK_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Core's branch check (`inboxPullSafeBranch`): the compare and the hand-off's words take the same names. */
export const safeBranch = inboxPullSafeBranch;

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

export function createInboxPulls(options: { run?: RefRunner; diffRun?: PullDiffRunner; now?: () => number } = {}): InboxPulls {
  const run = options.run ?? refCliRunner;
  const diffRun = options.diffRun ?? (options.run ? cappedDiffRunner(options.run) : pullDiffCliRunner);
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

  const read = (host: string, state: HostState, repos: readonly string[]): Promise<void> => {
    if (state.pending) return state.pending;
    const reposKey = [...repos].map((r) => r.toLowerCase()).sort().join(" ");
    const job = (async () => {
      if (now() < (holdUntil.get(host) ?? 0)) {
        state.error = "rate_limited";
        state.failedAt = now();
        return;
      }
      const args =
        state.cli === "gh"
          ? (() => {
              const s = githubPullSearches(now(), repos);
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
      state.answer = { at: now(), login: parsed.login, pulls: parsed.pulls, repos: reposKey };
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
      if (scope === "stack" && fork) {
        const owner = splitPath(pull.head_repo!)?.owner ?? "";
        if (pull.platform !== "github" || !FORK_OWNER.test(owner)) {
          throw new InboxPullsError("pull_diff_fork", `This layer comes from a fork, which ${pull.platform === "gitlab" ? "GitLab" : "the forge"} can't compare with the stack here. Review it layer by layer, or open it on the forge.`);
        }
        head = `${owner}:${pull.head}`;
      }
      const cacheKey = `${key}\u0000${scope}\u0000${bases[0]}\u0000${pull.updated_at}`;
      const hit = diffs.get(cacheKey);
      if (hit && now() - hit.at < INBOX_PULL_DIFF_FRESH_MS) return hit.answer;
      if (scope === "stack" && (!bases.every(safeBranch) || !safeBranch(pull.head))) throw new InboxPullsError("pull_diff_failed", "This stack's branch names can't be compared here. Open it on the forge.");
      const state = hosts.get(pull.host);
      const cli: RefCli = state?.cli ?? (pull.platform === "github" ? "gh" : "glab");
      if (now() < (holdUntil.get(pull.host) ?? 0)) throw new InboxPullsError("pull_diff_failed", `${pull.host} asked to slow down. Try again in a minute.`);
      const parts = splitPath(pull.repo)!;
      const argsFor = (base: string): string[] => {
        if (pull.platform === "github") {
          const endpoint = scope === "layer" ? `repos/${parts.owner}/${parts.repo}/pulls/${pull.number}` : `repos/${parts.owner}/${parts.repo}/compare/${base}...${head}`;
          return ["api", "--hostname", pull.host, endpoint, "-H", "Accept: application/vnd.github.v3.diff"];
        }
        const project = encodeURIComponent(pull.repo);
        const endpoint =
          scope === "layer"
            ? `projects/${project}/merge_requests/${pull.number}/raw_diffs`
            : `projects/${project}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(pull.head)}&straight=false`;
        return ["api", "--hostname", pull.host, endpoint];
      };
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
      const answer: InboxPullDiffAnswer = { key, scope, base, head, patch };
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
  threadsOf(projectId: string): { thread_id: string; last_at: string }[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  threadSubject(threadId: string): string | null;
  /** The project a thread is in (canonical id), or null when there is no such thread. */
  threadProject(threadId: string): string | null;
}

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
    return {
      via,
      ...(via === "owner" && root?.session ? { handed_to: root.session } : {}),
      thread_id: threadId,
      thread_subject: store.threadSubject(threadId),
      project_id: projectId,
      agent: last && last.author.kind === "agent" ? { host: last.author.host, session: last.author.session, name: last.author.name } : to ? { host: to.host, session: to.session, name: null } : null,
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
