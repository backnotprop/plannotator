import type { InboxThreadPullState, InboxThreadPullWire, InboxThreadPullsAnswer, InboxThreadPullsSummary } from '@plannotator/core/inbox-types';
import { inboxThreadPullHeadline } from '@plannotator/core/inbox-types';

export type ThreadPullsChange = string | '*';

const listeners = new Set<(change: ThreadPullsChange) => void>();

export const threadPullsBus = {
  subscribe(listener: (change: ThreadPullsChange) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(change: ThreadPullsChange): void {
    for (const listener of [...listeners]) listener(change);
  },
};

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

export function pullHeadline(answer: Pick<InboxThreadPullsAnswer, 'pulls' | 'groups'>): InboxThreadPullWire | null {
  return inboxThreadPullHeadline(answer.pulls, answer.groups);
}

export function pullsSummaryOf(answer: Pick<InboxThreadPullsAnswer, 'pulls' | 'groups'>): InboxThreadPullsSummary | undefined {
  const headline = pullHeadline(answer);
  return headline ? { count: answer.pulls.length, headline: { key: headline.pull, state: headline.state } } : undefined;
}

export function pullsMarkWords(summary: InboxThreadPullsSummary, headlineLabel: string | null): string {
  const state = summary.headline.state === 'unknown' ? null : summary.headline.state;
  if (summary.count === 1) return `Pull request${headlineLabel ? ` ${headlineLabel}` : ''}${state ? `, ${state}` : ''}`;
  return `${summary.count} pull requests${headlineLabel && state ? `, ${headlineLabel} ${state}` : ''}`;
}

export function labelOfKey(key: string): string | null {
  const match = /#(\d+)(:pull)?$/.exec(key);
  return match ? `${match[2] ? '!' : '#'}${match[1]}` : null;
}

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
