/**
 * Branch reviews (the owner's design, 2026-11-16, thread "Plannotator Inbox Reviews"): an agent that finished work on
 * a branch tells the Inbox it is ready for review (`send_message` with `branch`, only while config.json
 * `inboxBranchReviews` and Code review are on). The report opens, or adds to, one review thread per project and branch,
 * listed in Reviews as a local branch, another computer's branch or a cloud agent's branch. Nothing about it is timed:
 * risk runs once per reported head, only with the person's own switch on, and the person starts the guided review.
 *
 * Browser-safe: the server, the window and the tests read the same rules here.
 */

import { parseInboxGitUrl } from "./inbox-git-url";
import { inboxPullIsOpen, inboxPullLongLived, inboxPullRepoKey, inboxPullSafeBranch, type InboxPull } from "./inbox-pulls";
import type { InboxPullRiskJudgment } from "./inbox-pull-risk";
import type { InboxReviewRow } from "./inbox-reviews";

/** Where the reported branch lives, as the Inbox that took the report saw it. */
export type InboxBranchPlace =
  /** An agent on this computer reported it: its checkout is here. */
  | "here"
  /** A paired cloud agent reported it through the agent door: the code is wherever it pushed it, if anywhere. */
  | "cloud";

/** One report, the latest per project and branch (`inbox/branch-reports.json`). */
export interface InboxBranchReport {
  /** The project's canonical id. */
  project_id: string;
  branch: string;
  /** The branch it is compared with (merge-base): what the agent said, else the repository's default branch. */
  base: string | null;
  /** The commit reported. Null only when it could not be read and the agent named none. */
  head: string | null;
  place: InboxBranchPlace;
  /** Where a cloud agent pushed it (an https or ssh remote), when it said. */
  remote_url: string | null;
  /** The agent's one line, when it gave one. */
  summary: string | null;
  thread_id: string;
  /** The message that carried the latest report. */
  message_id: string;
  /** The latest report, and the first one. */
  at: string;
  first_at: string;
  /** How many reports with a new head this thread took. */
  reports: number;
  agent: { host: string | null; session: string | null; name: string | null } | null;
  /** The folder git was read in (the agent's working folder, else the project's): where its diff is read again. */
  folder?: string | null;
}

/** The `branch` field of a send, checked. */
export interface InboxBranchField {
  name: string;
  base?: string;
  head?: string;
  remote_url?: string;
  summary?: string;
}

export const INBOX_BRANCH_SUMMARY_MAX = 200;
export const INBOX_BRANCH_REPORTS_MAX = 500;
/** "On this computer"'s window: a branch with no commit for this long is not listed. */
export const INBOX_UNREPORTED_BRANCH_DAYS = 14;
/** The most branches a read lists per project, newest first ("On this computer" asks for fewer). */
export const INBOX_UNREPORTED_BRANCHES_MAX = 30;

const HEAD = /^[0-9a-f]{7,64}$/i;

/** The report's key: one thread per project and branch. */
export function inboxBranchReportKey(projectId: string, branch: string): string {
  return `${projectId}\u0000${branch}`;
}

/** The risk store's key for a reported branch (`pull-risk.json`), beside the PRs' keys. */
export function inboxBranchRiskKey(projectId: string, branch: string): string {
  return `branch:${projectId}:${branch}`;
}

