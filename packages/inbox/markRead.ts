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

import type { InboxListRow } from '@plannotator/core/inbox-types';
import { agentName, plural } from './format';

/** How long the Undo toast stays (the server's set-aside note waits a little longer). */
export const MARK_READ_UNDO_MS = 7_000;

/** Something here waits on the person: a question, or news they have not looked at. */
export function waitsOnPerson(row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent'>): boolean {
  return row.section === 'stopped' || row.section === 'holding' || row.section === 'waiting' || (row.section === 'new' && (row.unseen > 0 || row.answered_not_sent));
}

/** The thread can be marked read now, or is marked read (the pressed button moves it back). Never an archived thread. */
export function canToggleRead(row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'read_at'>): boolean {
  if (row.resolved_at !== null) return false;
  return (row.read_at ?? null) !== null || waitsOnPerson(row);
}

/** The list row's quiet hover action: on rows that wait on the person, never on Sent or Quiet. */
export function offersRowMarkRead(row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at'>): boolean {
  return row.resolved_at === null && waitsOnPerson(row);
}

export interface MarkReadToast {
  text: string;
  sub: string;
  /** An agent was stopped or held up on the thread: the toast warns and offers Reply. */
  warn: boolean;
}

/**
 * The toast after Mark read, from the row as it was before (`before`) and the
 * number of questions the Mark read closed.
 */
export function markReadToast(before: Pick<InboxListRow, 'subject' | 'author' | 'questions'>, closed: number): MarkReadToast {
  const agent = agentName(before.author);
  const text = `Read: “${before.subject ?? '(no subject)'}” moved to Quiet.`;
  const what = closed === 1 ? 'the question' : plural(closed, 'question');
  const told = closed > 0 ? `${agent} is told not to wait on ${what}.` : '';
  if (before.questions.stopped) return { text, sub: `${agent} was stopped on it. ${told}`.trim(), warn: true };
  if (before.questions.holds_up.length > 0) {
    return { text, sub: `It held up ${plural(before.questions.holds_up.length, 'thing')}. ${told}`.trim(), warn: true };
  }
  return { text, sub: `It comes back when ${agent} writes again.${told ? ` ${told}` : ''}`, warn: false };
}
