import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContextMenu } from '@base-ui/react/context-menu';
import type { Menu } from '@base-ui/react/menu';
import { rowInSlot } from '../settle';

/** A touch (or a long press that a phone turns into `contextmenu`) never opens the menu: phones have none. */
const TOUCH_WINDOW_MS = 1500;

/** Where focus goes when the item the menu was aimed at has left the screen. */
export interface MenuSlot {
  /** The items' ids on screen, in order: the item now in the gone one's slot takes focus. */
  order: readonly string[];
  /** Nothing left in the slot: this takes focus (read when focus moves, not when the slot was taken). */
  fallback: () => HTMLElement | null;
}

export interface ContextMenuTriggerOptions {
  /** The item's own button a `contextmenu` (or a key) at this target names, or null when it names none. */
  itemOf: (target: EventTarget | null) => HTMLElement | null;
  /** The id an item's button carries. */
  idOf: (item: HTMLElement) => string | null;
  /** Whether the item is still there to act on (the data, not the screen). */
  has: (id: string) => boolean;
  /** The item's own button now (it may have been drawn again, or elsewhere, while the menu was open). */
  buttonFor: (id: string) => HTMLElement | null;
  /** The slot the item sits in now: kept when the menu opens and when an item writes. */
  slotOf: (id: string) => MenuSlot;
  /** What a write changes on the item: once it differs, the write has landed. */
  stateOf: (id: string) => string;
  /** No menu: the browser's own. */
  disabled?: boolean;
  /** The items hold still (a thread is open): a write is not followed. */
  held?: boolean;
  /**
   * A write that moves the item and draws it again elsewhere (a card into another lane): focus that fell to the
   * page goes to its button there. Off: a written item still on screen is left as it is.
   */
  followMoves?: boolean;
  /** The item the menu is aimed at (its muted look), or null when it closes. */
  onTarget: (id: string | null) => void;
}

/**
 * The trigger side of a right-click menu over a body of items (the thread
 * rows, the Board's cards): one menu for the whole body, aimed at the item a
 * right-click (or the platform's context-menu key, or Shift+F10, on a focused
 * item) lands on. Anywhere else in the body the browser's own menu shows. A
 * touch never opens it (no long press: phones have no menu here). Escape, Tab
 * and an item put focus on the item's own button (wherever focus was before
 * the right-click); a write that takes the item off screen puts it on the item
 * now in its slot (`follow`). The caller draws the items and acts on them.
 */
