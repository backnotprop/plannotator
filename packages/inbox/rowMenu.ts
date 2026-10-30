/**
 * The thread row's right-click menu (the owner's ask, 2026-10-20: "right
 * click on a thread row and … copy the thread URL"): what it offers for a
 * row, and the link it copies. Pure.
 */

import type { InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { canToggleRead, offersRowMarkRead } from './markRead';

export type RowMenuAction = 'pin' | 'unpin' | 'copy-thread' | 'copy-link' | 'copy-id' | 'read' | 'unread' | 'archive';

/**
 * The thread's address: the Inbox's one address on this computer
 * (`http://localhost:<port>/`, the settings' `url`, which is what the MCP
 * tools hand agents) plus `#thread=<id>`. A page opened over the tailnet
 * copies its own origin instead, the address the device it is on can open.
 * Before the settings load, the window's own origin (on loopback it is the
 * one address already: other spellings redirect there).
 *
 * `messageId`: a link to one message of the thread (`&msg=<id>`, the
 * address a search result lands with): the thread opens there, the message
 * unfolded, centred and ringed.
 */
export function threadLink(threadId: string, base: { url?: string | null; via?: 'local' | 'tailnet' } | null, origin: string, messageId?: string | null): string {
  const root = base?.url && base.via !== 'tailnet' ? base.url : `${origin}/`;
  return `${root.endsWith('/') ? root : `${root}/`}#thread=${threadId}${messageId ? `&msg=${messageId}` : ''}`;
}

/**
 * What the menu offers for a row, in order. Pin thread (Unpin thread on a
 * pinned row) first, in its own group, when the Inbox keeps pins (`pinned`
 * is null on an older one: no item); then Copy thread (its Markdown,
 * copyMarkdown.ts), Copy link and Copy thread ID always; then Mark read where the row's hover action offers it, or Move
 * back on a row marked read; then Archive on a row not archived already (a
 * row shown archived in place, or one that came back from the archive,
 * which Mark read sends back there). `drawn`: the group the row sits in on
 * screen (a seen update the list still holds in New keeps Mark read).
 */
export function rowMenuActions(row: InboxListRow, canMarkRead: boolean, pinned: boolean | null = null, drawn: InboxSectionId | null = null): RowMenuAction[] {
  const actions: RowMenuAction[] = [];
  if (pinned !== null) actions.push(pinned ? 'unpin' : 'pin');
  actions.push('copy-thread', 'copy-link', 'copy-id');
  if (canMarkRead) {
    const read = (row.read_at ?? null) !== null;
    if (read && canToggleRead(row)) actions.push('unread');
    else if (!read && offersRowMarkRead(row, drawn)) actions.push('read');
  }
  if (row.resolved_at === null) actions.push('archive');
  return actions;
}
