/**
 * Mark read (design record "inbox-mark-read", approved 2026-10-11; not in
 * this repo): which threads take it, and what the window says after it.
 * Pure.
 *
 * Mark read moves a thread out of the top to Quiet without archiving it: its
 * questions still waiting on the person close unanswered (each a skip), and once the Undo window has passed the asking agent is told
 * once not to wait on them. It comes back when an agent writes again.
 */

import { summarizeInboxQuestions } from '@plannotator/core/inbox-questions';
import { inboxRowOffersMarkRead, inboxRowWaitsOnPerson, type InboxListRow, type InboxListGroupId, type InboxThread } from '@plannotator/core/inbox-types';
import { agentName, plural, shortAgentName } from './format';

/** How long the Undo toast stays (the server's set-aside note waits a little longer). */
export const MARK_READ_UNDO_MS = 7_000;

/**
 * How long Mark read waits for a look this tab sent to land before it decides
 * (App.tsx `markRead`): past it, it decides on the state it has.
 */
export const MARK_READ_LOOK_WAIT_MS = 1_500;

/**
 * Mark unread that the server answered with nothing to do while this tab's
 * look was still on its way (slower than MARK_READ_LOOK_WAIT_MS): how long it
 * waits for that look before it tries once more (App.tsx `markUnread`).
 */
export const MARK_UNREAD_RETRY_WAIT_MS = 10_000;

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
 * Mark read in the row menu (and, where the row offers no Mark unread, its
 * hover action): on rows that wait on the person, never on Sent or Quiet,
 * except a row the list still draws in New (`seenHeldInNew`).
 */
export function offersRowMarkRead(row: Parameters<typeof inboxRowOffersMarkRead>[0], drawn?: InboxListGroupId | null): boolean {
  return inboxRowOffersMarkRead(row) || seenHeldInNew(row, drawn);
}

/**
 * A plain update the person opened, which the list still draws in New
 * (`drawn`, the group the row sits in on screen): the look put it in Quiet on
 * the server, but while a thread is open the list holds still (held.ts), so
 * the row waits in New until the list settles. Mark read stays offered on it
 * there (the row menu, `E`; a phone has neither, so its thread ⋯ sheet offers
 * it), and only moves the row to Quiet now: nothing is written, since the
 * thread is already Quiet. The row's hover action and the header's read button
 * are Mark unread on it (the owner, 2026-11-02: "If I open a thread, and it
 * transitions to [read] ... I need the ability to mark unread"); a phone's
 * bar has no read button, so its ⋯ sheet offers both.
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
 * that waits on the person (Mark read's). A seen update the list still holds
 * in New takes it too, on the row's hover action and the header's read button
 * (the owner, 2026-11-02); its Mark read stays in the row menu and on `E`. A
 * phone has neither the row menu nor `E` (nor a read button in its bar), so
 * its thread ⋯ sheet offers Mark read and Mark unread there.
 */
export function canMarkUnread(
  row: Pick<InboxListRow, 'section' | 'unseen' | 'answered_not_sent' | 'resolved_at' | 'unread' | 'sent'> & { read_at?: string | null },
): boolean {
  if (row.resolved_at !== null || row.unread) return false;
  if (waitsOnPerson(row)) return false;
  return row.sent === null;
}

/**
 * What a Mark read would set aside (the owner's ask, 2026-11-10: "warn the user if it will close out questions with
 * a set-aside message to the agent"): the questions and action items still waiting on the person in the rows it
 * takes. The store's `markRead` closes every question that is open or picked and not sent, and every open action
 * item; the row's summary counts exactly those (`open` takes the action items, `picked` only questions). `threads`:
 * how many of the rows hold any. A snoozed row is left out: Mark all as read never takes one.
 */
export interface SetAsideCount {
  questions: number;
  actions: number;
  threads: number;
}

