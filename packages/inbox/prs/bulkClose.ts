/**
 * Bulk Close on the Pull requests board (approval "inbox-pr-board-bulk": Close shows the count with Undo, no confirm).
 * The words of the bar, the toast and the report. Every pick is an open PR (select mode picks only those); a host that
 * says otherwise (merged or closed meanwhile, no permission) refuses that one in its own words, reported per PR.
 */
import { inboxPullLabel, type InboxPull } from '@plannotator/core/inbox-types';

/** One PR's end in a run's report: it went, or the host's (or the Inbox's) words for why not. */
export type RunOutcome = { pull: InboxPull; ok: true } | { pull: InboxPull; ok: false; why: string };

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
