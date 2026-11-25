/**
 * One PR read straight from its forge by number, for a page still open on it that no list names any more (merged,
 * closed, a reload or a restart of this Inbox since): `InboxPulls.pull`. A merged or closed PR is still readable
 * there. What is not read here (checks, reviews) is left unknown rather than shown from an old read.
 */
import type { InboxPull, InboxPullPlatform, InboxPullState } from "@plannotator/core/inbox-types";
import { refErrorOf, type RefCli, type RefRunner } from "./ref-cards";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The PR's state as the forge says it now (GitHub's `state` + `merged`, GitLab's `state`), or null. */
export function forgePullState(platform: InboxPullPlatform, answer: Json): InboxPullState | null {
  const state = str(answer.state)?.toLowerCase() ?? null;
  if (platform === "github") {
    if (state === "open") return answer.draft === true ? "draft" : "open";
    if (state === "closed") return answer.merged === true || str(answer.merged_at) ? "merged" : "closed";
    return null;
  }
  if (state === "opened") return answer.draft === true || answer.work_in_progress === true ? "draft" : "open";
  if (state === "merged") return "merged";
  if (state === "closed" || state === "locked") return "closed";
  return null;
}

/** GitHub's fields this reads, as one JSON line (`tojson`: gh prints an object raw only then). */
export const FORGE_PULL_JQ =
  "{number: .number, html_url: .html_url, title: .title, user: {login: .user.login}, state: .state, merged: .merged, merged_at: .merged_at, draft: .draft, base: {ref: .base.ref}, head: {ref: .head.ref, sha: .head.sha, repo: {full_name: .head.repo.full_name}}, additions: .additions, deletions: .deletions, changed_files: .changed_files, updated_at: .updated_at, requested_reviewers: [.requested_reviewers[]?.login], body: .body} | tojson";

/** The PR as an `InboxPull`, from the forge's answer; `was` (the last copy kept) fills what the forge does not say. */
export function forgePullOf(platform: InboxPullPlatform, host: string, repo: string, number: number, answer: Json, was: InboxPull | null): InboxPull | null {
  const state = forgePullState(platform, answer);
  if (!state) return null;
  const github = platform === "github";
  const head = obj(answer.head);
  const title = str(answer.title) ?? was?.title ?? `#${number}`;
  const url = str(github ? answer.html_url : answer.web_url) ?? was?.url ?? "";
  const author = str(github ? obj(answer.user).login : obj(answer.author).username) ?? was?.author ?? null;
  const reviewers = github
    ? (Array.isArray(answer.requested_reviewers) ? answer.requested_reviewers : []).flatMap((r) => str(r) ?? [])
    : (Array.isArray(answer.reviewers) ? answer.reviewers : []).flatMap((r) => str(obj(r).username) ?? []);
  return {
    key: `${host}/${repo}#${number}`,
    platform,
    host,
    repo,
    number,
    url,
    title,
    author,
    mine: was?.mine ?? false,
    requested: was?.requested ?? false,
    state,
    base: str(github ? obj(answer.base).ref : answer.target_branch) ?? was?.base ?? "",
    head: str(github ? head.ref : answer.source_branch) ?? was?.head ?? "",
    head_repo: github ? (str(obj(head.repo).full_name) ?? was?.head_repo ?? null) : (was?.head_repo ?? null),
    head_sha: str(github ? head.sha : answer.sha) ?? was?.head_sha ?? null,
    additions: github ? num(answer.additions) : (was?.additions ?? 0),
    deletions: github ? num(answer.deletions) : (was?.deletions ?? 0),
    files: github ? num(answer.changed_files) : (was?.files ?? 0),
    // Not read here: an old answer would read as current.
    review: null,
    approved_by: null,
    reviewers,
    checks: null,
    ...(was?.default_branch ? { default_branch: was.default_branch } : {}),
    updated_at: str(answer.updated_at) ?? was?.updated_at ?? new Date(0).toISOString(),
    merged_at: str(answer.merged_at) ?? null,
  };
}

/**
 * What a read of one PR found: the PR; `missing` (the forge answered that it has no such PR: deleted with its
 * repository, or no longer visible to this login); or `unreadable` (the forge did not answer: offline, signed out,
 * down, an answer that is not a PR), which says nothing of the PR. `limited`: the forge asked to slow down (its
 * rate limit), so the host is held as the list's reads are; the route never sends it.
 */
export type ForgePullRead = { pull: InboxPull | null; unreadable?: true; missing?: true; limited?: true };

/**
 * The forge said it has no such PR, in the CLI's own shape (gh's `gh: Not Found (HTTP 404)`, glab's `404 Not Found`
 * or GitLab's `404 Project Not Found`), never a bare number: a PR numbered 404, or a repository called error-404-page
 * in a network error's URL, is not a 404 (as `refErrorOf` reads a 429).
 */
export const saysNotFound = (text: string): boolean => /\bHTTP 404\b|\(404\)|\b404 (?:\w+ )?Not Found\b/i.test(text);

/** Read one PR from the forge. */
export async function readForgePull(run: RefRunner, cli: RefCli, platform: InboxPullPlatform, host: string, repo: string, number: number, was: InboxPull | null): Promise<ForgePullRead> {
  const slash = repo.indexOf("/");
  if (slash <= 0) return { pull: null };
  const endpoint = platform === "github" ? `repos/${repo}/pulls/${number}` : `projects/${encodeURIComponent(repo)}/merge_requests/${number}`;
  const read = await run(cli, ["api", "--hostname", host, endpoint, ...(platform === "github" ? ["--jq", FORGE_PULL_JQ] : [])]).catch(() => null);
  if (!read) return { pull: null, unreadable: true };
  if (read.exitCode !== 0) {
    if (refErrorOf(cli, read) === "rate_limited") return { pull: null, unreadable: true, limited: true };
    return saysNotFound(`${read.stderr}\n${read.stdout}`) ? { pull: null, missing: true } : { pull: null, unreadable: true };
  }
  try {
    const pull = forgePullOf(platform, host, repo, number, obj(JSON.parse(read.stdout)), was);
    return pull ? { pull } : { pull: null, unreadable: true };
  } catch {
    return { pull: null, unreadable: true };
  }
}
