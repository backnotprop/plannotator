import { inboxPullItems, inboxPullStacks, inboxReviewRows, type InboxPullsAnswer, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { PullsState } from './usePulls';

export function reviewsOfPulls(model: InboxPullsAnswer): InboxReviewsAnswer {
  const links = model.links ?? {};
  const stacks = inboxPullStacks(model.pulls);
  const pullReasons = new Map(inboxPullItems(stacks, (pull) => !!links[pull.key]).map((item) => [item.stack.id, item.reason]));
  return {
    fetched_at: model.fetched_at,
    hosts: model.hosts,
    rows: inboxReviewRows({ threads: [], stacks, links, pulls: model.pulls, pullReasons }),
    projects: model.projects ?? {},
  };
}

export function pullsStateOf(model: InboxPullsAnswer | null, loading = false): PullsState {
  return { model, reviews: model && reviewsOfPulls(model), error: null, loading, refresh: () => {}, reload: () => {}, reloadRows: () => {} };
}
