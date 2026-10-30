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

/**
 * A real touch phone: the phone layout on a screen whose main pointer is a finger (coarse, no hover). Single keys
 * are off there (a stray key from a hardware keyboard or voice input acts on nothing shown); a desktop window
 * narrower than 768 px has the phone layout but keeps its keys, as it always had (the owner's ruling on #2257).
 */
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

/** Whether the window is a real touch phone now, and again whenever that changes. */
export function useTouchPhone(): boolean {
  return useSyncExternalStore(subscribeTouch, isTouchPhone, () => false);
}

/** Whether the window is a phone now, and again whenever that changes (a rotation, a resize). */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

/**
 * Keeps `--ib-vvh` on the document element equal to the visual viewport's
 * height while a phone's keyboard is up, so the window shrinks to the part
 * the keyboard leaves and the reply box sits on top of the keyboard. iOS
 * Safari does not resize the layout for the keyboard; it pans the page
 * instead, which the reset to the top undoes (the window never scrolls as a
 * whole). Returns the cleanup.
 */
/**
 * What the window does for one reading of the visual viewport: the height to
 * shrink to while the keyboard covers the bottom (null: the full window), and
 * whether to undo iOS's pan to the focused field. Pinch-zoom also shrinks the
 * visual viewport, by its scale: a zoomed page is the person reading closer,
 * never a keyboard, so it is left alone (no shrink, and no scroll back that
 * would yank the zoomed view to the corner).
 */
export function keyboardLayout(
  vv: { height: number; offsetTop: number; scale: number },
  innerHeight: number,
  scrollY: number,
  phone: boolean,
): { height: number | null; resetScroll: boolean } {
  const unzoomed = Math.abs(vv.scale - 1) < 0.01;
  const covered = phone && unzoomed && innerHeight - vv.height > 80;
  if (!covered) return { height: null, resetScroll: false };
  return { height: Math.round(vv.height), resetScroll: scrollY !== 0 || vv.offsetTop !== 0 };
}

export function trackKeyboard(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // The keyboard covers the bottom of the layout viewport (not a pinch-zoom: keyboardLayout).
    const layout = keyboardLayout(vv, window.innerHeight, window.scrollY, isPhone());
    if (layout.height !== null) {
      root.style.setProperty('--ib-vvh', `${layout.height}px`);
      root.dataset.ibKeyboard = '';
      if (layout.resetScroll) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--ib-vvh');
      delete root.dataset.ibKeyboard;
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty('--ib-vvh');
    delete root.dataset.ibKeyboard;
  };
}
