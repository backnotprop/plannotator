/**
 * Bulk Close on the Pull requests board (approval "inbox-pr-board-bulk": Close shows the count with Undo, no confirm).
 * The words of the bar, the toast and the report. Every pick is an open PR (select mode picks only those); a host that
 * says otherwise (merged or closed meanwhile, no permission) refuses that one in its own words, reported per PR.
 */
import { inboxPullLabel, inboxPullRepoKey, type InboxPull } from '@plannotator/core/inbox-types';

/** One PR's end in a run's report: it went, or the host's (or the Inbox's) words for why not (and its code, when it gave one). */
export type RunOutcome = { pull: InboxPull; ok: true } | { pull: InboxPull; ok: false; why: string; code?: string };

/** What a run does, one PR at a time. */
export type BulkVerb = 'merge' | 'close' | 'reopen';

/** "Merging 2 of 3…", "Closing 2 of 3…", "Reopening 2 of 3…". */
export function runningWords(verb: BulkVerb, done: number, total: number): string {
  const ing = verb === 'merge' ? 'Merging' : verb === 'close' ? 'Closing' : 'Reopening';
  return `${ing} ${done} of ${total}…`;
}

/** The report's first line: "Merged #1198, #391.", "Closed #1190, #1182.", "Reopened #1190." Null when none went. */
export function doneLine(verb: BulkVerb, pulls: readonly InboxPull[]): string | null {
  if (pulls.length === 0) return null;
  const ed = verb === 'merge' ? 'Merged' : verb === 'close' ? 'Closed' : 'Reopened';
  return `${ed} ${pulls.map(inboxPullLabel).join(', ')}.`;
}

/** The toast after Close ("Closed 3", with Undo) and after its Undo ("Reopened 3"). */
export function toastLead(verb: 'close' | 'reopen', count: number): string {
  return `${verb === 'close' ? 'Closed' : 'Reopened'} ${count}`;
}

/** How long Close's toast, and so its Undo, stays. */
export const CLOSE_UNDO_MS = 8_000;

/**
 * What a Close closed, as its toast and its Undo line under the bar name it (approval "inbox-pr-board-close-safe"):
 * the first three numbers in the order closed, each after its repository's name when the Close spans more than one
 * repository, and how many more.
 */
export interface ClosedNames {
  groups: { repo: string | null; numbers: string[] }[];
  more: number;
}

const SHOWN = 3;

export function closedNames(pulls: readonly InboxPull[], repoLabel: (repoKey: string) => string): ClosedNames {
  const keyOf = (pull: InboxPull) => inboxPullRepoKey(pull.host, pull.repo);
  const many = new Set(pulls.map(keyOf)).size > 1;
  const groups: ClosedNames['groups'] = [];
  for (const pull of pulls.slice(0, SHOWN)) {
    const repo = many ? repoLabel(keyOf(pull)) : null;
    const last = groups.at(-1);
    if (last && last.repo === repo) last.numbers.push(inboxPullLabel(pull));
    else groups.push({ repo, numbers: [inboxPullLabel(pull)] });
  }
  return { groups, more: Math.max(0, pulls.length - SHOWN) };
}

/** "#2050, #2041, #2039", "web-app #2039 · billing-svc #88, #85", "… and 125 more". */
export function closedList(names: ClosedNames): string {
  const list = names.groups.map((g) => `${g.repo ? `${g.repo} ` : ''}${g.numbers.join(', ')}`).join(' · ');
  return names.more > 0 ? `${list} and ${names.more} more` : list;
}

/** Close's toast: one names its number and title ("Closed #2039" · title); several, the count and their numbers. */
export function closedToast(pulls: readonly InboxPull[], repoLabel: (repoKey: string) => string): { lead: string; detail: string } {
  if (pulls.length === 1) return { lead: `Closed ${inboxPullLabel(pulls[0]!)}`, detail: pulls[0]!.title };
  return { lead: toastLead('close', pulls.length), detail: closedList(closedNames(pulls, repoLabel)) };
}

/** A reopen refused for good (the window passed, merged or open meanwhile, unknown): its Undo is not offered again. */
export function reopenRefusedForGood(code: string | undefined): boolean {
  return code === 'reopen_not_closed_here' || code === 'pull_merged' || code === 'pull_open' || code === 'pull_unknown';
}
