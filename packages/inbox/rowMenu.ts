import { inboxRowArchived, type InboxListGroupId, type InboxListRow } from '@plannotator/core/inbox-types';
import { canMarkUnread, canToggleRead, offersRowMarkRead } from './markRead';

export type RowMenuAction = 'pin' | 'unpin' | 'copy-thread' | 'copy-link' | 'copy-id' | 'snooze' | 'unsnooze' | 'read' | 'mark-unread' | 'unread' | 'archive';

export function threadLink(threadId: string, base: { url?: string | null; via?: 'local' | 'tailnet' } | null, origin: string, messageId?: string | null): string {
  const root = base?.url && base.via !== 'tailnet' ? base.url : `${origin}/`;
  return `${root.endsWith('/') ? root : `${root}/`}#thread=${threadId}${messageId ? `&msg=${messageId}` : ''}`;
}

export function rowMenuActions(row: InboxListRow, canMarkRead: boolean, pinned: boolean | null = null, drawn: InboxListGroupId | null = null, canSnooze = false): RowMenuAction[] {
  const actions: RowMenuAction[] = [];
  if (pinned !== null) actions.push(pinned ? 'unpin' : 'pin');
  actions.push('copy-thread', 'copy-link', 'copy-id');
  if (canSnooze && !inboxRowArchived(row)) actions.push(...(row.snoozed ? (['snooze', 'unsnooze'] as const) : (['snooze'] as const)));
  if (canMarkRead) {
    if (offersRowMarkRead(row, drawn)) actions.push('read');
    if (canMarkUnread(row)) actions.push('mark-unread');
    if ((row.read_at ?? null) !== null && canToggleRead(row)) actions.push('unread');
  }
  if (row.resolved_at === null) actions.push('archive');
  return actions;
}
