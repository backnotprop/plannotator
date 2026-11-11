import { INBOX_SECTIONS, inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { waitCount } from './format';
import { threadChipName } from './threadChip';

export type PinnedStateKind = 'stop' | 'hold' | 'wait' | 'new' | 'sent' | 'quiet' | 'archived';

export interface PinnedState {
  kind: PinnedStateKind;
  words: string;
  n: number;
  calm: boolean;
}

export function pinnedState(row: InboxListRow): PinnedState {
  if (inboxRowArchived(row)) return { kind: 'archived', words: 'Archived', n: 0, calm: true };
  switch (row.section) {
    case 'stopped':
      return { kind: 'stop', words: 'Stopped', n: 0, calm: false };
    case 'holding': {
      const n = row.questions.holds_up.length;
      return { kind: 'hold', words: `Holds up ${n}`, n, calm: false };
    }
    case 'waiting': {
      const n = row.questions.open;
      return { kind: 'wait', words: waitCount(n, row.questions.actions ?? 0), n, calm: false };
    }
    case 'new':
      return row.unseen > 0 ? { kind: 'new', words: 'New', n: 0, calm: false } : { kind: 'quiet', words: 'Draft', n: 0, calm: true };
    case 'sent':
      return { kind: 'sent', words: 'Sent', n: 0, calm: true };
    default:
      return { kind: 'quiet', words: (row.read_at ?? null) !== null ? 'Read' : 'Quiet', n: 0, calm: true };
  }
}

export function pinnedLabel(row: InboxListRow): string {
  const subject = row.subject ?? '(no subject)';
  return (row.thread_name?.trim() ? threadChipName(row.thread_name, subject) : null) ?? subject;
}

export function pinnedRowName(row: InboxListRow, project: string = row.project.name): string {
  const label = pinnedLabel(row);
  const subject = row.subject ?? '(no subject)';
  return `${label}, ${label === subject ? '' : `${subject}, `}${project}, ${pinnedState(row).words}`;
}

export function movePin(order: readonly string[], threadId: string, by: -1 | 1): string[] {
  const next = [...order];
  const at = next.indexOf(threadId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= next.length) return next;
  next[at] = next[to]!;
  next[to] = threadId;
  return next;
}

export function unpinnedWhere(row: InboxListRow | null | undefined): string {
  if (!row) return 'Still in the Inbox';
  if (inboxRowArchived(row)) return 'Still in Archived';
  const label = INBOX_SECTIONS.find((section) => section.id === row.section)?.label;
  return label ? `Still in ${label}` : 'Still in the Inbox';
}
