/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2): the work on this computer that is in no
 * pull request, beside the PRs in the one list. For each Inbox project: its local branches with commits not on the
 * default branch and no open PR, and its folder's uncommitted changes. A click opens that work's diff, read only; no
 * agent is involved. Read by the window only (`GET /api/inbox/reviews/local`, `GET /api/inbox/reviews/local/diff`;
 * packages/server/inbox-local-work.ts).
 *
 * Open any branch or folder (approval "reviews-open-any-branch-a"): the group's + lists a project's branches and
 * worktree folders (`GET /api/inbox/reviews/local/refs`; packages/server/inbox-local-refs.ts), or any folder through
 * New message's folder opener ("Another folder…"); what the person opens stays in the group (`kept`).
 */

/**
 * One row: a branch's work, a folder's uncommitted changes, or a worktree folder's whole work (its commits not on the
 * default branch and its uncommitted changes; opened from the group's +).
 */
export interface InboxLocalWork {
  /** The project; "" for a folder picked through "Another folder…" that is in no project's repository. */
  project_id: string;
  kind: "branch" | "uncommitted" | "folder";
  /**
   * A branch row: the branch. An uncommitted row: the branch checked out in the project's folder, or the short commit
   * id when its HEAD is detached; null in a repository with no commit yet. A folder row: the branch checked out in it,
   * null on no branch (`head` then).
   */
  branch: string | null;
  /** The default branch a branch or folder row's diff is against; null on an uncommitted row. */
  base: string | null;
  /** The last commit (a branch row) or the newest change to a changed file (an uncommitted row), ISO; a folder row: the newer. */
  at: string;
  /** A branch or folder row: its commits not on `base` (null: git couldn't count them; an older Inbox: absent). An uncommitted row: null. */
  ahead?: number | null;
  /** A folder row: the folder as it was opened (a worktree's full path, or the folder opener's `~/…`). */
  folder?: string;
  /** A folder row on no branch: its short commit. */
  head?: string | null;
  /** A folder row: it has uncommitted changes. */
  uncommitted?: boolean;
  /** A folder kept with no project ("Another folder…") that is a known project's repository (its folder or a worktree): that project. */
  in_project?: string;
  /** A folder row: the folder's real path, so one folder kept by two spellings (a full path, `~/…`) is one. */
  folder_real?: string;
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
  /**
   * What the person opened from the group's + (`?keep=<row key>`, at most `INBOX_LOCAL_KEPT_MAX`), each read now: its
   * row, unless it is gone, no longer passes the folder rules or is in a pull request. An older Inbox: absent.
   */
  kept?: InboxLocalWork[];
}

/** `GET /api/inbox/reviews/local/diff?project=&branch=` (no branch: the uncommitted changes; `folder=`: a folder's whole work). */
export interface InboxLocalDiffAnswer {
  project_id: string;
  kind: "branch" | "uncommitted" | "folder";
  branch: string | null;
  /** What the patch is against: the default branch (a branch's or a folder's whole diff), or `HEAD`. */
  base: string;
  patch: string;
  /** A branch's (or folder's) commits not on `base` (null: uncommitted changes, or git couldn't count them; an older Inbox: absent). */
  ahead?: number | null;
  /** A folder's diff: the folder as asked for, its short commit on no branch, and whether it has uncommitted changes. */
  folder?: string;
  head?: string | null;
  uncommitted?: boolean;
}

/** The group's +, its first step (`GET /api/inbox/reviews/local/refs`): the projects whose folder is a git repository here. */
export interface InboxLocalRefProjectsAnswer {
  /** Newest activity first: each with its worktree folders (not its own) and its branches the next step lists. */
  projects: { project_id: string; folders: number; branches: number }[];
  /** "Another folder…": New message's folder opener can be used (Launch is on). An older Inbox: absent. */
  another_folder?: boolean;
  /** This computer's home folder, so the folder opener shows `~/…`. */
  home?: string | null;
}

/** The group's +, a project's step (`GET /api/inbox/reviews/local/refs?project=`): its worktree folders and branches, newest first. */
export interface InboxLocalRefsAnswer {
  project_id: string;
  base: string;
  /** Folder rows (`kind: "folder"`): the repository's worktrees but the project's own folder. */
  folders: InboxLocalWork[];
  /** Branch rows: every local branch but the default one and those checked out in a listed folder. */
  branches: InboxLocalWork[];
}

