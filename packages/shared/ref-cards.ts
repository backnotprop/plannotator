/**
 * Hover cards for issue, pull request and merge request links: the data a
 * card shows, fetched with this computer's own forge CLI. The Inbox serves it
 * at `GET /api/inbox/ref`; any other server can mount the same `createRefCards`.
 *
 * Read only: one `gh api graphql` / `glab api graphql` call per ref, always a
 * `query` (the module refuses to load otherwise); it is the endpoint `gh pr
 * view` reads too. Nothing runs until a person rests on a link long enough for
 * the card to open, so drawing a message costs nothing.
 *
 * - GitHub: `issueOrPullRequest` answers both kinds in one call. When GitHub
 *   refuses the account in use (404/401/403/SAML), every other account signed
 *   in on that host is tried through its own token in GH_TOKEN for that child
 *   only (#2157's rule), and the one that could see a repo is remembered for
 *   it (memory only; a token is never logged).
 * - GitLab: the `issue` or `mergeRequest` of a project (GitLab numbers them
 *   apart, so the link's kind decides). glab holds one login per host.
 * - Hosts: github.com and gitlab.com, plus the hosts this computer's own gh
 *   or glab is signed in to (`gh auth status`, `glab auth status`, read once
 *   per `REF_AUTH_HOSTS_MS`): GitHub Enterprise and self-managed GitLab. Any
 *   other host answers `unsupported` without running anything, so a link (or
 *   a cloned repo's origin) naming `github.evil.example` can never make the
 *   CLI send GH_ENTERPRISE_TOKEN or GITLAB_TOKEN there.
 * - Cache, per ref: an answer is fresh for `REF_FRESH_MS`, a failure for
 *   `REF_FAILURE_MS`; a stale answer is served at once while one refresh runs
 *   (up to `REF_STALE_MAX_MS`). Hovers of one ref share one request; at most
 *   `REF_MAX_CONCURRENT` CLIs run at once. A rate-limit answer stops every
 *   fetch to that host for `REF_RATE_LIMIT_MS`.
 * - Bounded memory (the Inbox is a long-lived process): at most
 *   `REF_CACHE_MAX` refs and `REF_REPO_ACCOUNTS_MAX` remembered repo accounts
 *   (least recently used dropped first), answers no longer worth serving are
 *   dropped, and at most `REF_MAX_WAITING` lookups wait for a CLI (one past
 *   that answers `unavailable` at once, without caching it).
 * - Avatars are fetched once from the forge's own avatar hosts and inlined as
 *   data URIs (a window whose CSP takes no remote image can still draw them),
 *   at most `AVATAR_CACHE_MAX` of them and `AVATAR_CACHE_MAX_BYTES` in all.
 */

import {
  FORGE_REF_BODY_MAX,
  FORGE_REF_COMMENT_MAX,
  forgeRefKey,
  parseForgeRefUrl,
  type ForgeRef,
  type ForgeRefCardData,
  type ForgeRefCardError,
  type ForgeRefCardResult,
  type ForgeRefChecks,
  type ForgeRefLinked,
  type ForgeRefPerson,
} from "@plannotator/core/forge-ref-card";
import { ghTokenEnvVar, parseGhAuthStatusJson, parseGhAuthStatusText } from "./pr-github-account";
import { isSameOriginOrNoOrigin } from "./request-origin";

export const REF_FRESH_MS = 60_000;
export const REF_FAILURE_MS = 30_000;
export const REF_STALE_MAX_MS = 15 * 60_000;
export const REF_RATE_LIMIT_MS = 60_000;
export const REF_TIMEOUT_MS = 8_000;
export const REF_MAX_CONCURRENT = 2;
export const REF_AUTH_HOSTS_MS = 5 * 60_000;
/** Refs kept in the cache (an answer, or a failure being held). */
export const REF_CACHE_MAX = 500;
/** Repos whose GitHub account (a token, in memory only) is remembered. */
export const REF_REPO_ACCOUNTS_MAX = 200;
/**
 * Lookups waiting for a free CLI. Above one Board request's links
 * (`INBOX_CARD_MARKS_MAX`, 200), so the Inbox's marks never reach it.
 */
