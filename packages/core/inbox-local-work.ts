/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2): the work on this computer that is in no
 * pull request, beside the PRs in the one list. For each Inbox project: its local branches with commits not on the
 * default branch and no open PR, and its folder's uncommitted changes. A click opens that work's diff, read only; no
 * agent is involved. Read by the window only (`GET /api/inbox/reviews/local`, `GET /api/inbox/reviews/local/diff`;
 * packages/server/inbox-local-work.ts).
 */

/** One row: a branch's work, or a folder's uncommitted changes. */
export interface InboxLocalWork {
  project_id: string;
  kind: "branch" | "uncommitted";
  /**
   * A branch row: the branch. An uncommitted row: the branch checked out in the project's folder, or the short commit
   * id when its HEAD is detached; null in a repository with no commit yet.
   */
  branch: string | null;
  /** The default branch a branch row's diff is against; null on an uncommitted row. */
  base: string | null;
  /** The last commit (a branch row) or the newest change to a changed file (an uncommitted row), ISO. */
  at: string;
  /** A branch row: its commits not on `base` (an older Inbox: absent). An uncommitted row: null. */
  ahead?: number | null;
}

/** `GET /api/inbox/reviews/local`. */
export interface InboxLocalWorkAnswer {
  items: InboxLocalWork[];
  /**
   * Repositories here whose branches git could not read in time (once each, however many projects reach one): not
   * "nothing". Uncommitted changes git can't read are no row, never counted here.
   */
  unread: number;
  /**
   * Projects whose repository's branches git could not read: what a one-project list says could not be read for, never
   * "nothing". An older Inbox: absent.
   */
  unread_projects?: string[];
  /**
   * Projects read whose repository has no row at all (no branch with work of its own, no uncommitted change): what a
   * one-project list says "nothing" for. An older Inbox: absent.
   */
  quiet?: string[];
  /** Projects read whose folder is no git repository on this computer (or is gone). An older Inbox: absent. */
  not_git?: string[];
}

/** `GET /api/inbox/reviews/local/diff?project=&branch=` (no branch: the uncommitted changes). */
export interface InboxLocalDiffAnswer {
  project_id: string;
  kind: "branch" | "uncommitted";
  branch: string | null;
  /** What the patch is against: the default branch (a branch's whole diff), or `HEAD`. */
  base: string;
  patch: string;
  /** A branch's commits not on `base` (null: uncommitted changes, or git couldn't count them; an older Inbox: absent). */
  ahead?: number | null;
}

/** A row's words: the branch, or "Uncommitted on main" (on its short commit id when detached; "Uncommitted changes" with no commit). */
export function inboxLocalWorkLabel(work: Pick<InboxLocalWork, "kind" | "branch">): string {
  if (work.kind === "branch") return work.branch ?? "";
  return work.branch ? `Uncommitted on ${work.branch}` : "Uncommitted changes";
}

/** The row's key: `<project id>:<branch>`, or `<project id>:` for its uncommitted changes (git allows no `:` in a branch). */
export function inboxLocalWorkKey(work: Pick<InboxLocalWork, "project_id" | "kind" | "branch">): string {
  return `${work.project_id}:${work.kind === "branch" ? (work.branch ?? "") : ""}`;
}
