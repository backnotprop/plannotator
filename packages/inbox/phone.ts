/**
 * The Inbox on a phone (reached over the tailnet with `plannotator inbox
 * --tailscale`): one screen at a time, list, then thread, then file, like a
 * mail app. A phone is a narrow window, or a short touch screen under 1024 px
 * wide (a phone in
 * landscape is wider than the narrow break but only about 400 px tall; a short
 * iPad or Stage Manager window, wider than that, keeps the two panes).
 *
 * The same query is spelled out in inbox.css (a media query cannot read a
 * constant): keep the two equal.
 */

import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px), (max-height: 500px) and (max-width: 1023px) and (pointer: coarse)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function isPhone(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

export const TOUCH_QUERY = '(pointer: coarse) and (hover: none)';

export function isTouchPhone(): boolean {
  return isPhone() && window.matchMedia(TOUCH_QUERY).matches;
}

function subscribeTouch(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const off = subscribe(onChange);
  const mql = window.matchMedia(TOUCH_QUERY);
  mql.addEventListener('change', onChange);
  return () => {
    off();
    mql.removeEventListener('change', onChange);
  };
}

export function isTouchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches;
}

function subscribeTouchScreen(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(TOUCH_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function useTouchScreen(): boolean {
  return useSyncExternalStore(subscribeTouchScreen, isTouchScreen, () => false);
}

export function useTouchPhone(): boolean {
  return useSyncExternalStore(subscribeTouch, isTouchPhone, () => false);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

/**
 * What the window does for one reading of the visual viewport: the height to
 * shrink to while the keyboard covers the bottom (null: the full window), and
 * whether to undo iOS's pan to the focused field. Pinch-zoom also shrinks the
 * visual viewport, by its scale: a zoomed page is the person reading closer,
 * never a keyboard, so it is left alone (no shrink, and no scroll back that
 * would yank the zoomed view to the corner).
 *
 * `layoutHeight` is the window's full height without the keyboard:
 * `document.documentElement.clientHeight`, never `window.innerHeight`. On iOS
 * 26 Safari, once it has panned the page to the field, `innerHeight` reads the
 * visual viewport's height (the owner's probe: 257 with the keyboard up, while
 * clientHeight stayed 660), so a keyboard measured against it read as none:
 * the window went back to its full height and the whole page panned under the
 * keyboard.
 *
 * A browser that resizes the layout for the keyboard covers nothing, so a phone
 * window shorter than `FOLD_BELOW` counts too: New message's head, Thread and
 * foot would leave its words no room (and at 200 px push Send off the screen).
 */
export function keyboardLayout(
  vv: { height: number; offsetTop: number; scale: number },
  layoutHeight: number,
  scrollY: number,
  phone: boolean,
): { height: number | null; resetScroll: boolean } {
  const unzoomed = Math.abs(vv.scale - 1) < 0.01;
  const covered = phone && unzoomed && (layoutHeight - vv.height > 80 || vv.height < FOLD_BELOW);
  if (!covered) return { height: null, resetScroll: false };
  return { height: Math.round(vv.height), resetScroll: scrollY !== 0 || vv.offsetTop !== 0 };
}

const FOLD_BELOW = 284;

export function stripHeight(vv: { height: number; scale: number }, layoutHeight: number, phone: boolean): number | null {
  const left = Math.round(vv.height);
  return phone && Math.abs(vv.scale - 1) < 0.01 && left < layoutHeight ? left : null;
}

export function keyboardInset(vv: { height: number; scale: number }, layoutHeight: number, phone: boolean): number {
  const left = stripHeight(vv, layoutHeight, phone);
  return left === null ? 0 : layoutHeight - left;
}

export function isIOSWebKit(nav: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

function dragHasScroller(event: Event): boolean {
  for (const node of event.composedPath()) {
    if (node === document.body || node === document.documentElement) break;
    if (!(node instanceof HTMLElement)) continue;
    if (node instanceof HTMLTextAreaElement || node.isContentEditable) {
      if (node.scrollHeight > node.clientHeight + 1) return true;
      continue;
    }
    const style = getComputedStyle(node);
    if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return true;
    if (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

function pagePanGuard(): { on: () => void; off: () => void } {
  let refuse: boolean | null = null;
  const start = () => {
    refuse = null;
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    if (refuse === null) refuse = !dragHasScroller(event);
    if (refuse && event.cancelable) event.preventDefault();
  };
  return {
    on: () => {
      refuse = null;
      document.addEventListener('touchstart', start, { passive: true });
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', start, { passive: true });
      document.addEventListener('touchcancel', start, { passive: true });
    },
    off: () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', start);
      document.removeEventListener('touchcancel', start);
    },
  };
}

/**
 * Keeps `--ib-vvh` on the document element equal to the visual viewport's
 * height while a phone's keyboard is up (`data-ib-keyboard`), so the window
 * shrinks to the part the keyboard leaves and the reply box sits on top of the
 * keyboard, and undoes a pan of the page. `--ib-kbd-inset` is what the keyboard
 * covers (`keyboardInset`), for New message's sheet.
 *
 * On iOS (`isIOSWebKit`) it also pins the page, since Safari pans the whole
 * page under the keyboard: `data-ib-keyboard-pin` on the root makes html no
 * taller than the visible part and lets the reply foot shrink and scroll with
 * Send kept at its bottom (inbox.css); `tight` (under 400 px left: an iPhone in
 * portrait leaves ~257, on its side ~140) also closes the thread's padding and
 * caps the reply's words. A drag on something that does not scroll is refused.
 * Android keeps what it had: Chrome resizes only the visual viewport and pans
 * nothing it is not asked to.
 *
 * The state is read again on every visual viewport change, the window's
 * resize and scroll, a rotation, a return to the tab, and a field taking or
 * losing focus, so a keyboard that closed while the tab was away never leaves
 * the page pinned. Each of those is read once more `RECHECK_MS` later: WebKit
 * can report `clientHeight` after the event (after a rotation, say), and a
 * stale height read as a keyboard would leave the page clipped and the reply
 * foot hidden with no keyboard open. Returns the cleanup.
 */
const RECHECK_MS = 300;

export function trackKeyboard(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  const ios = typeof navigator !== 'undefined' && isIOSWebKit(navigator);
  const guard = pagePanGuard();
  let guarding = false;
  let frame = 0;
  let recheck = 0;
  const pin = (state: 'tight' | '' | null) => {
    if (state === null) delete root.dataset.ibKeyboardPin;
    else root.dataset.ibKeyboardPin = state;
    const on = state !== null;
    if (on === guarding) return;
    guarding = on;
    if (on) guard.on();
    else guard.off();
  };
  const apply = () => {
    frame = 0;
    const layout = keyboardLayout(vv, root.clientHeight, window.scrollY, isPhone());
    const strip = stripHeight(vv, root.clientHeight, isPhone());
    if (strip !== null) root.style.setProperty('--ib-cp-vvh', `${strip}px`);
    else root.style.removeProperty('--ib-cp-vvh');
    const inset = keyboardInset(vv, root.clientHeight, isPhone());
    if (inset > 0) root.style.setProperty('--ib-kbd-inset', `${inset}px`);
    else root.style.removeProperty('--ib-kbd-inset');
    if (layout.height !== null) {
      root.style.setProperty('--ib-vvh', `${layout.height}px`);
      root.dataset.ibKeyboard = '';
      pin(ios ? (layout.height < 400 ? 'tight' : '') : null);
      if (layout.resetScroll) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--ib-vvh');
      delete root.dataset.ibKeyboard;
      pin(null);
    }
  };
  const read = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const schedule = () => {
    read();
    window.clearTimeout(recheck);
    recheck = window.setTimeout(() => {
      recheck = 0;
      read();
    }, RECHECK_MS);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') schedule();
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  if (ios) window.addEventListener('scroll', schedule, { passive: true });
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    if (ios) window.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
    window.clearTimeout(recheck);
    pin(null);
    root.style.removeProperty('--ib-vvh');
    root.style.removeProperty('--ib-cp-vvh');
    root.style.removeProperty('--ib-kbd-inset');
    delete root.dataset.ibKeyboard;
  };
}
