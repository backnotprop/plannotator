/**
 * Decision mode takes the whole window (approval "inbox-decision-mode-one-send"; owner, 2026-11-24: "I thought
 * decision mode was a full screen dialog thing"). While a pane decides, the window gives its thread the whole window
 * the way the thread's own full screen does (App.tsx `full`): the sidebar and the list hide, the window buttons' inset,
 * focus and the back gesture behave as they do there. The person's own full-screen choice and sidebar choice are not
 * written, so leaving gives back exactly the layout they had.
 *
 * Not a dialog: nothing traps focus, and what a card opens (the prototype window, a picture, menus, Ask AI, comments)
 * works as it does in the thread. A file opened from a message opens beside the decide frame, as beside a thread.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { isPhone } from '../phone';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let deciding: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => deciding;
function write(next: ReadonlySet<string>) {
  deciding = next;
  for (const listener of listeners) listener();
}

/** The pane: decision mode shows for `threadId` while `on`, so the window gives that thread the whole window. */
export function useDecidesWhole(threadId: string, on: boolean): void {
  useLayoutEffect(() => {
    if (!on) return;
    write(new Set([...deciding, threadId]));
    return () => {
      const next = new Set(deciding);
      next.delete(threadId);
      write(next);
    };
  }, [threadId, on]);
}

/** The window: decision mode shows for `threadId` in a pane. */
export function useDecidingWhole(threadId: string | null | undefined): boolean {
  const now = useSyncExternalStore(subscribe, snapshot, snapshot);
  return !!threadId && now.has(threadId);
}

/**
 * The thread takes the whole window (App.tsx `full`), on a desktop's open thread only: the person put it in full
 * screen (not a stacked window's or a Board card's, which cover the list already), or decision mode shows in it,
 * wherever the thread was opened from.
 */
export function threadWhole(o: { threadFull: boolean; deciding: boolean; thread: boolean; phone: boolean; fromCard: boolean; stacked: boolean }): boolean {
  return o.thread && !o.phone && ((o.threadFull && !o.fromCard && !o.stacked) || o.deciding);
}

/**
 * A short fade (and, coming in, a slight scale) as decision mode takes the window and gives it back: none with
 * reduced motion, and none on a phone, where the thread is the whole screen already and nothing about it changes.
 */
export function fadeIn(el: Element | null | undefined, scale: boolean): void {
  if (!el || typeof (el as HTMLElement).animate !== 'function' || reducedMotion() || isPhone()) return;
  (el as HTMLElement).animate(scale ? [{ opacity: 0, scale: '0.99' }, { opacity: 1, scale: '1' }] : [{ opacity: 0 }, { opacity: 1 }], { duration: scale ? 160 : 140, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

/** Where the person was in the thread: the first message still in view, and how far below the top it sat. */
export interface ThreadPlace {
  at: number;
  anchor: string | null;
  offset: number;
}

export function placeOf(body: HTMLElement): ThreadPlace {
  const top = body.getBoundingClientRect().top;
  for (const el of body.querySelectorAll<HTMLElement>(':scope > [data-message-article]')) {
    const box = el.getBoundingClientRect();
    if (box.bottom > top) return { at: body.scrollTop, anchor: el.getAttribute('data-message-article'), offset: box.top - top };
  }
  return { at: body.scrollTop, anchor: null, offset: 0 };
}

/**
 * Put the thread back at `place`. The window gives the list and the sidebar back meanwhile (the sidebar on its
 * spring), so the thread narrows and its messages wrap again: the message that was at the top is kept where it was
 * for the next moments, until the person scrolls or presses anything themselves.
 */
export function restorePlace(body: HTMLElement, place: ThreadPlace): void {
  body.scrollTop = place.at;
  const anchor = place.anchor ? body.querySelector<HTMLElement>(`:scope > [data-message-article="${CSS.escape(place.anchor)}"]`) : null;
  if (!anchor) return;
  const align = () => {
    const drift = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - place.offset;
    if (Math.abs(drift) >= 1) body.scrollTop += drift;
  };
  align();
  if (typeof requestAnimationFrame !== 'function') return;
  let stopped = false;
  const PERSON = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => {
    stopped = true;
    for (const type of PERSON) window.removeEventListener(type, stop, true);
  };
  for (const type of PERSON) window.addEventListener(type, stop, { capture: true, passive: true });
  // The shell's spring (shell/shell-motion.ts `shellSpring`, half a second with a little bounce), and a little after.
  const until = performance.now() + 800;
  const frame = () => {
    if (stopped || !anchor.isConnected) return stop();
    align();
    if (performance.now() < until) requestAnimationFrame(frame);
    else stop();
  };
  requestAnimationFrame(frame);
}
