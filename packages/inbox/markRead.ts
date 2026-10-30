/**
 * Mark read (design record "inbox-mark-read", approved 2026-10-11; not in
 * this repo): which threads take it, and what the window says after it.
 * Pure.
 *
 * Mark read moves a thread out of the top to Quiet without archiving it: its
 * questions still waiting on the person close unanswered (each a skip), and once the Undo window has passed the asking agent is told
 * once not to wait on them. It comes back when an agent writes again.
 */

import { inboxRowOffersMarkRead, inboxRowWaitsOnPerson, type InboxListRow, type InboxSectionId } from '@plannotator/core/inbox-types';
import { agentName, plural } from './format';

/** How long the Undo toast stays (the server's set-aside note waits a little longer). */
export const MARK_READ_UNDO_MS = 7_000;

/**
 * How long Mark read waits for a look this tab sent to land before it decides
 * (App.tsx `markRead`): past it, it decides on the state it has.
 */
export const MARK_READ_LOOK_WAIT_MS = 1_500;

/** Something here waits on the person: a question, or news they have not looked at. */
export const waitsOnPerson = inboxRowWaitsOnPerson;

/**
 * The thread can be marked read now, or is marked read (the pressed button
 * moves it back). Never an archived thread, except for what an agent wrote
 * after the archive (`agent_after_archive`): Mark read handles that, and the
 * thread goes back to the archive.
 */
export function canToggleRead(
  row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'read_at' | 'agent_after_archive'>,
  drawn?: InboxSectionId | null,
): boolean {
  if (row.resolved_at !== null && row.agent_after_archive !== true) return false;
  return (row.read_at ?? null) !== null || waitsOnPerson(row) || seenHeldInNew(row, drawn);
}

/**
 * The list row's quiet hover action: on rows that wait on the person, never
 * on Sent or Quiet, except a row the list still draws in New
 * (`seenHeldInNew`).
 */
export function offersRowMarkRead(row: Parameters<typeof inboxRowOffersMarkRead>[0], drawn?: InboxSectionId | null): boolean {
  return inboxRowOffersMarkRead(row) || seenHeldInNew(row, drawn);
}

/**
 * A plain update the person opened, which the list still draws in New
 * (`drawn`, the group the row sits in on screen): the look put it in Quiet on
 * the server, but while a thread is open the list holds still (held.ts), so
 * the row waits in New until the list settles. Mark read stays offered on it
 * there (the header, the row's hover action and menu, `E`), and only moves the
 * row to Quiet now: nothing is written, since the thread is already Quiet.
 * Not a thread with a question or unsent work (the server keeps those out of
 * Quiet), one marked read, or an archived one.
 */
export function seenHeldInNew(row: Pick<InboxListRow, 'section' | 'resolved_at'> & { read_at?: string | null }, drawn: InboxSectionId | null | undefined): boolean {
  return drawn === 'new' && row.section === 'quiet' && row.resolved_at === null && (row.read_at ?? null) === null;
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
 * Where the thread marked read was when the person marked it:
 * - `open`: it is the thread open on screen (its header names it);
 * - `held`: another thread is open, so the list holds still (settle.ts) and
 *   the row has not moved yet;
 * - `list`: no thread is open, and the row has moved.
 */
export type MarkReadPlace = 'open' | 'held' | 'list';

/**
 * The toast after Mark read (design record "inbox-toast", approved
 * 2026-10-14), from the row as it was before (`before`). On the open thread
 * it says where the row goes (the header names the thread); on any other row
 * the subject says which one, since the toast sits over the open thread's
 * pane. What the agent is told is the thread's Read banner's to say.
 */
export function markReadToast(
  before: Pick<InboxListRow, 'subject' | 'author' | 'questions'> & { resolved_at?: string | null; unsent?: InboxListRow['unsent'] },
  place: MarkReadPlace,
): MarkReadToast {
  const subject = `“${before.subject ?? '(no subject)'}”`;
  const warn = before.questions.stopped || before.questions.holds_up.length > 0;
  // Another thread is open: name the row marked, or the toast reads as if the open thread was.
  if (place === 'held') return { lead: 'Marked read', phoneLead: 'Read', detail: subject, warn };
  if (before.questions.stopped) return { lead: 'Marked read', phoneLead: 'Read', detail: `${agentName(before.author)} was stopped`, warn: true };
  if (before.questions.holds_up.length > 0) {
    return { lead: 'Marked read', phoneLead: 'Read', detail: `Held up ${plural(before.questions.holds_up.length, 'thing')}`, warn: true };
  }
  // A thread that came back from the archive goes back there; any other goes to Quiet.
  const archived = (before.resolved_at ?? null) !== null;
  // Words typed in the reply box, or comments waiting, keep it out of Quiet (approval "inbox-reply-drafts"; Mark read closes the picks).
  const kept = !archived && before.unsent != null && (before.unsent.reply_at !== null || before.unsent.comments > 0);
  if (kept) return { lead: 'Marked read', phoneLead: 'Read', detail: place === 'open' ? 'Your draft keeps it in New' : `${subject} · your draft keeps it in New`, warn: false };
  if (place === 'open') return { lead: 'Marked read', phoneLead: 'Read', detail: archived ? 'Goes back to Archived' : 'Moves to Quiet', warn: false };
  return { lead: archived ? 'Back in Archived' : 'Moved to Quiet', detail: subject, warn: false };
}
