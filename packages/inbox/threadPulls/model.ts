/**
 * A thread's PRs in the window (approval "inbox-pr-binding", 2026-11-08):
 * the words the row mark, the thread's button and the popover share, and the
 * bus that tells them a thread's PRs changed. Pure but for the bus.
 */

import type { InboxThreadPullState, InboxThreadPullWire, InboxThreadPullsAnswer, InboxThreadPullsSummary } from '@plannotator/core/inbox-types';
import { inboxThreadPullHeadline } from '@plannotator/core/inbox-types';

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

/** The count over the mark's corner: 2 to 9, then "9+". */
export function pullCountText(count: number): string {
  return count > 9 ? '9+' : String(count);
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
