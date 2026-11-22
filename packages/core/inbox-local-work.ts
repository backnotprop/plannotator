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
}

/** `GET /api/inbox/reviews/local`. */
export interface InboxLocalWorkAnswer {
  items: InboxLocalWork[];
  /** Projects whose folder is here but whose git could not be read in time: not "nothing". */
  unread: number;
}

/** `GET /api/inbox/reviews/local/diff?project=&branch=` (no branch: the uncommitted changes). */
export interface InboxLocalDiffAnswer {
  project_id: string;
  kind: "branch" | "uncommitted";
  branch: string | null;
  /** What the patch is against: the default branch (a branch's whole diff), or `HEAD`. */
  base: string;
  patch: string;
}

/** A row's words: the branch, or "Uncommitted on main" (on its short commit id when detached; "Uncommitted changes" with no commit). */
export function inboxLocalWorkLabel(work: Pick<InboxLocalWork, "kind" | "branch">): string {
  if (work.kind === "branch") return work.branch ?? "";
  return work.branch ? `Uncommitted on ${work.branch}` : "Uncommitted changes";
}

/** The row's key, also its address part (`&local=<project>&branch=<name>`; no branch: uncommitted). */
export function inboxLocalWorkKey(work: Pick<InboxLocalWork, "project_id" | "kind" | "branch">): string {
  return work.kind === "branch" ? `${work.project_id}\u0000${work.branch ?? ""}` : `${work.project_id}\u0000`;
}
