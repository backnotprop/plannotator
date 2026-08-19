import type { PRContext } from '@plannotator/shared/pr-types';

/** Counts the entries that the PR comments timeline can actually render. */
export function getPRDiscussionCount(context: PRContext): number {
  const visibleReviews = context.reviews.filter(
    (review) => review.state !== 'COMMENTED' || review.body,
  ).length;
  const visibleThreads = (context.reviewThreads ?? []).filter(
    (thread) => thread.comments.length > 0,
  ).length;
  return context.comments.length + visibleReviews + visibleThreads;
}
