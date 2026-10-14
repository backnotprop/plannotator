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
export function offersRowMarkRead(row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'back_from_archive'>): boolean {
  return (row.resolved_at === null || row.back_from_archive === true) && waitsOnPerson(row);
}

export interface MarkReadToast {
  /** The bold first words. */
  lead: string;
  /** What a phone says instead ("Read": the pressed Read button says the same). */
  phoneLead?: string;
  /** The muted rest of the line, cut with "…" when it does not fit. */
  detail: string;
  /** An agent was stopped or held up on the thread: the toast warns and offers Reply. */
  warn: boolean;
}

/**
 * The toast after Mark read (design record "inbox-toast", approved
 * 2026-10-14), from the row as it was before (`before`). `deferred`: a thread
 * is open, so the list holds still and the row moves when the list next
 * settles (settle.ts); the toast says where it goes (the header names the
 * thread). From a row, the subject says which one moved. What the agent is
 * told is the thread's Read banner's to say.
 */
export function markReadToast(
  before: Pick<InboxListRow, 'subject' | 'author' | 'questions'> & { resolved_at?: string | null },
  deferred = false,
): MarkReadToast {
  if (before.questions.stopped) return { lead: 'Marked read', phoneLead: 'Read', detail: `${agentName(before.author)} was stopped`, warn: true };
  if (before.questions.holds_up.length > 0) {
    return { lead: 'Marked read', phoneLead: 'Read', detail: `Held up ${plural(before.questions.holds_up.length, 'thing')}`, warn: true };
  }
  // A thread that came back from the archive goes back there; any other goes to Quiet.
  const archived = (before.resolved_at ?? null) !== null;
  if (deferred) return { lead: 'Marked read', phoneLead: 'Read', detail: archived ? 'Goes back to Archived' : 'Moves to Quiet', warn: false };
  return { lead: archived ? 'Back in Archived' : 'Moved to Quiet', detail: `“${before.subject ?? '(no subject)'}”`, warn: false };
}