export const REF_MAX_WAITING = 500;
const AVATAR_MAX_BYTES = 64 * 1024;
export const AVATAR_CACHE_MAX = 500;
/** The inlined avatars' data URIs, in all. */
export const AVATAR_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** Set `key` as the newest entry, then drop the oldest until `max` remain (`onDrop` for each). */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number, onDrop?: (key: K, value: V) => void): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) dropOldest(map, onDrop);
}

function dropOldest<K, V>(map: Map<K, V>, onDrop?: (key: K, value: V) => void): void {
  const oldest = map.entries().next();
  if (oldest.done) return;
  map.delete(oldest.value[0]);
  onDrop?.(oldest.value[0], oldest.value[1]);
}

/** Mark `key` as the most recently used. */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

export type RefCli = "gh" | "glab";
export interface RefCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
/** Run `cli args…` (env added to the live env). Exit 127 when the CLI is not installed. */
export type RefRunner = (cli: RefCli, args: string[], env?: Record<string, string>) => Promise<RefCommandResult>;

// --- the queries ---

const GH_PERSON = "login avatarUrl(size: 48)";
const GH_COMMON = `number title url createdAt updatedAt closedAt body
  author { ${GH_PERSON} } labels(first: 8) { nodes { name color } } assignees(first: 4) { nodes { ${GH_PERSON} } }
  comments(last: 1) { totalCount nodes { author { ${GH_PERSON} } createdAt body } }`;

export const GITHUB_REF_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { ${GH_COMMON} state stateReason
        closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number title url state } } }
      ... on PullRequest { ${GH_COMMON} state isDraft mergedAt baseRefName headRefName additions deletions changedFiles reviewDecision
        closingIssuesReferences(first: 3) { nodes { number title url state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
          __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } }
    }
  }
}`;

const GL_PERSON = "username avatarUrl";
const GL_COMMON = `iid title webUrl state createdAt updatedAt closedAt description
  author { ${GL_PERSON} } labels(first: 8) { nodes { title color } } assignees(first: 4) { nodes { ${GL_PERSON} } }
  userNotesCount notes(last: 20) { nodes { system body createdAt author { ${GL_PERSON} } } }`;

export const GITLAB_ISSUE_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { fullPath issue(iid: $iid) { ${GL_COMMON} } }
}`;

export const GITLAB_MR_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { fullPath mergeRequest(iid: $iid) { ${GL_COMMON}
    draft mergedAt sourceBranch targetBranch diffStatsSummary { additions deletions fileCount }
    approved detailedMergeStatus headPipeline { status jobs(first: 100) { nodes { status } } } } }
}`;

for (const q of [GITHUB_REF_QUERY, GITLAB_ISSUE_QUERY, GITLAB_MR_QUERY]) {
  if (!/^query\b/.test(q)) throw new Error("ref-cards: every ref query must be a query");
}

function queryArgs(ref: ForgeRef): { cli: RefCli; args: string[] } {
  // Always named, github.com and gitlab.com too: otherwise GH_HOST, GITLAB_HOST or the working
  // folder's git remote would pick the host the query (and the token) goes to.
  const hostArgs = ["--hostname", ref.host];
  if (ref.platform === "github") {
    return {
      cli: "gh",
      // -f for strings: -F would turn a repo named `2048`, `true` or `null` into a number, boolean or null.
      args: ["api", "graphql", ...hostArgs, "-f", `query=${GITHUB_REF_QUERY}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repo}`, "-F", `number=${ref.number}`],
    };
  }
  const query = ref.kind === "pull" ? GITLAB_MR_QUERY : GITLAB_ISSUE_QUERY;
  return {
    cli: "glab",
    args: ["api", ...hostArgs, "graphql", "-f", `query=${query}`, "-f", `path=${ref.owner}/${ref.repo}`, "-f", `iid=${ref.number}`],
  };
}

// --- reading the answers ---

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);
const hex = (v: unknown) => {
  const s = str(v).replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : "888888";
};

function cut(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max).replace(/\s+\S*$/, "")}…`, cut: true } : { text, cut: false };
}

