/**
 * Mark read (design record "inbox-mark-read", approved 2026-10-11; not in
 * this repo): which threads take it, and what the window says after it.
 * Pure.
 *
 * Mark read moves a thread out of the top to Quiet without archiving it: its
 * questions still waiting on the person close unanswered (each a skip), and once the Undo window has passed the asking agent is told
 * once not to wait on them. It comes back when an agent writes again.
 */

import { inboxRowOffersMarkRead, inboxRowWaitsOnPerson, type InboxListRow, type InboxListGroupId } from '@plannotator/core/inbox-types';
import { agentName, plural, shortAgentName } from './format';

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
  drawn?: InboxListGroupId | null,
): boolean {
  if (row.resolved_at !== null && row.agent_after_archive !== true) return false;
  return (row.read_at ?? null) !== null || waitsOnPerson(row) || seenHeldInNew(row, drawn);
}

/**
 * The list row's quiet hover action: on rows that wait on the person, never
 * on Sent or Quiet, except a row the list still draws in New
 * (`seenHeldInNew`).
 */
export function offersRowMarkRead(row: Parameters<typeof inboxRowOffersMarkRead>[0], drawn?: InboxListGroupId | null): boolean {
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
export function seenHeldInNew(row: Pick<InboxListRow, 'section' | 'resolved_at'> & { read_at?: string | null }, drawn: InboxListGroupId | null | undefined): boolean {
  return drawn === 'new' && row.section === 'quiet' && row.resolved_at === null && (row.read_at ?? null) === null;
}

/**
 * Mark unread (the owner's ask, 2026-10-31) is offered on the thread: it is
 * read (not bold, nothing waits on the person), not archived, and an agent
 * wrote after the person's last reply (`sent` is null; a reply is a look, so
 * there would be nothing to make new). The store's `markUnread` makes the
 * latest agent message new again: the row goes to New, bold. Never on a row
 * that waits on the person (Mark read's). With `drawn` (the header's button,
 * which shows one or the other), not on a seen update the list still holds
 * in New either: Mark read stays that button, and the menus offer both.
 */
export function canMarkUnread(
  row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'unread' | 'sent'> & { read_at?: string | null },
  drawn?: InboxListGroupId | null,
): boolean {
  if (row.resolved_at !== null || row.unread) return false;
  if (waitsOnPerson(row) || seenHeldInNew(row, drawn)) return false;
  return row.sent === null;
}

/** The toast after Mark unread: where the row went (the subject names it, as the list's Mark read toast does). */
export function markUnreadToast(before: Pick<InboxListRow, 'subject'>): { lead: string; detail: string } {
  return { lead: 'Marked unread', detail: `“${before.subject ?? '(no subject)'}” · back in New` };
}

export interface MarkReadToast {
  /** The bold first words. */
  lead: string;
  /** What a phone says instead ("Read": the pressed Read button says the same). */
  phoneLead?: string;
  /** The muted rest of the line, cut with "…" where it does not fit (Toast.tsx; the live region says it whole). */
  detail: string;
  /** A phone's detail: what happened first, the agent's name last, so a cut only ever eats the name. */
  phoneDetail?: string;
  /** An agent was stopped or held up on the thread: the toast warns and offers Reply. */
  warn: boolean;
  /** What the live region says instead, when the detail cut the agent's name (shortAgentName). */
  speech?: string;
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
  if (before.questions.stopped) {
    const name = agentName(before.author);
    const short = shortAgentName(name);
    return {
      lead: 'Marked read',
      phoneLead: 'Read',
      detail: `${short} was stopped`,
      phoneDetail: `Stopped · ${short}`,
      warn: true,
      ...(short !== name ? { speech: `Marked read. ${name} was stopped.` } : {}),
    };
  }
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