/** A `branch` field, checked: the words of what is wrong (`branch.name: …`) or the field. */
export function checkInboxBranchField(value: unknown): InboxBranchField | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "branch: { name, base?, head?, remote_url?, summary? }.";
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).find((key) => !["name", "base", "head", "remote_url", "summary"].includes(key));
  if (extra) return `branch.${extra}: not a field. branch takes name, base, head, remote_url and summary.`;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || !inboxPullSafeBranch(name)) return "branch.name: the branch's name (letters, digits and ._/- only).";
  if (name === "HEAD") return INBOX_BRANCH_NAME_NOT_BASE;
  const out: InboxBranchField = { name };
  if (raw.base !== undefined) {
    const base = typeof raw.base === "string" ? raw.base.trim() : "";
    if (!base || !inboxPullSafeBranch(base)) return "branch.base: the branch it is compared with (letters, digits and ._/- only).";
    if (base === name) return "branch.base: another branch than branch.name.";
    out.base = base;
  }
  if (raw.head !== undefined) {
    if (typeof raw.head !== "string" || !HEAD.test(raw.head.trim())) return "branch.head: the commit's id (7 to 64 hex characters).";
    out.head = raw.head.trim().toLowerCase();
  }
  if (raw.remote_url !== undefined) {
    const url = typeof raw.remote_url === "string" && raw.remote_url.length <= 2000 ? inboxBranchRemoteUrl(raw.remote_url) : null;
    if (!url) return "branch.remote_url: the git remote it was pushed to (an https or ssh URL).";
    out.remote_url = url;
  }
  if (raw.summary !== undefined) {
    const summary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").trim() : "";
    if (!summary) return "branch.summary: one line, or leave it out.";
    out.summary = Array.from(summary).slice(0, INBOX_BRANCH_SUMMARY_MAX).join("");
  }
  return out;
}

/**
 * A reported remote as kept and shown: the URL rebuilt from its parts (https or ssh only; an https URL's user,
 * password, query and fragment dropped), never the text as typed. Null: not a repository's URL. The window and a
 * linked machine's rows read it again the same way.
 */
export function inboxBranchRemoteUrl(text: string): string | null {
  const read = parseInboxGitUrl(text);
  return read && read.kind === "repo" ? read.url : null;
}

/** `host/owner/repo` of a reported remote, for the words: plain text, never a link. */
export function inboxBranchRemoteWords(url: string | null): string | null {
  const read = url ? parseInboxGitUrl(url) : null;
  return read && read.kind === "repo" ? `${read.host}/${read.slug}` : null;
}

/** What a second report does: the same head changes nothing; a new one adds to the same thread. */
export function inboxBranchReportStep(existing: Pick<InboxBranchReport, "head"> | null, head: string | null): "new" | "same" | "update" {
  if (!existing) return "new";
  if (head !== null && existing.head !== null && sameCommit(existing.head, head)) return "same";
  return "update";
}

/** Two commit ids name one commit: one may be the other's short form. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/**
 * The PRs a reported branch's thread owns: the person's own open PR, or the merged one that is this report's work, from the repository itself (not a fork) whose head
 * branch is the reported branch, in a repository that is the report's project, never a long-lived branch. So a branch
 * reviewed before its PR and its PR stay one thread (the same rule `inboxReviewIsOf` reads from a review's source).
 * `projectsByRepo`: `host/repo` (lowercased) → the projects on it.
 */
export function inboxBranchReportOwners(
  reports: Iterable<Pick<InboxBranchReport, "project_id" | "branch" | "thread_id" | "head" | "at">>,
  pulls: Iterable<InboxPull>,
  projectsByRepo: ReadonlyMap<string, readonly string[]>,
  contains?: InboxBranchContains,
): Map<string, { thread_id: string }> {
  const byBranch = new Map<string, Pick<InboxBranchReport, "project_id" | "branch" | "thread_id" | "head" | "at">[]>();
  for (const report of reports) {
    if (inboxPullLongLived(report.branch)) continue;
    byBranch.set(report.branch, [...(byBranch.get(report.branch) ?? []), report]);
  }
  const owners = new Map<string, { thread_id: string }>();
  for (const pull of pulls) {
    if (!(inboxPullIsOpen(pull) || pull.state === "merged") || !pull.mine) continue;
    if (pull.head_repo !== null && pull.head_repo.toLowerCase() !== pull.repo.toLowerCase()) continue;
    const projects = projectsByRepo.get(inboxPullRepoKey(pull.host, pull.repo)) ?? [];
    const report = byBranch.get(pull.head)?.find((one) => projects.includes(one.project_id));
    // A merged one only when it is this report's work (the thread then lands and leaves Reviews). A name reused for new
    // work, work reported after the merge, or a reported commit the merge did not contain, is not that PR's.
    if (report && pull.state === "merged" && !inboxBranchReportMerged(report, pull, contains)) continue;
    if (report) owners.set(pull.key, { thread_id: report.thread_id });
  }
  return owners;
}

