import { inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { waitCount } from '../format';
import { rowActionCount } from './RowBadge';
import { RowTip } from './RowTip';

export type RowStatus = 'waiting' | 'done';

export function rowStatus(row: Pick<InboxListRow, 'questions' | 'section' | 'resolved_at' | 'back_from_archive'>): RowStatus | null {
  if (inboxRowArchived(row) || row.section === 'quiet') return 'done';
  if (row.section === 'sent') return null;
  return row.questions.open > 0 ? 'waiting' : null;
}

function quietReason(row: InboxListRow): string | null {
  if (inboxRowArchived(row)) return 'archived';
  if (row.section !== 'quiet' || (row.read_at ?? null) === null) return null;
  return row.ack ? `👍 ${row.ack.label}` : 'read';
}

export function rowStatusName(row: InboxListRow): string | null {
  const words = rowStatusWords(row);
  const reason = rowStatus(row) === 'done' ? quietReason(row) : null;
  return words && reason ? `${words}, ${reason}` : words;
}

export function rowStatusWords(row: InboxListRow): string | null {
  const status = rowStatus(row);
  if (status === 'done') return 'Done';
  if (status !== 'waiting') return null;
  const actions = rowActionCount(row);
  return `Waiting on you: ${waitCount(row.questions.open, actions) || (actions > 0 ? '1 action item' : '1 question')}`;
}

function StatusIcon({ status }: { status: RowStatus }) {
  return (
    <svg className="ib-stm-ic" viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      {status === 'waiting' ? <path d="M4.25 8.75h7.5a3.75 3.75 0 0 1-7.5 0Z" fill="currentColor" stroke="none" /> : <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />}
    </svg>
  );
}

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
