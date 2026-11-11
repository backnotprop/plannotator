import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import type { ContextMenu } from '@base-ui/react/context-menu';
import type { Menu } from '@base-ui/react/menu';
import { rowInSlot } from '../settle';

/** A touch's own `contextmenu` (a long press a phone turns into one) never opens the menu: only a hold does (`longPress`). */
const TOUCH_WINDOW_MS = 1500;
/** How long a finger rests on an item before its menu opens (`longPress`), and how far it may drift: a scroll or a swipe is never a press. */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 10;
/** The item takes its muted look this far into a hold: a tap, or a scroll's first moves, never flash it. */
const PRESS_LOOK_MS = 120;
/** After the lift that ends a long press, its click (on the item, the menu or the scrim now under it) does nothing for this long. */
const LIFT_MS = 400;
/** A finger held on an open menu whose lift is never heard is let go after this long. */
const HELD_LOST_MS = 10_000;

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
  /**
   * A finger held on an item (LONG_PRESS_MS, still within LONG_PRESS_SLOP) opens its menu, as a right-click does
   * (the thread rows). A second finger, a move, a scroll or a lift before then cancels it, and a tap is a tap. The
   * lift after the menu opens activates nothing. Off (every other menu): a touch never opens it.
   */
  longPress?: boolean;
}

