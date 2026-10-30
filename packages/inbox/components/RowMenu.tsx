import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { Icon, type IconName } from '../icons';
import { rowMenuActions, type RowMenuAction } from '../rowMenu';
import { rowInSlot } from '../settle';

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

/** A touch (or a long press that a phone turns into `contextmenu`) never opens the menu: phones have none. */
const TOUCH_WINDOW_MS = 1500;

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
 * The look is the project menu's (`.ib-pm`).
 */
export const ThreadRowMenu = forwardRef<HTMLDivElement, ThreadRowMenuProps>(function ThreadRowMenu(props, ref) {
  const body = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => body.current!, []);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // The row the menu is aimed at, by id: its items are read from the row as it is now, every render.
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = targetId ? props.rowOf(targetId) : null;
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  /** The row focus goes back to. Kept after the menu closes: Base UI asks for it once the close has begun. */
  const focusId = useRef<string | null>(null);
  /** A write (Mark read, Move back, Archive) on a row that may leave the rows on screen: where focus goes then. */
  const pendingFocus = useRef<{ id: string; order: string[]; until: number; state: string } | null>(null);
  /** What a write changes on a row: once it differs, the write has landed. */
  const rowState = (id: string) => {
    const row = props.rowOf(id);
    return row ? `${row.section}|${row.read_at ?? ''}|${row.resolved_at ?? ''}` : '';
  };
  /** The rows' order when the menu opened: the slot to fall back to if the row leaves while it is open. */
  const openOrder = useRef<string[]>([]);
  /** The guard against the browser's own menu for the key's keyup (Chromium on Windows), while ours is open. */
  const keyGuard = useRef<(() => void) | null>(null);
  const lastTouch = useRef(0);
  const aim = (id: string | null) => {
    if (id) focusId.current = id;
    setTargetId(id);
    props.onTarget(id);
  };
  const setOpenNow = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
  };
  const close = () => {
    setOpenNow(false);
    aim(null);
  };
  /** A row's own button now (it may have been drawn again while the menu was open). */
  const buttonFor = (id: string | null): HTMLElement | null => {
    if (!id || !body.current) return null;
    return body.current.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`);
  };
  const rowOrder = () => [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
  /** The row's button, else (it left the rows on screen) the row in its slot, else the first band. */
  const focusTarget = (id: string | null, order: readonly string[]): HTMLElement | null => {
    const own = buttonFor(id);
    if (own || !id) return own;
    const next = rowInSlot(order, id, (other) => buttonFor(other) !== null);
    return next ? buttonFor(next) : (body.current?.querySelector<HTMLElement>('button.ib-band') ?? null);
  };
  // The row aimed at left the list while its menu was open: nothing left to act on.
  useEffect(() => {
    if (open && targetId && !target) close();
  });
  // After a write the row may leave the rows on screen (Archive, or Mark read into folded Quiet) once the
  // list reads again: focus that fell to the page goes to the row in its slot.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    // A thread opened, or time ran out: never move focus later, out of the blue.
    if (props.held || Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    if (buttonFor(pending.id)) {
      // The write landed and the row is still on screen: nothing to do.
      if (rowState(pending.id) !== pending.state) pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    focusTarget(pending.id, pending.order)?.focus({ preventScroll: true });
  });
  useEffect(() => () => keyGuard.current?.(), []);
  /**
   * Chromium on Windows sends the context-menu key's `contextmenu` on keyup, after ours opened on keydown:
   * while our menu is open, that one event is cancelled before the browser draws its own menu. One listener,
   * gone after that event or a second.
   */
  const guardKeyup = () => {
    keyGuard.current?.();
    const swallow = (event: Event) => {
      if (!openRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      done();
    };
    const timer = setTimeout(() => done(), 1000);
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('contextmenu', swallow, true);
      window.removeEventListener('pointerdown', done, true);
      if (keyGuard.current === done) keyGuard.current = null;
    };
    window.addEventListener('contextmenu', swallow, true);
    // A pointer press first means the next `contextmenu` is a right-click (macOS and Safari send no keyup
    // one): the guard goes, so it never swallows it.
    window.addEventListener('pointerdown', done, true);
    keyGuard.current = done;
  };
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
        // With a thread open the row stays in place: nothing to follow. A pin never moves a row.
        if (action !== 'copy-thread' && action !== 'copy-link' && action !== 'copy-id' && action !== 'pin' && action !== 'unpin' && !props.held) {
          pendingFocus.current = { id: target.thread_id, order: rowOrder(), until: Date.now() + 5000, state: rowState(target.thread_id) };
        }
        props.onAction(target, action);
      }}
    >
      <Icon name={LABELS[action].icon} size={15} />
      {LABELS[action].label}
    </Menu.Item>
  );
  return (
    <ContextMenu.Root
      disabled={props.disabled}
      open={open}
      onOpenChange={(next) => {
        setOpenNow(next);
        if (!next) aim(null);
      }}
    >
      <ContextMenu.Trigger
        ref={body}
        className={props.className}
        // Buttons and the empty list's link keep the platform's own long-press callout.
        style={{ WebkitTouchCallout: 'default' }}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') lastTouch.current = Date.now();
        }}
        // No long press: Base UI's touch handler never runs.
        onTouchStart={(event) => event.preventBaseUIHandler()}
        onKeyDown={(event) => {
          // The context-menu key and Shift+F10 on a focused row. Chromium on macOS (and Safari) send no
          // `contextmenu` for them, so the list sends one at the row; where the browser would, its own is
          // cancelled with the keydown.
          if (props.disabled || event.nativeEvent.isComposing) return;
          // Tab before focus has moved into the menu: it closes, and focus stays on the row.
          if (open && event.key === 'Tab') {
            event.preventDefault();
            close();
            return;
          }
          const key = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey);
          if (!key) return;
          const button = rowElementOf(event.target);
          if (!button) return;
          event.preventDefault();
          const rect = button.getBoundingClientRect();
          button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 24, clientY: rect.bottom }));
          if (openRef.current) guardKeyup();
        }}
        onContextMenu={(event) => {
          if (props.disabled) return;
          const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
          const touch = pointerType === 'touch' || (!pointerType && Date.now() - lastTouch.current < TOUCH_WINDOW_MS);
          const button = touch ? null : rowElementOf(event.target);
          const row = button ? props.rowOf(button.getAttribute('data-thread-id')!) : null;
          if (!row) {
            // Not on a row (a band, the Show line, the empty list), or a touch: the browser's own menu.
            // Base UI also cancels any `contextmenu` inside its trigger from a document listener: stopping the
            // event at the list keeps the browser's menu (a link's "Open in new tab", for one).
            event.preventBaseUIHandler();
            event.stopPropagation();
            return;
          }
          openOrder.current = rowOrder();
          aim(row.thread_id);
        }}
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup
            className="ib-pm"
            aria-label={target?.subject ?? 'Thread'}
            data-row-menu={target?.thread_id}
            // Focus goes back to the row (Escape, Tab, an item), never where it was before the right-click.
            finalFocus={() => focusTarget(focusId.current, openOrder.current) ?? true}
            onKeyDown={(event) => {
              // Tab leaves the menu for the row it came from (Base UI keeps focus in a context menu).
              if (event.key !== 'Tab') return;
              event.preventDefault();
              close();
            }}
          >
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
