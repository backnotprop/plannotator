/**
 * The page's idle clock: the calm moment for a one-time dialog that a person who keeps a thread open never gets by
 * "going back to the list" (the owner, 2026-11-08: "I'm operating where the thread pane is showing and it's always
 * open ... Some people may never see them"). The page is idle once nothing moved, clicked, typed, scrolled or touched
 * for `IDLE_CLOCK.idleMs`, while the tab is visible and focused, with no field focused and nothing open over the page.
 *
 * Cheap on purpose: one timeout at a time, and passive listeners that only write a time (the timeout is set again only
 * when none is pending, so a stream of pointer moves costs a number each). Nothing runs while idle, nor while the tab
 * is hidden or blurred: showing or focusing the page again starts the count afresh. The page's state changes only when
 * idle begins or ends.
 */
import { useEffect, useRef, useState } from 'react';

/** The clock's length, ms. A test shrinks it (and puts it back). */
export const IDLE_CLOCK = {
  /** Nothing moved, clicked, typed, scrolled or touched this long: the page is idle. */
  idleMs: 20_000,
};

/** Every input that ends idle. `scroll` does not bubble, so the listeners listen in the capture phase. */
const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

/** The page is in front of the person: the tab visible and the window focused. */
export function pageAttentive(doc: Document = document): boolean {
  return doc.visibilityState === 'visible' && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
}

/**
 * What is open over the page: a dialog (modal or not), a menu, a list of choices, an open popover (its trigger declares
 * `aria-haspopup`: an open disclosure, such as a Smart group's band or a sidebar section, only says `aria-expanded`,
 * and is no overlay), the Ask AI window and Show me (`data-popover-layer`, `data-chat-window`), an image being marked
 * up, a Shape board over the thread, the annotation toolbar and its comment, picker and table floats.
 */
export const PAGE_OVERLAYS = [
  'dialog[open]',
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]',
  '[data-popover-layer]',
  '[data-chat-window]',
  '[data-pn-image-annotator-stage]',
  '[data-shape-open]',
  '.annotation-toolbar',
  '[data-comment-popover]',
  '[data-floating-picker]',
  '[data-table-toolbar]',
].join(', ');

/** An element shown with the Popover API is open (`:popover-open`; false where the engine has no such selector). */
function popoverOpen(doc: Document): boolean {
  try {
    return doc.querySelector(':popover-open') !== null;
  } catch {
    return false;
  }
}

/** Something is typed or open: a focused field, or an overlay (`PAGE_OVERLAYS`, an open popover). */
export function pageBusy(doc: Document = document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return true;
  return doc.querySelector(PAGE_OVERLAYS) !== null || popoverOpen(doc);
}

export interface IdleClockInput {
  /** Count at all (a dialog is armed that takes the idle moment). False: never idle, no listeners. */
  enabled: boolean;
  /** The page's own "something is open or typed" (App: the reveals' hold, a composer, a search): never idle meanwhile. */
  busy?: () => boolean;
}

/** True while the page is idle (`IDLE_CLOCK.idleMs` without input, attentive, nothing typed or open). */
export function useIdleClock(input: IdleClockInput): boolean {
  const [idle, setIdle] = useState(false);
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!input.enabled) return;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let now = false;
    const set = (value: boolean) => {
      if (now === value) return;
      now = value;
      setIdle(value);
    };
    const arm = (ms: number) => {
      if (timer === null && pageAttentive()) timer = setTimeout(fire, ms);
    };
    function fire() {
      timer = null;
      // Hidden or blurred: no count; coming back starts it again (`attention`).
      if (!pageAttentive()) return;
      const quiet = Date.now() - last;
      if (quiet < IDLE_CLOCK.idleMs) return arm(IDLE_CLOCK.idleMs - quiet);
      // Typed or open: the quiet counts from now, so idle comes a full length after it closes.
      if (pageBusy() || latest.current.busy?.()) {
        last = Date.now();
        return arm(IDLE_CLOCK.idleMs);
      }
      set(true);
    }
    const active = () => {
      last = Date.now();
      set(false);
      arm(IDLE_CLOCK.idleMs);
    };
    const away = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      set(false);
    };
    const attention = () => (pageAttentive() ? active() : away());
    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY) window.addEventListener(type, active, options);
    window.addEventListener('focus', attention);
    window.addEventListener('blur', away);
    document.addEventListener('visibilitychange', attention);
    arm(IDLE_CLOCK.idleMs);
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, active, options);
      window.removeEventListener('focus', attention);
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', attention);
      if (timer !== null) clearTimeout(timer);
      setIdle(false);
    };
  }, [input.enabled]);
  return idle;
}
