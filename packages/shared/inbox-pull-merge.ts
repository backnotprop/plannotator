/**
 * Merge from the Inbox's Pull requests page (approval "inbox-pr-dashboard", the owner's answer on q-f71fc8d1): the tile
 * popover's Merge, offered only when the forge says the pull request can merge, and sent only after a second click.
 *
 * The rules here are the guard the server runs before it merges, asked of the forge at that moment (never the list's
 * minute-old answer):
 * - the PR is still open, not a draft, and its head is the commit the person saw (a push since is refused);
 * - GitHub: `mergeable` is true and `mergeable_state` is `clean`, `unstable` (a check that isn't required failed) or
 *   `has_hooks`; anything else (`blocked`, `behind`, `dirty`, `draft`, `unknown`) is the forge saying not now;
 * - GitLab: `detailed_merge_status` is `mergeable`.
 *
 * The merge itself uses the repository's own method: GitHub has no default, so the first the repository allows in the
 * order GitHub's own button offers them (merge commit, squash, rebase); GitLab's merge request merges as its project
 * says. The head commit is pinned (`sha`), so the forge refuses if it moved between the check and the merge.
 *
 * No Bun or Node API: a `RefRunner` runs the person's own `gh` / `glab`. Inbox-only (the Pi server has no Inbox).
 */

import type { RefCli, RefCommandResult, RefRunner } from "./ref-cards";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a merge needs to know of the pull request, as the list read it. */
export interface PullMergeTarget {
  platform: "github" | "gitlab";
  host: string;
  /** `owner/repo` (GitLab: the project's full path). */
  repo: string;
  number: number;
}

/** The forge's answer, now, about whether the PR can merge. */
export interface PullMergeState {
  open: boolean;
  draft: boolean;
  /** The head commit the forge names now; null when it did not say. */
  head_sha: string | null;
  /** GitHub: `mergeable` (null while GitHub is still working it out); GitLab: `detailed_merge_status === "mergeable"`. */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state` or GitLab's `detailed_merge_status`, as the forge wrote it. */
  detail: string;
}

export type PullMergeMethod = "merge" | "squash" | "rebase";

export type PullMergeRefusal =
  | "pull_closed"
  | "pull_draft"
  | "pull_moved"
  | "pull_not_mergeable"
  | "pull_merge_unknown"
  | "pull_merge_failed"
  | "pull_merge_method";

export type PullMergeResult = { ok: true; method: PullMergeMethod | null; sha: string } | { ok: false; code: PullMergeRefusal; message: string };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const shaOf = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v.toLowerCase() : null);

/** GitHub's `GET repos/{o}/{r}/pulls/{n}` as the state a merge is judged on. */
export function githubMergeStateOf(stdout: string): PullMergeState | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!raw.state) return null;
  return {
    open: raw.state === "open" && !raw.merged_at,
    draft: raw.draft === true,
    head_sha: shaOf(obj(raw.head).sha),
    mergeable: typeof raw.mergeable === "boolean" ? raw.mergeable : null,
    detail: str(raw.mergeable_state).toLowerCase(),
  };
}

/** GitLab's `GET projects/{id}/merge_requests/{iid}` as the state a merge is judged on. */
export function gitlabMergeStateOf(stdout: string): PullMergeState | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!raw.state) return null;
  const detail = str(raw.detailed_merge_status).toLowerCase();
  return {
    open: raw.state === "opened",
    draft: raw.draft === true || raw.work_in_progress === true,
    head_sha: shaOf(raw.sha) ?? shaOf(obj(raw.diff_refs).head_sha),
    mergeable: detail ? detail === "mergeable" : null,
    detail,
  };
}

/** GitHub's `mergeable_state` values its own Merge button takes. */
const GITHUB_MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);

/** Plain words for why the forge won't merge it now. */
function notNowWords(platform: PullMergeTarget["platform"], detail: string): string {
  const forge = platform === "gitlab" ? "GitLab" : "GitHub";
  const why: Record<string, string> = {
    blocked: "a required review or check hasn't passed",
    behind: "the branch is behind its base",
    dirty: "it conflicts with its base branch",
    draft: "it is a draft",
    unknown: "it is still working out whether it can",
    conflict: "it conflicts with its base branch",
    ci_must_pass: "its pipeline must pass first",
    ci_still_running: "its pipeline is still running",
    discussions_not_resolved: "its threads aren't resolved",
    not_approved: "it needs approval",
    need_rebase: "it needs a rebase",
    checking: "it is still working out whether it can",
    unchecked: "it is still working out whether it can",
    blocked_status: "another merge request blocks it",
    draft_status: "it is a draft",
    requested_changes: "a reviewer asked for changes",
    jira_association_missing: "it needs a Jira issue",
  };
  return `${forge} won't merge it now: ${why[detail] ?? (detail ? detail.replace(/_/g, " ") : "it didn't say why")}.`;
}

/**
 * The merge guard: may this PR merge now, at the head the person saw? The forge's answer (`state`) decides; null when
 * the forge could not be read. Pure: the one rule the route and its tests share.
 */