/** A person, with the avatar URL to inline later (only from the forge's own avatar hosts). */
function personOf(v: unknown, login: "login" | "username", avatarOk: (url: string) => string | null): ForgeRefPerson | null {
  const p = obj(v);
  const name = str(p[login]);
  if (!name) return null;
  return { login: name, avatarUrl: avatarOk(str(p.avatarUrl)) };
}

const githubAvatar = (url: string) => (/^https:\/\/avatars\.githubusercontent\.com\//.test(url) ? url : null);
const gitlabAvatar = (host: string) => (url: string) => {
  if (url.startsWith("/") && !url.startsWith("//")) return `https://${host}${url}`;
  if (url.startsWith(`https://${host}/`) || /^https:\/\/secure\.gravatar\.com\/avatar\//.test(url)) return url;
  return null;
};

function linkedOf(list: unknown): ForgeRefLinked[] {
  return nodes(list).map((n) => ({
    number: num(n.number),
    title: str(n.title),
    url: str(n.url),
    state: n.state === "MERGED" ? "merged" : n.state === "OPEN" ? "open" : "closed",
  }));
}

function tally(verdicts: string[], overall: string | null): ForgeRefChecks | null {
  if (!overall && verdicts.length === 0) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const v of verdicts) {
    if (v === "success") passed++;
    else if (v === "failure") failed++;
    else pending++;
  }
  const state = overall === "success" || overall === "failure" || overall === "pending" ? overall : failed ? "failure" : pending ? "pending" : "success";
  return { state, passed, failed, pending, total: verdicts.length };
}

const GH_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const GH_WAIT = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** A GitHub answer as card data; `not_found` when the number names nothing; null when the answer is not one. */
export function parseGithubRefAnswer(stdout: string): ForgeRefCardData | "not_found" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = obj(obj(parsed).data);
  if (data.repository === null) return "not_found";
  const repository = obj(data.repository);
  if (repository.issueOrPullRequest === null) return "not_found";
  const item = obj(repository.issueOrPullRequest);
  const type = item.__typename;
  if (type !== "Issue" && type !== "PullRequest") return null;
  const body = cut(str(item.body), FORGE_REF_BODY_MAX);
  const comments = obj(item.comments);
  const last = nodes(comments)[0];
  const person = (v: unknown) => personOf(v, "login", githubAvatar);
  const base = {
    platform: "github" as const,
    repo: str(repository.nameWithOwner),
    number: num(item.number),
    url: str(item.url),
    title: str(item.title),
    author: person(item.author),
    createdAt: str(item.createdAt),
    updatedAt: str(item.updatedAt),
    labels: nodes(item.labels).map((l) => ({ name: str(l.name), color: hex(l.color) })),
    assignees: nodes(item.assignees).map(person).filter((p): p is ForgeRefPerson => p !== null),
    comments: num(comments.totalCount),
    body: body.text,
    bodyCut: body.cut,
    lastComment: last ? { author: person(last.author), at: str(last.createdAt), body: cut(str(last.body), FORGE_REF_COMMENT_MAX).text } : null,
  };
  if (type === "Issue") {
    const state = item.state === "OPEN" ? "open" : item.stateReason === "NOT_PLANNED" ? "not_planned" : item.stateReason === "COMPLETED" ? "completed" : "closed";
    return { ...base, kind: "issue", state, closedAt: str(item.closedAt) || null, linked: linkedOf(item.closedByPullRequestsReferences) };
  }
  const rollup = obj(obj(obj(nodes(item.commits)[0]).commit).statusCheckRollup);
  const verdicts = nodes(rollup.contexts).map((c) => {
    const v = c.__typename === "StatusContext" ? str(c.state) : c.status === "COMPLETED" ? str(c.conclusion) : "PENDING";
    return GH_PASS.has(v) ? "success" : GH_WAIT.has(v) ? "pending" : "failure";
  });
  const overall = rollup.state === "SUCCESS" ? "success" : rollup.state === "PENDING" || rollup.state === "EXPECTED" ? "pending" : rollup.state ? "failure" : null;
  return {
    ...base,
    kind: "pull",
    state: item.state === "MERGED" ? "merged" : item.state === "CLOSED" ? "closed" : item.isDraft === true ? "draft" : "open",
    closedAt: str(item.mergedAt) || str(item.closedAt) || null,
    linked: linkedOf(item.closingIssuesReferences),
    pull: {
      base: str(item.baseRefName),
      head: str(item.headRefName),
      additions: num(item.additions),
      deletions: num(item.deletions),
      files: num(item.changedFiles),
      review: item.reviewDecision === "APPROVED" ? "approved" : item.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : item.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null,
      checks: rollup.state ? tally(verdicts, overall) : null,
    },
  };
}

