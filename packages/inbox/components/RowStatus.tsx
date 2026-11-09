/**
 * Settings → Rows' Status mark (listLook.ts `statusMark`; approval "inbox-customize-rows", addendum 2026-11-07, from the
 * owner's notes-list picture): one small mark at the row's end in place of its open counts (the action pill and `?N`).
 *
 *  - Waiting on you: the row has an open question or action item (`questions.open`), whatever its section (Stopped on
 *    you, Holding up work, Waiting on you; a draft too). The counts' words are its name and its tooltip ("Waiting on
 *    you: 2 questions, 1 action item"), so the count is never lost. Stopped and Holds up keep their filled mark beside it.
 *  - Done: the row is in Quiet (archived, marked read, or read with nothing new), even with a question still open: a
 *    Mark read put it there, and its counts never showed (review of #2872).
 *  - Nothing otherwise: New (news, nothing asked) and Sent (the agent's turn, a Re-ask note waiting on it included).
 *
 * A done row's mark stands alone on screen (the owner, q-8e0e9490), but its name keeps why it is Quiet: "Done, read".
 *
 * Off (the default), the row draws its counts as before.
 */
import { inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { waitCount } from '../format';
import { rowActionCount } from './RowBadge';
import { RowTip } from './RowTip';

export type RowStatus = 'waiting' | 'done';

/** What the row's status mark says, or null for none. */
export function rowStatus(row: Pick<InboxListRow, 'questions' | 'section' | 'resolved_at' | 'back_from_archive'>): RowStatus | null {
  if (inboxRowArchived(row) || row.section === 'quiet') return 'done';
  if (row.section === 'sent') return null;
  return row.questions.open > 0 ? 'waiting' : null;
}

/** Why a done row is Quiet, in the words its row would show without the mark: "archived", "read", "👍 Looks good". */
function quietReason(row: InboxListRow): string | null {
  if (inboxRowArchived(row)) return 'archived';
  if (row.section !== 'quiet' || (row.read_at ?? null) === null) return null;
  return row.ack ? `👍 ${row.ack.label}` : 'read';
}

/** The mark's name for a screen reader: its words, and on a done row why it is Quiet ("Done, read"). */
export function rowStatusName(row: InboxListRow): string | null {
  const words = rowStatusWords(row);
  const reason = rowStatus(row) === 'done' ? quietReason(row) : null;
  return words && reason ? `${words}, ${reason}` : words;
}

/** The mark's name and tooltip: "Waiting on you: 1 question", "Waiting on you: 2 questions, 1 action item", "Done". */
export function rowStatusWords(row: InboxListRow): string | null {
  const status = rowStatus(row);
  if (status === 'done') return 'Done';
  if (status !== 'waiting') return null;
  const actions = rowActionCount(row);
  return `Waiting on you: ${waitCount(row.questions.open, actions) || (actions > 0 ? '1 action item' : '1 question')}`;
}

/** Waiting: a ring half filled from below. Done: a ring with a tick. 16 px, in the mark's colour. */
function StatusIcon({ status }: { status: RowStatus }) {
  return (
    <svg className="ib-stm-ic" viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      {status === 'waiting' ? <path d="M4.25 8.75h7.5a3.75 3.75 0 0 1-7.5 0Z" fill="currentColor" stroke="none" /> : <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />}
    </svg>
  );
}

/** The mark, or nothing. Its name (`rowStatusName`) is visually hidden text; with `tip`, its words are its tooltip (a phone has none). */
export function StatusMark({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  const status = rowStatus(row);
  const words = rowStatusWords(row);
  if (!status || !words) return null;
  const mark = (
    <span className="ib-stm" data-status={status} data-status-count={status === 'waiting' ? row.questions.open : undefined}>
      <StatusIcon status={status} />
      {/* Spaced, so the row's name never runs it into the words before it. */}
      <span className="ib-sr">{` ${rowStatusName(row)} `}</span>
    </span>
  );
  return tip ? <RowTip content={words}>{mark}</RowTip> : mark;
}