/** What the group keeps of what the person opened, newest first. */
export const INBOX_LOCAL_KEPT_MAX = 20;

/** A folder's own name: the last part of its path. */
export function inboxLocalFolderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/**
 * A row's words: the branch, or "Uncommitted on main" (on its short commit id when detached; "Uncommitted changes" with
 * no commit); a folder: the branch checked out in it, else its own name.
 */
export function inboxLocalWorkLabel(work: Pick<InboxLocalWork, "kind" | "branch" | "folder">): string {
  if (work.kind === "branch") return work.branch ?? "";
  if (work.kind === "folder") return work.branch ?? inboxLocalFolderName(work.folder ?? "");
  return work.branch ? `Uncommitted on ${work.branch}` : "Uncommitted changes";
}

/** A folder row's quiet words: its own name beside the branch in it, else its short commit. Null: not a folder row. */
export function inboxLocalFolderQuiet(work: Pick<InboxLocalWork, "kind" | "branch" | "folder" | "head">): string | null {
  if (work.kind !== "folder") return null;
  return work.branch ? inboxLocalFolderName(work.folder ?? "") : (work.head ?? null);
}

/**
 * The row's key: `<project id>:<branch>`, `<project id>:` for its uncommitted changes (git allows no `:` in a branch),
 * or `<project id>::<folder>` for a folder.
 */
export function inboxLocalWorkKey(work: Pick<InboxLocalWork, "project_id" | "kind" | "branch" | "folder">): string {
  if (work.kind === "folder") return `${work.project_id}::${work.folder ?? ""}`;
  return `${work.project_id}:${work.kind === "branch" ? (work.branch ?? "") : ""}`;
}

/** A kept key read back (`inboxLocalWorkKey` of a branch or a folder), or null: a project's own uncommitted key, or no key. */
export function inboxLocalKeepOf(key: string): { project: string; branch: string } | { project: string; folder: string } | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const project = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (rest.startsWith(":")) return rest.length > 1 ? { project, folder: rest.slice(1) } : null;
  return project && rest ? { project, branch: rest } : null;
}

/** Nothing beyond the default branch: no commit of its own and (a folder) no uncommitted change. */
export function inboxLocalSameAsBase(work: Pick<InboxLocalWork, "kind" | "ahead" | "uncommitted">): boolean {
  return work.kind !== "uncommitted" && work.ahead === 0 && !work.uncommitted;
}

/**
 * One row for one piece of work: rows a kept folder repeats (its branch's row, its project's uncommitted row, or the
 * same folder kept twice, once through "Another folder…") give way to one. A folder on a branch is that branch's work;
 * a folder on no branch is only itself, by its real path (`folder_real`). The open row stays; else a folder row, one
 * with its project first. Rows with no folder among them stay as the list has them.
 */
export function inboxLocalOneRowEach(rows: readonly InboxLocalWork[], openKey: string | null): InboxLocalWork[] {
  const sameWork = (row: InboxLocalWork) => {
    // On no branch, only the folder itself: two worktrees detached at one commit are two pieces of work.
    if (row.kind === "folder" && !row.branch) return row.folder_real ? `folder\u0000${row.folder_real}` : null;
    const project = row.project_id || row.in_project || "";
    return project && row.branch ? `${project}\u0000branch\u0000${row.branch}` : null;
  };
  const groups = new Map<string, InboxLocalWork[]>();
  for (const row of rows) {
    const work = sameWork(row);
    if (work) groups.set(work, [...(groups.get(work) ?? []), row]);
  }
  const drop = new Set<InboxLocalWork>();
  for (const group of groups.values()) {
    const folders = group.filter((row) => row.kind === "folder");
    if (group.length < 2 || folders.length === 0) continue;
    const keep = group.find((row) => inboxLocalWorkKey(row) === openKey) ?? folders.find((row) => row.project_id) ?? folders[0]!;
    for (const row of group) if (row !== keep) drop.add(row);
  }
  return drop.size ? rows.filter((row) => !drop.has(row)) : [...rows];
}