export function setAsideCount(
  rows: readonly (Pick<InboxListRow, 'questions'> & { snoozed?: InboxListRow['snoozed'] })[],
  options: { skipSnoozed?: boolean } = {},
): SetAsideCount {
  const out: SetAsideCount = { questions: 0, actions: 0, threads: 0 };
  for (const row of rows) {
    if (options.skipSnoozed && row.snoozed) continue;
    const actions = row.questions.actions ?? 0;
    const questions = Math.max(0, row.questions.open - actions) + row.questions.picked;
    if (questions + actions === 0) continue;
    out.questions += questions;
    out.actions += actions;
    out.threads += 1;
  }
  return out;
}

/** What Mark read would set aside: the list's row, or for a thread the list has no row for, the open thread's own questions. */
export function setAsideOf(row: InboxListRow | undefined, open: Pick<InboxThread, 'messages'> | null): SetAsideCount {
  if (row) return setAsideCount([row]);
  if (!open) return setAsideCount([]);
  const asked = open.messages.filter((m) => m.author.kind === 'agent').flatMap((m) => [...(m.questions ?? []), ...(m.actions ?? [])]);
  return setAsideCount([{ questions: summarizeInboxQuestions(asked) }]);
}

/** The person's answer to the warning: Cancel, or go on (and, with `never`, stop asking). */
export type SetAsideAnswer = { go: false } | { go: true; never: boolean };

/** Whether the warning asks before this Mark read: the person has it on and something would be set aside. */
export function warnsBeforeRead(count: SetAsideCount, warnOn: boolean): boolean {
  return warnOn && count.questions + count.actions > 0;
}

/**
 * Whether a Mark read goes ahead: straight on when nothing would be set aside or the person turned the warning off;
 * else the warning asks (`ask`), and "Don't show this again" turns it off (`turnOff`) before the Mark read goes.
 */
export async function confirmSetAside(
  count: SetAsideCount,
  warnOn: boolean,
  ask: (count: SetAsideCount) => Promise<SetAsideAnswer>,
  turnOff: () => void,
): Promise<boolean> {
  if (!warnsBeforeRead(count, warnOn)) return true;
  const answer = await ask(count);
  if (!answer.go) return false;
  if (answer.never) turnOff();
  return true;
}

/** The warning's words (WORDS.md lists them for the owner). `bulk`: Mark all as read on a project. */
export function setAsideWarning(count: SetAsideCount, bulk: boolean): { title: string; body: string; go: string } {
  const what =
    count.actions === 0
      ? plural(count.questions, 'open question')
      : count.questions === 0
        ? plural(count.actions, 'action item')
        : `${plural(count.questions, 'open question')} and ${plural(count.actions, 'action item')}`;
  const one = count.questions + count.actions === 1;
  const them = one ? 'it' : 'them';
  const agent = count.threads > 1 ? 'the agents' : 'the agent';
  if (!bulk) return { title: `Set aside ${what}?`, body: `Mark read closes ${them} unanswered and tells ${agent} not to wait on ${them}.`, go: 'Mark read' };
  return {
    title: `Set aside ${what}?`,
    body: `Mark all as read closes ${them} unanswered in ${plural(count.threads, 'thread')} and tells ${agent} not to wait on ${them}.`,
    go: 'Mark all as read',
  };
}

/**
 * The toast after Mark unread (the subject names the row, as the list's Mark read toast does). `moved`: the thread
 * was the open one, which closes, and the list settles with its row back in New, so the toast says so. From a row
 * the list holds still (approval "inbox-list-view", R7): the row is bold where it is and goes to New when the list
 * next settles, so the toast names it only.
 */
export function markUnreadToast(before: Pick<InboxListRow, 'subject'>, moved: boolean): { lead: string; detail: string } {
  const subject = `“${before.subject ?? '(no subject)'}”`;
  return { lead: 'Marked unread', detail: moved ? `${subject} · back in New` : subject };
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
 * - `held`: a row that is not the open thread (another thread open, or none):
 *   the list holds still (settle.ts; approval "inbox-list-view", R7) and the
 *   row has not moved yet;
 * - `list`: the row has moved (a seen update held in New, moved to Quiet beside
 *   an open thread, App.tsx `moveSeenToQuiet`).
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
