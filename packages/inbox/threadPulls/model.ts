/**
 * A thread's PRs in the window (approval "inbox-pr-binding", 2026-11-08):
 * the words the row mark, the thread's button and the popover share, where a
 * row's review link goes, and the bus that tells them a thread's PRs changed.
 * Pure but for the bus.
 */

import type { InboxPullsAnswer, InboxReviewsAnswer, InboxThreadPullState, InboxThreadPullWire, InboxThreadPullsAnswer, InboxThreadPullsSummary } from '@plannotator/core/inbox-types';
import { inboxPullIsOpen, inboxPullStacks, inboxThreadPullHeadline } from '@plannotator/core/inbox-types';
import { linkAgentName } from '../pulls/model';
import { stackLink } from '../pulls/topology';

/** What a change names: one thread, or every thread (a reconnect, a catch-up). */
export type ThreadPullsChange = string | '*';

const listeners = new Set<(change: ThreadPullsChange) => void>();

/** The window's one bus: the event stream emits, each open popover and the thread's button listen. */
export const threadPullsBus = {
  subscribe(listener: (change: ThreadPullsChange) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(change: ThreadPullsChange): void {
    for (const listener of [...listeners]) listener(change);
  },
};

/** "Open", "Draft", "Merged", "Closed", or "Not read yet" for a PR whose state the Inbox has not read. */
export function pullStateWord(state: InboxThreadPullState): string {
  switch (state) {
    case 'open':
      return 'Open';
    case 'draft':
      return 'Draft';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return 'State not known yet';
  }
}

/** The quiet extras after a PR's state in the popover: checks, then the review (open PRs only). */
export function pullExtras(pull: Pick<InboxThreadPullWire, 'state' | 'checks' | 'review'>): string[] {
  if (pull.state !== 'open' && pull.state !== 'draft') return [];
  const out: string[] = [];
  if (pull.checks === 'running') out.push('checks running');
  if (pull.checks === 'failing') out.push('checks failing');
  if (pull.state === 'open' && pull.review === 'approved') out.push('approved');
  if (pull.state === 'open' && pull.review === 'review_required') out.push('review required');
  if (pull.state === 'open' && pull.review === 'changes_requested') out.push('changes requested');
  return out;
}

/** The PR the mark shows, from a full answer (the same rule as the server's row summary). */
export function pullHeadline(answer: Pick<InboxThreadPullsAnswer, 'pulls' | 'groups'>): InboxThreadPullWire | null {
  return inboxThreadPullHeadline(answer.pulls, answer.groups);
}

/** A row's or the button's summary from a full answer; undefined with no PRs. */
export function pullsSummaryOf(answer: Pick<InboxThreadPullsAnswer, 'pulls' | 'groups'>): InboxThreadPullsSummary | undefined {
  const headline = pullHeadline(answer);
  return headline ? { count: answer.pulls.length, headline: { key: headline.pull, state: headline.state } } : undefined;
}

/**
 * What a screen reader hears for the mark (and the button's name): "Pull request #412, open" for one, "3 pull
 * requests, #431 open" for several, the shown one's state only when known.
 */
export function pullsMarkWords(summary: InboxThreadPullsSummary, headlineLabel: string | null): string {
  const state = summary.headline.state === 'unknown' ? null : summary.headline.state;
  if (summary.count === 1) return `Pull request${headlineLabel ? ` ${headlineLabel}` : ''}${state ? `, ${state}` : ''}`;
  return `${summary.count} pull requests${headlineLabel && state ? `, ${headlineLabel} ${state}` : ''}`;
}

/** The label of a key as the window shows it (`#12`, `!12`), from the key alone (the row has no wire). */
export function labelOfKey(key: string): string | null {
  const match = /#(\d+)(:pull)?$/.exec(key);
  return match ? `${match[2] ? '!' : '#'}${match[1]}` : null;
}

/**
 * Where a PR row's "Open review thread" goes: its review thread in the Inbox (`thread`, with the agent the launchpad
 * names), or, with none yet, the PR's page in Reviews (`launchpad`, the stack's id; a stack of several opens its
 * stack page there).
 */
export type PullReviewLink = { kind: 'thread'; threadId: string; agent: { host: string | null; name: string } | null } | { kind: 'launchpad'; stackId: string };

/**
 * Each PR row's review link, read from Reviews' own list the way its launchpad reads it (PullsPage `StackView`): the
 * stack's link (`stackLink`) is its review thread unless that thread only named the PR (its Reviews row is not
 * `reviewed`). Null, no link: a PR that is not open or a draft, one Reviews does not list (no list read yet, a
 * repository that is no project, Bitbucket), and the row whose review thread is `here`, the thread the list is in.
 */
export function pullReviewLinks(model: Pick<InboxPullsAnswer, 'pulls' | 'links'> | null, reviews: Pick<InboxReviewsAnswer, 'rows'> | null): (pull: Pick<InboxThreadPullWire, 'pull' | 'state'>, here: string) => PullReviewLink | null {
  if (!model) return () => null;
  const stacks = inboxPullStacks(model.pulls);
  return (pull, here) => {
    if (pull.state !== 'open' && pull.state !== 'draft') return null;
    const stack = stacks.find((s) => s.layers.some((l) => l.key === pull.pull && inboxPullIsOpen(l)));
    if (!stack) return null;
    const link = stackLink(stack, model.links);
    const ended = link?.agent?.ended === true;
    const mentioned = !!link && !ended && reviews?.rows.find((row) => row.stacks.some((s) => s.id === stack.id))?.reviewed === false;
    if (!link || mentioned) return { kind: 'launchpad', stackId: stack.id };
    if (link.thread_id === here) return null;
    const name = linkAgentName(link);
    return { kind: 'thread', threadId: link.thread_id, agent: name ? { host: link.agent?.host ?? null, name } : null };
  };
}

/** The popover's head: the repository (or "3 repositories") and the count ("Stack of 3", "5 pull requests"). */
export function pullsHead(answer: Pick<InboxThreadPullsAnswer, 'pulls' | 'groups'>): { repo: string; count: string; oneRepo: boolean } {
  const repos = new Set(answer.pulls.map((pull) => `${pull.host}/${pull.repo}`.toLowerCase()));
  const oneRepo = repos.size <= 1;
  const only = answer.groups.length === 1 ? answer.groups[0]! : null;
  const total = answer.pulls.length;
  return {
    repo: oneRepo ? (answer.pulls[0]?.repo ?? '') : `${repos.size} repositories`,
    count: only?.kind === 'stack' ? `Stack of ${total}` : `${total} pull request${total === 1 ? '' : 's'}`,
    oneRepo,
  };
}