const GL_PASS = new Set(["SUCCESS", "SKIPPED", "MANUAL"]);
const GL_FAIL = new Set(["FAILED", "CANCELED"]);

/** A GitLab answer as card data (`kind` is the link's, since GitLab numbers issues and MRs apart). */
export function parseGitlabRefAnswer(stdout: string, host: string, kind: ForgeRef["kind"]): ForgeRefCardData | "not_found" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = obj(obj(parsed).data);
  if (data.project === null) return "not_found";
  const project = obj(data.project);
  const raw = kind === "pull" ? project.mergeRequest : project.issue;
  if (raw === null) return "not_found";
  const item = obj(raw);
  if (!item.iid) return null;
  const person = (v: unknown) => personOf(v, "username", gitlabAvatar(host));
  const body = cut(str(item.description), FORGE_REF_BODY_MAX);
  const last = nodes(item.notes).filter((n) => n.system !== true && str(n.body).trim()).at(-1);
  const base = {
    platform: "gitlab" as const,
    repo: str(project.fullPath),
    number: num(item.iid),
    url: str(item.webUrl),
    title: str(item.title),
    author: person(item.author),
    createdAt: str(item.createdAt),
    updatedAt: str(item.updatedAt),
    labels: nodes(item.labels).map((l) => ({ name: str(l.title), color: hex(l.color) })),
    assignees: nodes(item.assignees).map(person).filter((p): p is ForgeRefPerson => p !== null),
    comments: num(item.userNotesCount),
    body: body.text,
    bodyCut: body.cut,
    lastComment: last ? { author: person(last.author), at: str(last.createdAt), body: cut(str(last.body), FORGE_REF_COMMENT_MAX).text } : null,
    linked: [],
  };
  if (kind === "issue") {
    return { ...base, kind: "issue", state: item.state === "opened" ? "open" : "completed", closedAt: str(item.closedAt) || null };
  }
  const pipeline = item.headPipeline ? obj(item.headPipeline) : null;
  const status = pipeline ? str(pipeline.status) : "";
  const verdicts = pipeline ? nodes(pipeline.jobs).map((j) => (GL_PASS.has(str(j.status)) ? "success" : GL_FAIL.has(str(j.status)) ? "failure" : "pending")) : [];
  const stats = obj(item.diffStatsSummary);
  const merge = str(item.detailedMergeStatus);
  const state = item.state === "merged" ? "merged" : item.state === "opened" ? (item.draft === true ? "draft" : "open") : "closed";
  return {
    ...base,
    kind: "pull",
    state,
    closedAt: str(item.mergedAt) || str(item.closedAt) || null,
    pull: {
      base: str(item.targetBranch),
      head: str(item.sourceBranch),
      additions: num(stats.additions),
      deletions: num(stats.deletions),
      files: num(stats.fileCount),
      // Approvals are quiet once the MR is done: GitLab keeps answering NOT_OPEN there.
      review:
        state === "merged" || state === "closed"
          ? item.approved === true ? "approved" : null
          : merge === "REQUESTED_CHANGES" ? "changes_requested" : item.approved === true ? "approved" : merge === "NOT_APPROVED" ? "review_required" : null,
      checks: pipeline
        ? tally(verdicts, status === "SUCCESS" ? "success" : GL_FAIL.has(status) ? "failure" : status === "SKIPPED" || status === "MANUAL" ? null : "pending")
        : null,
    },
  };
}