/** Whether git here proves `head` is contained in `merged` (an ancestor of it, or it): false when it can't say. */
export type InboxBranchContains = (report: Pick<InboxBranchReport, "project_id" | "branch" | "head">, merged: string) => boolean;

/**
 * A merged PR is the report's own work. Its merged commit known: it is the reported commit, or git here proves the
 * reported commit is contained in it (`contains`); anything else is newer work than what merged, and keeps its row.
 * Unknown: it merged after the latest report.
 */
export function inboxBranchReportMerged(
  report: Pick<InboxBranchReport, "project_id" | "branch" | "head" | "at">,
  pull: Pick<InboxPull, "head_sha" | "merged_at">,
  contains?: InboxBranchContains,
): boolean {
  if (pull.head_sha) return !!report.head && (sameCommit(pull.head_sha, report.head) || contains?.(report, pull.head_sha) === true);
  const merged = pull.merged_at ? Date.parse(pull.merged_at) : NaN;
  return !Number.isNaN(merged) && merged > Date.parse(report.at);
}

/** A reported branch as Reviews shows it: on a row and in its thread. */
export interface InboxBranchReportRow {
  thread_id: string;
  project_id: string;
  branch: string;
  base: string | null;
  head: string | null;
  place: InboxBranchPlace;
  remote_url: string | null;
  summary: string | null;
  at: string;
  reports: number;
  agent: InboxBranchReport["agent"];
  /** The head is a commit in a checkout of the project on the computer that took the report. */
  reachable: boolean;
  /** A cloud agent's remote is the origin of a project on the computer that took the report. */
  remote_known?: boolean;
  /** This computer's git is older than the branch reads need (2.31), so none of them ran. */
  git_too_old?: true;
  /** Its risk can be ranked now by hand: risk is on, the commit is here (pushed, for a cloud agent's) and no judgment is kept or under way at this head under today's rules. */
  rankable?: boolean;
  /** Its risk, once judged at this head (never Low from nothing: no judgment, no mark). */
  risk: InboxPullRiskJudgment | null;
  /** Why ranking failed at this head, when it did. */
  risk_failed: string | null;
  /** A linked machine's report, read through its door: that machine, by id and name. Absent: this computer's. */
  machine?: { id: string; name: string | null };
}

/** `GET /api/inbox/reviews/branches`: this computer's reported branches (a linked machine reads them through the door). */
export interface InboxBranchReportsAnswer {
  reports: InboxBranchReportRow[];
}

/** A local branch nobody reported (Reviews' "On this computer", server/inbox-local-work.ts). Nothing runs on it. */
export interface InboxUnreportedBranch {
  project_id: string;
  branch: string;
  /** The default branch it is ahead of. */
  base: string;
  /** Commits on it that are not on the base. */
  ahead: number;
  /** Its last commit (ISO). */
  last_commit_at: string;
  /** The folder of the worktree it is checked out in, when one is. */
  worktree: string | null;
}

/** The mark's words: what kind of branch a row is. */
export function inboxBranchPlaceWords(row: Pick<InboxBranchReportRow, "place" | "machine">): string {
  if (row.machine) return row.machine.name ? `Branch on ${row.machine.name}` : "Branch on another computer";
  return row.place === "cloud" ? "Cloud agent’s branch" : "Local branch";
}

/**
 * What the thread says about opening the code, when it can't be opened here: a linked machine's branch is reviewed
 * there; a cloud agent's branch needs pushing, or fetching into a checkout here. Null: the code is here.
 */
