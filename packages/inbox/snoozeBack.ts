import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxRowSnoozed } from '@plannotator/core/inbox-snooze';

export interface SnoozeBack {
  threadId: string;
  until: string;
}

export function snoozeBackAfter(current: SnoozeBack | null, threadId: string | null, row: Pick<InboxListRow, 'snoozed' | 'snooze_back'> | null): SnoozeBack | null {
  const kept = threadId && current?.threadId === threadId ? current : null;
  if (!threadId || !row) return kept;
  if (inboxRowSnoozed(row)) return null;
  if (!row.snooze_back) return kept;
  return kept?.until === row.snooze_back ? kept : { threadId, until: row.snooze_back };
}

export function snoozeBackAbove(messages: readonly { id: string }[], fresh: ReadonlySet<string>): string | null {
  return (messages.find((message) => fresh.has(message.id)) ?? messages[messages.length - 1])?.id ?? null;
}
