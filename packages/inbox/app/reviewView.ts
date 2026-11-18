/**
 * A thread opened from Reviews starts at its review (`reviewViewOf`); it is the same thread, and links back to the
 * Inbox's view of it, its PR's page and, for a thread started from the PR's page, the PR's diff. Null for any other
 * thread, or while Reviews is not shown.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { PullsState } from '../pulls/usePulls';
import { reviewRowProject, reviewViewOf, type ReviewView } from '../pulls/reviewsModel';
import type { Route } from './route';

export function appReviewView(input: {
  route: Route;
  pulls: PullsState;
  pullsShown: boolean;
  thread: InboxThread | null;
  projectNames: ReadonlyMap<string, string>;
  go: (next: Route) => void;
}): ReviewView | null {
  const { route, pulls, thread, go } = input;
  const row = route.reviews && route.thread && input.pullsShown ? (pulls.reviews?.rows.find((r) => r.reviewed && r.thread_id === route.thread) ?? null) : null;
  if (!row || !thread || thread.thread_id !== route.thread) return null;
  const reviews = { page: 'reviews' as const, project: route.reviews?.project ?? null, view: route.reviews?.view, thread: null };
  return reviewViewOf(row, thread, {
    projectName: input.projectNames.get(reviewRowProject(row) ?? '') ?? null,
    onWholeThread: () => go({ page: 'inbox', project: null, thread: row.thread_id }),
    onOpenStack: (stackId) => go({ ...reviews, stack: stackId }),
    onOpenDiff: (stackId, layer) => go({ ...reviews, stack: stackId, layer, scope: 'layer' }),
    onAsked: () => pulls.reload(),
  });
}
