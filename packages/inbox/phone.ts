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
 */
export function keyboardLayout(
  vv: { height: number; offsetTop: number; scale: number },
  layoutHeight: number,
  scrollY: number,
  phone: boolean,
): { height: number | null; resetScroll: boolean } {
  const unzoomed = Math.abs(vv.scale - 1) < 0.01;
  const covered = phone && unzoomed && layoutHeight - vv.height > 80;
  if (!covered) return { height: null, resetScroll: false };
  return { height: Math.round(vv.height), resetScroll: scrollY !== 0 || vv.offsetTop !== 0 };
}

/**
 * Whether a drag that starts at this event's target has something of its own
 * to scroll: a field, or a box that scrolls and has more than it shows. Read
 * through the event's composed path, so a scroller inside a shadow root counts.
 */
function dragHasScroller(event: Event): boolean {
  for (const node of event.composedPath()) {
    if (node === document.body || node === document.documentElement) break;
    // A shadow root, an SVG shape, a text node: the box that scrolls is further up.
    if (!(node instanceof HTMLElement)) continue;
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return true;
    const style = getComputedStyle(node);
    if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return true;
    if (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

/**
 * With the keyboard up, a one-finger drag on something that does not scroll
 * (a header, a toolbar, the reply foot's buttons) pans the whole page in iOS
 * Safari, whatever the page's own overflow says: refused. A drag in the thread,
 * the list or a field scrolls as before; a pinch is left alone.
 */
function refusePagePan(event: TouchEvent): void {
  if (event.touches.length !== 1 || !event.cancelable) return;
  if (!dragHasScroller(event)) event.preventDefault();
}

/**
 * Keeps `--ib-vvh` on the document element equal to the visual viewport's
 * height while a phone's keyboard is up, so the window shrinks to the part
 * the keyboard leaves and the reply box sits on top of the keyboard. iOS
 * Safari does not resize the layout for the keyboard; it pans the page
 * instead. Three things keep the window still while the keyboard is up: the
 * page itself (html, body) is no taller than the visible part (inbox.css, on
 * `data-ib-keyboard`), any pan is reset to the top on the next frame, and a
 * drag on something that does not scroll is refused. Returns the cleanup.
 */
export function trackKeyboard(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;
  let guarding = false;
  const guard = (on: boolean) => {
    if (on === guarding) return;
    guarding = on;
    if (on) document.addEventListener('touchmove', refusePagePan, { passive: false });
    else document.removeEventListener('touchmove', refusePagePan);
  };
  const apply = () => {
    frame = 0;
    // The keyboard covers the bottom of the layout viewport (not a pinch-zoom: keyboardLayout).
    const layout = keyboardLayout(vv, root.clientHeight, window.scrollY, isPhone());
    if (layout.height !== null) {
      root.style.setProperty('--ib-vvh', `${layout.height}px`);
      // `tight`: under 400 px left (an iPhone's keyboard leaves ~257), where inbox.css closes the thread's padding
      // and caps the reply's height so Send stays above the keyboard. A roomier screen (a Pixel's ~585) is untouched.
      root.dataset.ibKeyboard = layout.height < 400 ? 'tight' : '';
      guard(true);
      if (layout.resetScroll) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--ib-vvh');
      delete root.dataset.ibKeyboard;
      guard(false);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  // iOS 26 reports a pan as the window's scroll as often as the visual viewport's (the probe's readings).
  window.addEventListener('scroll', schedule, { passive: true });
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
    guard(false);
    root.style.removeProperty('--ib-vvh');
    delete root.dataset.ibKeyboard;
  };
}