export function pullMergeVerdict(platform: PullMergeTarget["platform"], state: PullMergeState | null, seenHead: string): { ok: true } | { ok: false; code: PullMergeRefusal; message: string } {
  if (!state) return { ok: false, code: "pull_merge_unknown", message: `Couldn't ask ${platform === "gitlab" ? "GitLab" : "GitHub"} whether it can merge. Try again.` };
  if (!state.open) return { ok: false, code: "pull_closed", message: "That pull request is no longer open." };
  if (state.draft) return { ok: false, code: "pull_draft", message: "It is a draft: mark it ready for review first." };
  if (!state.head_sha || state.head_sha !== seenHead.toLowerCase()) return { ok: false, code: "pull_moved", message: "It has new commits since you looked. Look again before you merge." };
  const can = platform === "github" ? state.mergeable === true && GITHUB_MERGEABLE.has(state.detail) : state.mergeable === true;
  if (!can) return { ok: false, code: "pull_not_mergeable", message: notNowWords(platform, state.detail || (state.mergeable === false ? "dirty" : "unknown")) };
  return { ok: true };
}

/** GitHub's `GET repos/{o}/{r}`: the first merge method the repository allows, in the order of GitHub's own button. */
export function githubMergeMethodOf(stdout: string): PullMergeMethod | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (raw.allow_merge_commit === true) return "merge";
  if (raw.allow_squash_merge === true) return "squash";
  if (raw.allow_rebase_merge === true) return "rebase";
  // An answer that names none (a token that can't read the settings): GitHub's own default.
  if (raw.allow_merge_commit === undefined && raw.allow_squash_merge === undefined && raw.allow_rebase_merge === undefined && raw.full_name) return "merge";
  return null;
}

function splitRepo(repo: string): { owner: string; name: string } | null {
  const at = repo.lastIndexOf("/");
  if (at <= 0 || at === repo.length - 1) return null;
  return { owner: repo.slice(0, at), name: repo.slice(at + 1) };
}

function forgeMessage(result: RefCommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  // `gh api` prints the forge's JSON `message` on stdout and "gh: <message> (HTTP 405)" on stderr.
  try {
    const message = str(obj(JSON.parse(result.stdout)).message);
    if (message) return message;
  } catch {
    // Not JSON: the text as it came.
  }
  const line = text.split("\n").map((l) => l.replace(/^(gh|glab):\s*/, "").trim()).find(Boolean);
  return line ? line.slice(0, 300) : "The forge refused the merge.";
}

/** Read the forge's answer now. Null when it could not be read. */
export async function readPullMergeState(run: RefRunner, pull: PullMergeTarget): Promise<PullMergeState | null> {
  const cli: RefCli = pull.platform === "gitlab" ? "glab" : "gh";
  if (pull.platform === "github") {
    const parts = splitRepo(pull.repo);
    if (!parts) return null;
    const read = await run(cli, ["api", "--hostname", pull.host, `repos/${parts.owner}/${parts.name}/pulls/${pull.number}`]).catch(() => null);
    return read && read.exitCode === 0 ? githubMergeStateOf(read.stdout) : null;
  }
  const read = await run(cli, ["api", "--hostname", pull.host, `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`]).catch(() => null);
  return read && read.exitCode === 0 ? gitlabMergeStateOf(read.stdout) : null;
}

/**
 * Merge a pull request the person confirmed, at the head they saw: the guard first (`pullMergeVerdict`, asked of the
 * forge now), then the merge with that head pinned. Never throws.
 */
export async function mergePull(run: RefRunner, pull: PullMergeTarget, seenHead: string): Promise<PullMergeResult> {
  const state = await readPullMergeState(run, pull);
  const verdict = pullMergeVerdict(pull.platform, state, seenHead);
  if (!verdict.ok) return verdict;
  const sha = state!.head_sha!;
  if (pull.platform === "github") {
    const parts = splitRepo(pull.repo)!;
    const settings = await run("gh", ["api", "--hostname", pull.host, `repos/${parts.owner}/${parts.name}`]).catch(() => null);
    const method = settings && settings.exitCode === 0 ? githubMergeMethodOf(settings.stdout) : null;
    if (!method) return { ok: false, code: "pull_merge_method", message: "Couldn't read which merge method the repository allows. Merge it on GitHub." };
    const merged = await run("gh", ["api", "--hostname", pull.host, "-X", "PUT", `repos/${parts.owner}/${parts.name}/pulls/${pull.number}/merge`, "-f", `merge_method=${method}`, "-f", `sha=${sha}`]).catch(() => null);
    if (!merged) return { ok: false, code: "pull_merge_failed", message: "The merge didn't go: gh didn't answer." };
    if (merged.exitCode !== 0) return { ok: false, code: "pull_merge_failed", message: forgeMessage(merged) };
    return { ok: true, method, sha };
  }
  const merged = await run("glab", ["api", "--hostname", pull.host, "-X", "PUT", `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}/merge`, "-f", `sha=${sha}`]).catch(() => null);
  if (!merged) return { ok: false, code: "pull_merge_failed", message: "The merge didn't go: glab didn't answer." };
  if (merged.exitCode !== 0) return { ok: false, code: "pull_merge_failed", message: forgeMessage(merged) };
  return { ok: true, method: null, sha };
}