export function inboxBranchReachWords(row: Pick<InboxBranchReportRow, "place" | "machine" | "reachable" | "remote_url" | "branch" | "remote_known" | "git_too_old">): string | null {
  if (row.machine) return `This branch is on ${row.machine.name ?? "another computer"}. Its review runs there: start it from this thread, and an agent on that computer writes it.`;
  if (row.reachable) return null;
  if (row.git_too_old) return "This computer's git is too old to read branches safely.";
  if (row.place === "cloud") {
    // What the agent says, never a link: the person decides whether it is their repository.
    const where = inboxBranchRemoteWords(row.remote_url);
    if (!where) return `This computer doesn't have ${row.branch}. Ask the agent to push it, then fetch it here.`;
    const unknown = row.remote_known === false ? " (not the origin of any project here)" : "";
    return `The agent says it pushed it to ${where}${unknown}. If that is your repository, fetch ${row.branch} into the project's checkout here.`;
  }
  return `The commit reported for ${row.branch} isn't in the project's checkout on this computer any more.`;
}

/** A shortened commit id for the words. */
export function inboxShortCommit(head: string | null): string {
  return head ? head.slice(0, 7) : "";
}

// AGENT TEXT (Branch reviews): every word below reaches an agent only while config.json `inboxBranchReviews` and Code
// review are on. It awaits the owner's word-for-word OK and a clean-room test before it ships
// (.ops/handoff/branch-ready-agent-text.md, outside this repo).

/** send_message's `branch` field: when to report, and what each part is. */
export const INBOX_BRANCH_FIELD_DESCRIPTION =
  "Only when you have finished work on a branch and it is ready for the person to review (never on each commit): the branch, so the Inbox opens one review thread for it in this project. Report again after more work on it and the same thread takes it. `name`: the branch. `base`: what it is compared with (default: the repository's default branch). `head`: the commit (default: the branch's tip). `remote_url`: the repository's URL where you pushed it, never one with a password in it, when the person's computer may not have it. `summary`: one line on what it does.";

/** The send's result line after a report with a new head. */
export function inboxBranchReportedLine(branch: string, head: string | null, update: boolean): string {
  const at = head ? ` at ${head.slice(0, 7)}` : "";
  return update ? ` Branch ${branch}${at} reported again: the person sees it in the same review thread.` : ` Branch ${branch}${at} reported ready for review: the person sees it in Reviews.`;
}

/** The answer to a report of a head already reported: nothing is sent. */
export function inboxBranchSameLine(branch: string, head: string | null, threadId: string): string {
  return `Already reported ${branch}${head ? ` at ${head.slice(0, 7)}` : ""} (thread ${threadId}): nothing was sent. Report it again after more work on it.`;
}

/** A report from a cloud agent with no `head`: a cloud agent's report never reads a branch's tip here. */
export const INBOX_BRANCH_HEAD_NEEDED = "branch.head: the commit you pushed (required for a cloud agent).";

/** A report naming `HEAD` or the repository's default branch: a review thread is one work branch's. */
export const INBOX_BRANCH_NAME_NOT_BASE = "branch.name: the branch your work is on, not HEAD or the repository's default branch.";

/** A report while the person has Branch reviews off (it went off during the call): nothing is sent. */
export const INBOX_BRANCH_REVIEWS_OFF_TEXT = "branch_reviews_off: Branch reviews are off in this Inbox, so nothing was sent. Send your message without `branch`.";

/**
 * A linked machine's reported branch as a Reviews row here: its thread lives on that machine (opened through the
 * merged list), On you until a review is asked for there. What happens in that thread later is that machine's: this
 * row shows the report.
 */
export function inboxFarBranchReviewRow(row: InboxBranchReportRow): InboxReviewRow {
  return {
    id: row.thread_id,
    reviewed: true,
    move: "on_you",
    reason: "branch_ready",
    thread_id: row.thread_id,
    review: null,
    stacks: [],
    pull_keys: [],
    link: null,
    pull_reason: null,
    landed: [],
    updated_at: row.at,
    started: { kind: "branch", changes: "branch", branch: row.branch, base: row.base, ask: "guide", host: row.agent?.host ?? "", project_id: row.project_id, at: row.at, name: null, report: row },
  };
}