/**
 * The trigger side of a right-click menu over a body of items (the thread
 * rows, the Board's cards): one menu for the whole body, aimed at the item a
 * right-click (or the platform's context-menu key, or Shift+F10, on a focused
 * item) lands on. Anywhere else in the body the browser's own menu shows. A
 * touch never opens it, unless the caller turns on `longPress` (a finger held on
 * an item opens the same menu). Escape, Tab
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
  const pendingFocus = useRef<{ id: string; slot: MenuSlot; until: number; state: string; moves: boolean } | null>(null);
  /** The item's slot when the menu opened: the slot to fall back to if the item leaves while it is open. */
  const openSlot = useRef<MenuSlot | null>(null);
  /** The guard against the browser's own menu for the key's keyup (Chromium on Windows), while ours is open. */
  const keyGuard = useRef<(() => void) | null>(null);
  const lastTouch = useRef(0);
  /** A finger resting on an item (`longPress`): its menu opens unless it moves, lifts or another finger comes. */
  const press = useRef<{ id: string; x: number; finger: EventTarget; looked: boolean; stop: () => void } | null>(null);
  /** The hold's own `contextmenu` is being sent: it is not a touch's, so the menu takes it. */
  const pressFiring = useRef(false);
  /** The finger that opened the menu is down, or has just lifted: its moves, its lift and its click do nothing. */
  const held = useRef<(() => void) | null>(null);
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
    // The items hold still (unless this write moves its item anyway), or time ran out: never move focus later, out of the blue.
    if ((options.held && !pending.moves) || Date.now() > pending.until) {
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
  useEffect(
    () => () => {
      keyGuard.current?.();
      press.current?.stop();
      held.current?.();
    },
    [],
  );
  /** The hold ends before the menu opens: the item loses the look it took. */
  const cancelPress = () => {
    const now = press.current;
    if (!now) return;
    press.current = null;
    now.stop();
    if (now.looked && !openRef.current) options.onTarget(null);
  };
  /**
   * The hold opened the menu while the finger is still down. Until it lifts its moves scroll nothing (nor pull the
   * list); its lift sends no click (nor the mouse events a browser makes of a touch), and for LIFT_MS after it any
   * click is swallowed: the item under the finger stays shut and the thread stays closed.
   */
  const holdFinger = (finger: EventTarget) => {
    held.current?.();
    let lift: ReturnType<typeof setTimeout> | null = null;
    const move = (event: Event) => {
      if (lift) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    const lifted = (event: Event) => {
      if ((event as TouchEvent).touches?.length > 0) return;
      if (event.type === 'touchend' && event.cancelable) event.preventDefault();
      lift ??= setTimeout(() => done(), LIFT_MS);
    };
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const off = listen(finger, [
      ['touchmove', move, false],
      ['touchend', lifted, false],
      ['touchcancel', lifted, true],
    ]);
    const clicks = listen(null, [
      ['click', swallow, false],
      ['mousedown', swallow, false],
      ['mouseup', swallow, false],
    ]);
    // A lift never heard (the finger's element left and took its events with it): let go after a while all the same.
    const lost = setTimeout(() => done(), HELD_LOST_MS);
    const done = () => {
      if (lift) clearTimeout(lift);
      clearTimeout(lost);
      off();
      clicks();
      if (held.current === done) held.current = null;
    };
    held.current = done;
  };
  /** The hold is long enough: the item's menu opens as a right-click at the finger opens it (under the item). */
  const openPress = () => {
    const now = press.current;
    if (!now) return;
    press.current = null;
    now.stop();
    const button = options.buttonFor(now.id);
    if (button && options.has(now.id)) {
      const rect = button.getBoundingClientRect();
      pressFiring.current = true;
      try {
        button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: now.x, clientY: rect.bottom }));
      } finally {
        pressFiring.current = false;
      }
    }
    if (openRef.current) holdFinger(now.finger);
    else if (now.looked) options.onTarget(null);
  };
  /** One finger lands on an item (`longPress`): the hold starts. */
  const startPress = (event: ReactTouchEvent) => {
    cancelPress();
    if (!options.longPress || disabled || openRef.current || event.touches.length !== 1) return;
    const button = options.itemOf(event.target);
    const id = button ? options.idOf(button) : null;
    if (!button || !id || !options.has(id)) return;
    const { clientX: x, clientY: y } = event.touches[0]!;
    const finger = event.target;
    const move = (next: Event) => {
      const touches = (next as TouchEvent).touches;
      const touch = touches?.[0];
      if (touches?.length !== 1 || !touch || Math.hypot(touch.clientX - x, touch.clientY - y) > LONG_PRESS_SLOP) cancelPress();
    };
    // A scroll of the list (or the page) the item is in, however it began.
    const scroll = (next: Event) => {
      if (next.target === document || (next.target instanceof Node && next.target.contains(button))) cancelPress();
    };
    // Another finger anywhere, a move past the slop, a lift, the system taking the touch (a scroll): no press.
    const off = listen(finger, [
      ['touchmove', move, true],
      ['touchend', cancelPress, true],
      ['touchcancel', cancelPress, true],
    ]);
    const others = listen(null, [
      ['touchstart', cancelPress, true],
      ['scroll', scroll, true],
    ]);
    const look = setTimeout(() => {
      if (press.current?.id !== id) return;
      press.current.looked = true;
      options.onTarget(id);
    }, PRESS_LOOK_MS);
    const timer = setTimeout(openPress, LONG_PRESS_MS);
    const stop = () => {
      clearTimeout(timer);
      clearTimeout(look);
      off();
      others();
    };
    press.current = { id, x, finger, looked: false, stop };
  };
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
      // The finger that opened it is still down or just lifted: whatever its lift lands on closes nothing.
      if (!next && held.current) return;
      setOpenNow(next);
      if (!next) aim(null);
    },
  };
  const trigger: Pick<ContextMenu.Trigger.Props, 'style' | 'onPointerDown' | 'onTouchStart' | 'onKeyDown' | 'onContextMenu'> = {
    // Base UI's trigger sets `-webkit-touch-callout: none`, which every link inside inherits: links and
    // buttons in the body keep the platform's own long-press callout (iOS's preview and Copy Link sheet).
    style: { WebkitTouchCallout: 'default' },
    onPointerDown: (event) => {
      if (event.pointerType === 'touch') lastTouch.current = Date.now();
    },
    // Base UI's own long press never runs: `longPress` is ours (the item's menu, its press rules).
    onTouchStart: (event) => {
      event.preventBaseUIHandler();
      startPress(event);
    },
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
      const touch = !pressFiring.current && (pointerType === 'touch' || (!pointerType && Date.now() - lastTouch.current < TOUCH_WINDOW_MS));
      if (touch && (press.current || held.current) && options.itemOf(event.target)) {
        // A phone's own `contextmenu` for the finger being held (Android sends one): no browser menu, no selection;
        // the hold opens the menu now if it has not yet.
        event.preventDefault();
        event.preventBaseUIHandler();
        event.stopPropagation();
        openPress();
        return;
      }
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
    /**
     * An item writes to `id`: if that takes it off screen (or, `followMoves`, elsewhere), focus follows. `moves`:
     * the write moves its item even while the items hold still (a snooze takes its row to the Snoozed band at once).
     */
    follow: (id: string, moves = false) => {
      if (options.held && !moves) return;
      pendingFocus.current = { id, slot: options.slotOf(id), until: Date.now() + 5000, state: options.stateOf(id), moves };
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

/**
 * Listens on the window (capture) and, when `finger` is given, on the element the finger landed on too: a touch's
 * events keep going to that element, and once it has left the document (the list drew it again) they reach nothing
 * else. Each listener is the window's capture one, or passive (`true`) or not. Returns the removal.
 */
function listen(finger: EventTarget | null, entries: [type: string, listener: (event: Event) => void, passive: boolean][]): () => void {
  const targets: EventTarget[] = finger ? [window, finger] : [window];
  for (const target of targets) for (const [type, listener, passive] of entries) target.addEventListener(type, listener, { capture: true, passive });
  return () => {
    for (const target of targets) for (const [type, listener] of entries) target.removeEventListener(type, listener, true);
  };
}

/** Whether focus fell to the page (its element gone, or nothing focused): only then is it moved for the person. */
function focusFell(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}
