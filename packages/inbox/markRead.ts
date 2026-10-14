/**
 * Mark read (design record "inbox-mark-read", approved 2026-10-11; not in
 * this repo): which threads take it, and what the window says after it.
 * Pure.
 *
 * Mark read moves a thread out of the top to Quiet without archiving it: its
 * questions still waiting on the person close unanswered (each a skip, never
 * a decision), and once the Undo window has passed the asking agent is told
 * once not to wait on them. It comes back when an agent writes again.
 */

import { inboxRowOffersMarkRead, inboxRowWaitsOnPerson, type InboxListRow } from '@plannotator/core/inbox-types';
import { agentName, plural } from './format';

/** How long the Undo toast stays (the server's set-aside note waits a little longer). */
export const MARK_READ_UNDO_MS = 7_000;

/** Something here waits on the person: a question, or news they have not looked at. */
export const waitsOnPerson = inboxRowWaitsOnPerson;

/**
 * The thread can be marked read now, or is marked read (the pressed button
 * moves it back). Never an archived thread, except for what an agent wrote
 * after the archive (`agent_after_archive`): Mark read handles that, and the
 * thread goes back to the archive.
 */
export function canToggleRead(row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'read_at' | 'agent_after_archive'>): boolean {
  if (row.resolved_at !== null && row.agent_after_archive !== true) return false;
  return (row.read_at ?? null) !== null || waitsOnPerson(row);
}

/** The list row's quiet hover action: on rows that wait on the person, never on Sent or Quiet. */
export const offersRowMarkRead = inboxRowOffersMarkRead;

export interface MarkReadToast {
  text: string;
  sub: string;
  /** A phone's one line (the thread's banner says the rest). */
  short: string;
  /** An agent was stopped or held up on the thread: the toast warns and offers Reply. */
  warn: boolean;
}

/**
 * The toast after Mark read, from the row as it was before (`before`) and the
 * number of questions the Mark read closed. `deferred`: a thread is open, so
 * the list holds still and the row moves to Quiet when the list next settles
 * (settle.ts); the toast must not say it already moved.
 */
export function markReadToast(
  before: Pick<InboxListRow, 'subject' | 'author' | 'questions'> & { resolved_at?: string | null },
  closed: number,
  deferred = false,
): MarkReadToast {
  const agent = agentName(before.author);
  const subject = `“${before.subject ?? '(no subject)'}”`;
  // A thread that came back from the archive goes back there; any other goes to Quiet. With a thread
  // open the row holds its place until the list settles (settle.ts), so the move is still to come.
  const archived = (before.resolved_at ?? null) !== null;
  const text = archived
    ? `Read: ${subject} ${deferred ? 'will go' : 'went'} back to Archived.`
    : `Read: ${subject} ${deferred ? 'will move' : 'moved'} to Quiet.`;
  const what = closed === 1 ? 'the question' : plural(closed, 'question');
  const told = closed > 0 ? `${agent} is told not to wait on ${what}.` : '';
  const short = archived
    ? deferred
      ? 'Read. Will go back to Archived.'
      : 'Read. Back in Archived.'
    : deferred
      ? 'Read. Will move to Quiet.'
      : 'Read. Moved to Quiet.';
  if (before.questions.stopped) return { text, short, sub: `${agent} was stopped on it. ${told}`.trim(), warn: true };
  if (before.questions.holds_up.length > 0) {
    return { text, short, sub: `It held up ${plural(before.questions.holds_up.length, 'thing')}. ${told}`.trim(), warn: true };
  }
  return { text, short, sub: `It comes back when ${agent} writes again.${told ? ` ${told}` : ''}`, warn: false };
}