export function useContextMenuTrigger(options: ContextMenuTriggerOptions) {
  const { disabled } = options;
  // The item the menu is aimed at, by id: its items are read from the data as it is now, every render.
  const [targetId, setTargetId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  /** The item focus goes back to. Kept after the menu closes: Base UI asks for it once the close has begun. */
  const focusId = useRef<string | null>(null);
  /** An item chose to put focus somewhere itself (it opened a page or a panel): the close moves none. */
  const keepFocus = useRef(false);
  /** A write on an item that may leave the items on screen: where focus goes then. */
  const pendingFocus = useRef<{ id: string; slot: MenuSlot; until: number; state: string } | null>(null);
  /** The item's slot when the menu opened: the slot to fall back to if the item leaves while it is open. */
  const openSlot = useRef<MenuSlot | null>(null);
  /** The guard against the browser's own menu for the key's keyup (Chromium on Windows), while ours is open. */
  const keyGuard = useRef<(() => void) | null>(null);
  const lastTouch = useRef(0);
  const aim = (id: string | null) => {
    if (id) focusId.current = id;
    setTargetId(id);
    options.onTarget(id);
  };
  const setOpenNow = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
  };
  const close = () => {
    setOpenNow(false);
    aim(null);
  };
  /** The item's button, else (it left the items on screen) the item in its slot, else the slot's fallback. */
  const focusTarget = (id: string | null, slot: MenuSlot | null): HTMLElement | null => {
    const own = id ? options.buttonFor(id) : null;
    if (own || !id) return own;
    const next = slot ? rowInSlot(slot.order, id, (other) => options.buttonFor(other) !== null) : null;
    return next ? options.buttonFor(next) : (slot?.fallback() ?? null);
  };
  // The item aimed at left while its menu was open: nothing left to act on.
  useEffect(() => {
    if (open && targetId && !options.has(targetId)) close();
  });
  // After a write the item may leave the items on screen once the data reads again: focus that fell to the
  // page goes to the item in its slot (or, `followMoves`, to the item drawn again elsewhere).
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    // The items hold still, or time ran out: never move focus later, out of the blue.
    if (options.held || Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    const own = options.buttonFor(pending.id);
    if (own) {
      // The write landed and the item is still on screen.
      if (options.stateOf(pending.id) === pending.state) return;
      pendingFocus.current = null;
      if (options.followMoves && focusFell()) own.focus({ preventScroll: true });
      return;
    }
    pendingFocus.current = null;
    if (!focusFell()) return;
    focusTarget(pending.id, pending.slot)?.focus({ preventScroll: true });
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

  const root = {
    disabled,
    open,
    onOpenChange: (next: boolean) => {
      setOpenNow(next);
      if (!next) aim(null);
    },
  };
  const trigger: Pick<ContextMenu.Trigger.Props, 'onPointerDown' | 'onTouchStart' | 'onKeyDown' | 'onContextMenu'> = {
    onPointerDown: (event) => {
      if (event.pointerType === 'touch') lastTouch.current = Date.now();
    },
    // No long press: Base UI's touch handler never runs.
    onTouchStart: (event) => event.preventBaseUIHandler(),
    onKeyDown: (event) => {
      // The context-menu key and Shift+F10 on a focused item. Chromium on macOS (and Safari) send no
      // `contextmenu` for them, so the body sends one at the item; where the browser would, its own is
      // cancelled with the keydown.
      if (disabled || event.nativeEvent.isComposing) return;
      // Tab before focus has moved into the menu: it closes, and focus stays on the item.
      if (open && event.key === 'Tab') {
        event.preventDefault();
        close();
        return;
      }
      const key = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey);
      if (!key) return;
      const button = options.itemOf(event.target);
      if (!button) return;
      event.preventDefault();
      const rect = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 24, clientY: rect.bottom }));
      if (openRef.current) guardKeyup();
    },
    onContextMenu: (event) => {
      if (disabled) return;
      const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
      const touch = pointerType === 'touch' || (!pointerType && Date.now() - lastTouch.current < TOUCH_WINDOW_MS);
      const button = touch ? null : options.itemOf(event.target);
      const id = button ? options.idOf(button) : null;
      if (!id || !options.has(id)) {
        // Not on an item, or a touch: the browser's own menu. Base UI also cancels any `contextmenu` inside
        // its trigger from a document listener: stopping the event at the body keeps the browser's menu (a
        // link's "Open in new tab", for one).
        event.preventBaseUIHandler();
        event.stopPropagation();
        return;
      }
      keepFocus.current = false;
      openSlot.current = options.slotOf(id);
      aim(id);
    },
  };
  const popup: Pick<Menu.Popup.Props, 'finalFocus' | 'onKeyDown'> = {
    // Focus goes back to the item (Escape, Tab, an item), never where it was before the right-click.
    finalFocus: () => (keepFocus.current ? false : (focusTarget(focusId.current, openSlot.current) ?? true)),
    onKeyDown: (event) => {
      // Tab leaves the menu for the item it came from (Base UI keeps focus in a context menu).
      if (event.key !== 'Tab') return;
      event.preventDefault();
      close();
    },
  };
  return {
    /** The item the menu is aimed at, or null. */
    targetId,
    open,
    close,
    /** An item writes to `id`: if that takes it off screen (or, `followMoves`, elsewhere), focus follows. */
    follow: (id: string) => {
      if (options.held) return;
      pendingFocus.current = { id, slot: options.slotOf(id), until: Date.now() + 5000, state: options.stateOf(id) };
    },
    /** An item puts focus somewhere itself (a page, a panel): the menu's close moves none. */
    keepFocus: () => {
      keepFocus.current = true;
    },
    root,
    trigger,
    popup,
  };
}

/** Whether focus fell to the page (its element gone, or nothing focused): only then is it moved for the person. */
function focusFell(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}
