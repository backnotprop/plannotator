/**
 * Reviews' "On this computer" in the window (packages/core/inbox-local-work.ts): its two reads, which rows a project
 * filter keeps, and the group's fold (closed until the person opens it, then remembered as the other folds are).
 */
import type { InboxLocalDiffAnswer, InboxLocalRefProjectsAnswer, InboxLocalRefsAnswer, InboxLocalWork, InboxLocalWorkAnswer } from '@plannotator/core/inbox-types';
import { get } from '../api';
import { inboxUrl } from '../inboxUrl';

/**
 * This computer's work in no PR (`GET /api/inbox/reviews/local`): always this Inbox's own, never a linked machine's.
 * With the list's project filter, that project's rows only, so other projects' rows never crowd out its own. `keep`:
 * what the person opened from the group's + (localKept.ts), each read again (`kept` in the answer).
 */
export function readLocalWork(project: string | null, signal?: AbortSignal, keep: readonly string[] = []): Promise<InboxLocalWorkAnswer> {
  const query = [project ? `project=${encodeURIComponent(project)}` : '', ...keep.map((key) => `keep=${encodeURIComponent(key)}`)].filter(Boolean).join('&');
  return get<InboxLocalWorkAnswer>(inboxUrl('/reviews/local', query || undefined), signal);
}

/** The group's +, its first step (`GET /api/inbox/reviews/local/refs`): the projects whose folder is a git repository here. */
export function readLocalRefProjects(signal?: AbortSignal): Promise<InboxLocalRefProjectsAnswer> {
  return get<InboxLocalRefProjectsAnswer>(inboxUrl('/reviews/local/refs'), signal);
}

/** A project's step: its worktree folders and branches. */
export function readLocalRefs(project: string, signal?: AbortSignal): Promise<InboxLocalRefsAnswer> {
  return get<InboxLocalRefsAnswer>(inboxUrl('/reviews/local/refs', `project=${encodeURIComponent(project)}`), signal);
}

/** Its git could not be read, for this list (one project's, or any project's): said, never "nothing". */
export function localWorkUnread(answer: InboxLocalWorkAnswer, project: string | null): boolean {
  return project ? !!answer.unread_projects?.includes(project) : answer.unread > 0;
}

/**
 * A row's diff (`GET /api/inbox/reviews/local/diff`): a branch's whole diff, with no branch the uncommitted changes, or a
 * folder's whole work (`folder`; a folder picked through "Another folder…" has no project).
 */
export function readLocalDiff(project: string, branch: string | null, signal?: AbortSignal, folder: string | null = null): Promise<InboxLocalDiffAnswer> {
  const query = folder !== null ? `${project ? `project=${encodeURIComponent(project)}&` : ''}folder=${encodeURIComponent(folder)}` : `project=${encodeURIComponent(project)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
  return get<InboxLocalDiffAnswer>(inboxUrl('/reviews/local/diff', query), signal);
}

/** The rows the list's project filter keeps. */
export function localWorkIn(items: readonly InboxLocalWork[], project: string | null): InboxLocalWork[] {
  return project ? items.filter((item) => item.project_id === project) : [...items];
}
