/**
 * "Open in Reviews" on a PR's ref card (`@plannotator/ui` `refCardAction`), in the Inbox only and only while Code
 * review is on: a pull request the Reviews list holds open gets a second link on its card, beside "Open on GitHub",
 * that opens its page in Reviews (the stack's launchpad, as a thread's "Open review thread" does with no review thread
 * yet). A PR the list does not hold (another repository, merged or closed, hidden, an issue) gets none: Reviews opens
 * only what its list holds.
 */

import { useEffect, useRef } from 'react';
import { forgeRefKey, type ForgeRef } from '@plannotator/core/forge-ref-card';
import { inboxPullIsOpen, inboxPullStacks, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { refreshRefCardAction, setRefCardAction, type RefCardAction } from '@plannotator/ui/utils/refCardAction';
import { writeRoute } from '../app/writeRoute';

export const OPEN_IN_REVIEWS = 'Open in Reviews';

/** The stack Reviews opens for a ref: the one whose open layer is that PR in `model`, or null. */
export function reviewsStackOf(model: Pick<InboxPullsAnswer, 'pulls'> | null, ref: ForgeRef): string | null {
  if (!model) return null;
  // A GitHub issue link to a PR is the same item (no kind in the key); GitLab and Bitbucket number issues apart.
  const key = forgeRefKey(ref);
  return inboxPullStacks(model.pulls).find((s) => s.layers.some((l) => l.key === key && inboxPullIsOpen(l)))?.id ?? null;
}

/** The card's link for `model` (null: Code review is off, so no list). */
export function refCardReviewsAction(model: () => Pick<InboxPullsAnswer, 'pulls'> | null, open: (stackId: string) => void): RefCardAction {
  return (ref, result) => {
    if (result?.ok && result.data.kind !== 'pull') return null;
    const stack = reviewsStackOf(model(), ref);
    return stack ? { label: OPEN_IN_REVIEWS, open: () => open(stack) } : null;
  };
}

/** Installs the link for the window's life; `model` is the Reviews list while Code review is on, else null. */
export function useRefCardReviews(model: InboxPullsAnswer | null): void {
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    setRefCardAction(refCardReviewsAction(() => latest.current, (stack) => writeRoute({ page: 'reviews', project: null, thread: null, stack, layer: null })));
    return () => setRefCardAction(null);
  }, []);
  // The list was read again: an open card asks again, so "Open in Reviews" goes when its PR left the list.
  useEffect(() => refreshRefCardAction(), [model]);
}