/** What a failed CLI answer means; `refused` is GitHub saying no (another account may see it). */
export function refErrorOf(cli: RefCli, result: RefCommandResult): ForgeRefCardError | "refused" {
  const err = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode === 127 || /executable file not found|command not found|^(gh|glab): not found$/im.test(err)) return "cli_missing";
  if (/rate limit|\b429\b|RATE_LIMITED|Too Many Requests/i.test(err)) return "rate_limited";
  if (/not logged in|auth login|authentication required|not authenticated|has not been authenticated/i.test(err)) return "signed_out";
  if (cli === "glab" && /\b401\b|Unauthorized/i.test(err)) return "signed_out";
  if (/Could not resolve to|NOT_FOUND|\bHTTP (404|401|403)\b|\b404\b|Not Found|Bad credentials|SAML|\b403\b|Forbidden/i.test(err)) return "refused";
  return "unavailable";
}

/**
 * The hosts a CLI is signed in to, lowercased (never a token). gh: `auth
 * status --json hosts` (any account that gh could use), else the text form's
 * "Logged in to <host>" lines. glab: `auth status`'s "Logged in to <host>"
 * lines (it prints them on stderr). A CLI that is missing or refuses answers
 * no hosts.
 */
export async function readSignedInHosts(run: RefRunner, cli: RefCli): Promise<Set<string>> {
  const hosts = new Set<string>();
  const fromText = (text: string) => {
    for (const m of text.replace(/\u001b\[[0-9;]*m/g, "").matchAll(/Logged in to ([A-Za-z0-9.-]+)/g)) hosts.add(m[1].toLowerCase());
  };
  if (cli === "gh") {
    const json = await run("gh", ["auth", "status", "--json", "hosts"]);
    if (json.exitCode === 0) {
      try {
        const parsed = JSON.parse(json.stdout) as { hosts?: Record<string, { state?: string }[]> };
        for (const [host, accounts] of Object.entries(parsed.hosts ?? {})) {
          // Only an account gh says is signed in: every gh with `--json hosts` writes `state`, so one without it is not trusted.
          if (Array.isArray(accounts) && accounts.some((a) => a?.state === "success")) hosts.add(host.toLowerCase());
        }
        return hosts;
      } catch {
        // Not that JSON: read the text form below.
      }
    }
    const text = await run("gh", ["auth", "status"], { NO_COLOR: "1" });
    fromText(`${text.stdout}\n${text.stderr}`);
    return hosts;
  }
  const status = await run("glab", ["auth", "status"], { NO_COLOR: "1" });
  fromText(`${status.stdout}\n${status.stderr}`);
  return hosts;
}

/** Fetch a small avatar and inline it. Null on any failure: the card draws the initial. */
export async function fetchAvatarDataUri(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > AVATAR_MAX_BYTES) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

// --- the cache and the fetch ---

export interface RefCards {
  /** The card for a link, or null when the link is not an issue / pull / merge request link. */
  get(href: string): Promise<ForgeRefCardResult | null>;
}

/** How much `createRefCards` holds now (tests and diagnostics). */
export interface RefCardsSizes {
  refs: number;
  retries: number;
  repoAccounts: number;
  rateLimitedHosts: number;
  avatars: number;
  avatarBytes: number;
  waiting: number;
}

/** Thrown by a full queue: answered `unavailable`, never cached. */
const QUEUE_FULL = Symbol("ref-cards queue full");

export function createRefCards(options: {
  /** How `gh` / `glab` run (Bun: `refCliRunner` in packages/server; Node: `nodeRefCliRunner`). */
  run: RefRunner;
  now?: () => number;
  /** Avatar URL → data URI (default: `fetchAvatarDataUri`). */
  avatar?: (url: string) => Promise<string | null>;
}): RefCards & { sizes(): RefCardsSizes } {
  const run = options.run;
  const now = options.now ?? Date.now;
  const avatarOf = options.avatar ?? fetchAvatarDataUri;
  const cache = new Map<string, ForgeRefCardResult>();
  const pending = new Map<string, Promise<ForgeRefCardResult>>();
  /** Avatar URL → its data URI (null: none), with the URI's size once it arrived. */
  const avatars = new Map<string, { uri: Promise<string | null>; bytes: number }>();
  let avatarBytes = 0;
  /** host/owner/repo → the env of the GitHub account that could see it. */
  const accountFor = new Map<string, Record<string, string>>();
  const rateLimitedUntil = new Map<string, number>();
  /** A stale answer whose refresh failed: not asked again before this. */
  const retryAt = new Map<string, number>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const slot = async <T>(job: () => Promise<T>): Promise<T> => {
    if (running >= REF_MAX_CONCURRENT) {
      if (waiting.length >= REF_MAX_WAITING) throw QUEUE_FULL;
      await new Promise<void>((r) => waiting.push(r));
    } else running++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };

  const dropAvatar = (_url: string, entry: { bytes: number }) => {
    avatarBytes -= entry.bytes;
  };
  const avatarUri = (url: string): Promise<string | null> => {
    const hit = avatars.get(url);
    if (hit) {
      touch(avatars, url, hit);
      return hit.uri;
    }
    const entry = { uri: avatarOf(url).catch(() => null), bytes: 0 };
    remember(avatars, url, entry, AVATAR_CACHE_MAX, dropAvatar);
    void entry.uri.then((uri) => {
      // Counted once it arrived, and only while it is still kept.
      if (!uri || avatars.get(url) !== entry) return;
      entry.bytes = uri.length;
      avatarBytes += entry.bytes;
      while (avatarBytes > AVATAR_CACHE_MAX_BYTES && avatars.size > 0) dropOldest(avatars, dropAvatar);
    });
    return entry.uri;
  };

  const inlineAvatars = async (data: ForgeRefCardData) => {
    const people = [data.author, data.lastComment?.author, ...data.assignees].filter((p): p is ForgeRefPerson => !!p?.avatarUrl);
    await Promise.all(
      people.map(async (p) => {
        p.avatarUrl = await avatarUri(p.avatarUrl!);
      }),
    );
  };

  /** Tokens of the other GitHub accounts signed in on a host, in gh's order (never logged). */
  const otherGithubAccounts = async (host: string): Promise<Record<string, string>[]> => {
    const status = await run("gh", ["auth", "status", "--hostname", host, "--json", "hosts"]);
    let accounts = status.exitCode === 0 ? parseGhAuthStatusJson(status.stdout, host) : null;
    if (!accounts) {
      const text = await run("gh", ["auth", "status", "--hostname", host], { NO_COLOR: "1" });
      accounts = parseGhAuthStatusText(`${text.stdout}\n${text.stderr}`, host);
    }
    const envs: Record<string, string>[] = [];
    for (const account of accounts) {
      if (account.active || account.state !== "success") continue;
      const token = await run("gh", ["auth", "token", "--hostname", host, "--user", account.login]);
      const value = token.exitCode === 0 ? token.stdout.trim() : "";
      if (value && !/\s/.test(value)) envs.push({ [ghTokenEnvVar(host)]: value });
    }
    return envs;
  };

  /**
   * The hosts each CLI is signed in to, read once per REF_AUTH_HOSTS_MS (a new login shows up after
   * that). No host at all (the CLI failed, timed out, or is signed in nowhere) is kept only for
   * REF_FAILURE_MS, so one slow `auth status` does not hide enterprise hosts for minutes.
   */
  const authHosts = new Map<RefCli, { at: number; ttl: number; hosts: Promise<Set<string>> }>();
  const signedInHosts = (cli: RefCli): Promise<Set<string>> => {
    const hit = authHosts.get(cli);
    if (hit && now() - hit.at < hit.ttl) return hit.hosts;
    const hosts = readSignedInHosts(run, cli).catch(() => new Set<string>());
    const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, hosts };
    authHosts.set(cli, entry);
    void hosts.then((set) => {
      if (set.size === 0) entry.ttl = REF_FAILURE_MS;
    });
    return hosts;
  };
  /** github.com and gitlab.com always; any other host only when this computer's own CLI is signed in to it. */
  const fetchesFrom = async (ref: ForgeRef): Promise<boolean> => {
    if (ref.host === (ref.platform === "github" ? "github.com" : "gitlab.com")) return true;
    return (await signedInHosts(ref.platform === "github" ? "gh" : "glab")).has(ref.host);
  };

  const fail = (error: ForgeRefCardError): ForgeRefCardResult => ({ ok: false, error, fetchedAt: now() });

  const fetchOnce = async (ref: ForgeRef): Promise<ForgeRefCardResult> => {
    if (now() < (rateLimitedUntil.get(ref.host) ?? 0)) return fail("rate_limited");
    const { cli, args } = queryArgs(ref);
    const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase();
    const known = accountFor.get(repoKey);
    if (known) touch(accountFor, repoKey, known);
    const tries: (Record<string, string> | undefined)[] = [known];
    for (let i = 0; i < tries.length; i++) {
      const result = await run(cli, args, tries[i]);
      if (result.exitCode === 0) {
        const data = ref.platform === "github" ? parseGithubRefAnswer(result.stdout) : parseGitlabRefAnswer(result.stdout, ref.host, ref.kind);
        if (data === "not_found") return fail("not_found");
        if (!data) {
          // GraphQL errors come back with exit 0 from some CLIs: read them like stderr.
          const error = refErrorOf(cli, { ...result, exitCode: 1 });
          if (error === "rate_limited") rateLimitedUntil.set(ref.host, now() + REF_RATE_LIMIT_MS);
          return fail(error === "refused" ? "not_found" : error);
        }
        if (tries[i]) remember(accountFor, repoKey, tries[i]!, REF_REPO_ACCOUNTS_MAX);
        await inlineAvatars(data);
        return { ok: true, data, fetchedAt: now() };
      }
      const error = refErrorOf(cli, result);
      if (error === "rate_limited") rateLimitedUntil.set(ref.host, now() + REF_RATE_LIMIT_MS);
      if (error !== "refused") return fail(error);
      if (ref.platform !== "github") return fail("not_found");
      // The first refusal: try each other signed-in account once.
      if (i === 0) {
        accountFor.delete(repoKey);
        if (tries[0]) tries.push(undefined);
        tries.push(...(await otherGithubAccounts(ref.host)));
      }
    }
    return fail("not_found");
  };

  /**
   * Drop what would never be served again: answers past REF_STALE_MAX_MS,
   * failures past REF_FAILURE_MS, retry holds and rate-limit pauses that are
   * over. Each is the same as no entry, so this changes no answer.
   */
  const prune = () => {
    const t = now();
    for (const [key, result] of cache) {
      if (t - result.fetchedAt >= (result.ok ? REF_STALE_MAX_MS : REF_FAILURE_MS)) cache.delete(key);
    }
    for (const [key, at] of retryAt) if (t >= at || !cache.has(key)) retryAt.delete(key);
    for (const [host, until] of rateLimitedUntil) if (t >= until) rateLimitedUntil.delete(host);
  };
  const dropRetry = (key: string) => {
    retryAt.delete(key);
  };

  const refresh = (key: string, ref: ForgeRef): Promise<ForgeRefCardResult> => {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const job = slot(() => fetchOnce(ref))
      .catch((error): ForgeRefCardResult | typeof QUEUE_FULL => (error === QUEUE_FULL ? QUEUE_FULL : fail("unavailable")))
      .then((result) => {
        const prev = cache.get(key);
        const prevShowable = prev?.ok === true && now() - prev.fetchedAt < REF_STALE_MAX_MS;
        // Too many lookups waiting: answer at once and keep nothing, so the next hover asks again.
        if (result === QUEUE_FULL) return prevShowable ? prev! : fail("unavailable");
        prune();
        // A failure never replaces an answer still worth showing; it only holds off the next refresh.
        if (!result.ok && prevShowable) {
          remember(retryAt, key, now() + REF_FAILURE_MS, REF_CACHE_MAX);
          return prev!;
        }
        retryAt.delete(key);
        remember(cache, key, result, REF_CACHE_MAX, dropRetry);
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };

  return {
    async get(href) {
      const ref = parseForgeRefUrl(href);
      if (!ref) return null;
      if (!(await fetchesFrom(ref))) return fail("unsupported");
      const key = forgeRefKey(ref);
      const hit = cache.get(key);
      if (hit) {
        touch(cache, key, hit);
        const age = now() - hit.fetchedAt;
        if (age < (hit.ok ? REF_FRESH_MS : REF_FAILURE_MS)) return hit;
        if (hit.ok && age < REF_STALE_MAX_MS) {
          if (now() >= (retryAt.get(key) ?? 0)) void refresh(key, ref);
          return hit;
        }
      }
      return refresh(key, ref);
    },
    sizes() {
      return {
        refs: cache.size,
        retries: retryAt.size,
        repoAccounts: accountFor.size,
        rateLimitedHosts: rateLimitedUntil.size,
        avatars: avatars.size,
        avatarBytes,
        waiting: waiting.length,
      };
    },
  };
}

// --- the route the plan, annotate and review servers serve ---

/** The route the plan, annotate and review servers answer (both runtimes). The Inbox has its own `/api/inbox/ref`. */
export const REF_CARD_ROUTE = "/api/ref";
export const REF_CARD_URL_MAX = 2048;

export interface RefCardRouteRequest {
  method: string;
  /** The `url` query parameter (the link), or null. */
  href: string | null;
  origin: string | null;
  host: string;
  secFetchSite: string | null;
  /**
   * False when the session is reachable beyond this computer (remote mode) or
   * the request came from another device (a `--tailscale` session lets only
   * this machine's tabs and the tailnet owner's through): the lookups run with
   * the user's own gh / glab credentials, so a peer must never drive them.
   */
  enabled: boolean;
}

export interface RefCardRouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * `GET /api/ref?url=<issue, PR or MR link>`, answered the way the Inbox's
 * `/api/inbox/ref` is: `{ ok: true, data, fetchedAt }` or `{ ok: false, error,
 * fetchedAt }`. Refusals, in order: `404 ref_cards_disabled` when the session
 * is exposed or the request came from another device, `405` for anything but GET, `403 cross_origin` for another
 * site's page, `422 validation_error` for a url that is not such a link (or
 * over 2048 characters). Nothing runs for a refusal.
 */
export async function handleRefCardRoute(req: RefCardRouteRequest, cards: RefCards): Promise<RefCardRouteAnswer> {
  if (!req.enabled) {
    return { status: 404, body: { error: "Hover cards are off for this session or device.", code: "ref_cards_disabled" } };
  }
  if (req.method !== "GET") return { status: 405, body: { error: "Use GET." } };
  if (!isSameOriginOrNoOrigin(req.origin, req.host, req.secFetchSite)) {
    return { status: 403, body: { error: "Cross-origin requests are not accepted.", code: "cross_origin" } };
  }
  const href = req.href ?? "";
  const invalid = { status: 422, body: { error: "url: an https link to an issue, pull request or merge request.", code: "validation_error", field: "url" } };
  if (href.length > REF_CARD_URL_MAX) return invalid;
  const result = await cards.get(href);
  if (!result) return invalid;
  return { status: 200, body: { ...result } };
}
