import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { Icon, type IconName } from '../icons';
import { rowMenuActions, type RowMenuAction } from '../rowMenu';
import { useContextMenuTrigger } from './useContextMenuTrigger';

export interface ThreadRowMenuProps {
  className: string;
  /** Finds a listed row by its thread id (the menu is one for the whole list). */
  rowOf: (threadId: string) => InboxListRow | null;
  /** The group a listed row sits in on screen (a held list can draw a row where its state no longer puts it). */
  sectionOf?: (threadId: string) => InboxSectionId | null;
  /** Mark read and Move back are offered (the list has the row's hover action). */
  canMarkRead: boolean;
  /**
   * Whether a thread is pinned to the sidebar (approval "inbox-pinned-threads"): Pin thread or Unpin
   * thread leads the menu, in its own group. Absent (an older Inbox keeps no pins): no item.
   */
  pinnedOf?: (threadId: string) => boolean;
  onAction: (row: InboxListRow, action: RowMenuAction) => void;
  /** The row whose menu is open (its muted background), or null when it closes. */
  onTarget: (threadId: string | null) => void;
  /** No menu (the host gave no actions): the browser's own. */
  disabled?: boolean;
  /**
   * A thread is open, so the list holds still (held.ts): a row written from the menu stays in place, and
   * where focus goes when the thread closes is App's rule, not the menu's.
   */
  held: boolean;
  children: ReactNode;
}

const LABELS: Record<RowMenuAction, { label: string; icon: IconName }> = {
  pin: { label: 'Pin thread', icon: 'pin' },
  unpin: { label: 'Unpin thread', icon: 'pinOff' },
  'copy-thread': { label: 'Copy thread', icon: 'stack' },
  'copy-link': { label: 'Copy link', icon: 'link' },
  'copy-id': { label: 'Copy thread ID', icon: 'hash' },
  read: { label: 'Mark read', icon: 'checkCircle' },
  unread: { label: 'Move back', icon: 'inbox' },
  archive: { label: 'Archive', icon: 'archive' },
};

/** The row a `contextmenu` event names: a wide or three-line row (its wrapper, `data-row`), or a phone's row. */
function rowElementOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest<HTMLElement>('[data-row]');
  if (wrapper) return wrapper.querySelector<HTMLElement>('[data-thread-id]');
  return target.closest<HTMLElement>('.ib-mrow[data-thread-id]');
}

/**
 * The thread rows' right-click menu: one menu for the whole list (its body is
 * the trigger), aimed at the row the right-click (or the platform's
 * context-menu key, or Shift+F10, on a focused row) lands on. Pin thread (or
 * Unpin thread) in its own group, then Copy thread, Copy link, Copy thread ID, then Mark
 * read (or Move back) and Archive where they apply.
 * Anywhere else in the list the browser's own menu shows. Opening it never
 * opens the thread or moves the selection. Escape, Tab and an item put focus
 * on the row (wherever focus was before the right-click); a write that takes
 * the row off screen puts it on the row now in its slot. A touch never opens it (no long press: phones have no menu here).
 * The look is the project menu's (`.ib-pm`); the trigger's rules are
 * `useContextMenuTrigger`'s, shared with the Board's card menu.
 */
export const ThreadRowMenu = forwardRef<HTMLDivElement, ThreadRowMenuProps>(function ThreadRowMenu(props, ref) {
  const body = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => body.current!, []);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  /** A row's own button now (it may have been drawn again while the menu was open). */
  const buttonFor = (id: string): HTMLElement | null => body.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`) ?? null;
  const rowOrder = () => [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
  const menu = useContextMenuTrigger({
    itemOf: rowElementOf,
    idOf: (button) => button.getAttribute('data-thread-id'),
    has: (id) => props.rowOf(id) !== null,
    buttonFor,
    // A row that left the rows on screen: the row now in its slot, else the first band.
    slotOf: () => ({ order: rowOrder(), fallback: () => body.current?.querySelector<HTMLElement>('button.ib-band') ?? null }),
    // What a write (Mark read, Move back, Archive) changes on a row: once it differs, the write has landed.
    stateOf: (id) => {
      const row = props.rowOf(id);
      return row ? `${row.section}|${row.read_at ?? ''}|${row.resolved_at ?? ''}` : '';
    },
    disabled: props.disabled,
    held: props.held,
    onTarget: props.onTarget,
  });
  const target = menu.targetId ? props.rowOf(menu.targetId) : null;
  const actions = target ? rowMenuActions(target, props.canMarkRead, props.pinnedOf ? props.pinnedOf(target.thread_id) : null, props.sectionOf?.(target.thread_id) ?? null) : [];
  const pinning = actions.filter((a) => a === 'pin' || a === 'unpin');
  const copies = actions.filter((a) => a === 'copy-thread' || a === 'copy-link' || a === 'copy-id');
  const writes = actions.filter((a) => a === 'read' || a === 'unread' || a === 'archive');
  const item = (action: RowMenuAction) => (
    <Menu.Item
      key={action}
      className="ib-pmi"
      label={LABELS[action].label}
      data-row-action={action}
      onClick={() => {
        if (!target) return;
        // With a thread open the row stays in place: nothing to follow (`held`). A pin never moves a row.
        if (action !== 'copy-thread' && action !== 'copy-link' && action !== 'copy-id' && action !== 'pin' && action !== 'unpin') menu.follow(target.thread_id);
        props.onAction(target, action);
      }}
    >
      <Icon name={LABELS[action].icon} size={15} />
      {LABELS[action].label}
    </Menu.Item>
  );
  return (
    <ContextMenu.Root {...menu.root}>
      {/* Buttons and the empty list's link keep the platform's own long-press callout (the hook's `style`). */}
      <ContextMenu.Trigger ref={body} className={props.className} {...menu.trigger}>
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup className="ib-pm" aria-label={target?.subject ?? 'Thread'} data-row-menu={target?.thread_id} {...menu.popup}>
            {/* Pin thread first, in its own group (approval "inbox-pinned-threads"). */}
            {pinning.map(item)}
            {pinning.length > 0 && <Menu.Separator className="ib-pm-sep" />}
            {copies.map(item)}
            {writes.length > 0 && <Menu.Separator className="ib-pm-sep" />}
            {writes.map(item)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
