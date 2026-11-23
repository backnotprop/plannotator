/**
 * Reviews' "On this computer" in the window (packages/core/inbox-local-work.ts): its two reads, which rows a project
 * filter keeps, and the group's fold (closed until the person opens it, then remembered as the other folds are).
 */
import type { InboxLocalDiffAnswer, InboxLocalWork, InboxLocalWorkAnswer } from '@plannotator/core/inbox-types';
import { get } from '../api';
import { inboxUrl } from '../inboxUrl';

/**
 * This computer's work in no PR (`GET /api/inbox/reviews/local`): always this Inbox's own, never a linked machine's.
 * With the list's project filter, that project's rows only, so other projects' rows never crowd out its own.
 */
export function readLocalWork(project: string | null, signal?: AbortSignal): Promise<InboxLocalWorkAnswer> {
  return get<InboxLocalWorkAnswer>(inboxUrl('/reviews/local', project ? `project=${encodeURIComponent(project)}` : undefined), signal);
}

/** Its git could not be read, for this list (one project's, or any project's): said, never "nothing". */
export function localWorkUnread(answer: InboxLocalWorkAnswer, project: string | null): boolean {
  return project ? !!answer.unread_projects?.includes(project) : answer.unread > 0;
}

/** A row's diff (`GET /api/inbox/reviews/local/diff`): a branch's whole diff, or with no branch the uncommitted changes. */
export function readLocalDiff(project: string, branch: string | null, signal?: AbortSignal): Promise<InboxLocalDiffAnswer> {
  return get<InboxLocalDiffAnswer>(inboxUrl('/reviews/local/diff', `project=${encodeURIComponent(project)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`), signal);
}

/** The rows the list's project filter keeps. */
export function localWorkIn(items: readonly InboxLocalWork[], project: string | null): InboxLocalWork[] {
  return project ? items.filter((item) => item.project_id === project) : [...items];
}
