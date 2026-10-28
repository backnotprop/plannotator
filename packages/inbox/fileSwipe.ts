/**
 * A phone's swipe between a thread's files (approval "mobile-file-stepping",
 * toolbar-swipe, 2026-10-25; the mock is not in this repo): with a file open
 * full screen on a phone, a horizontal one-finger swipe over the file steps to
 * the previous or next file. The file follows the finger and a small
 * "Next · name" card shows where the next file comes from; past a third of the
 * width, or on a flick, it steps; short of that it springs back. At the first
 * and last file it resists and, released far enough, says "Last file in this
 * thread" (the pane's end note). Under reduced motion nothing follows the
 * finger: the step happens on release.
 *
 * Which files take the swipe (`fileSwipeMode`): documents, plain text, code,
 * PDFs and the download card follow the finger here; an image keeps its own
 * swipe at Fit (ImageAttachmentView: a zoomed image pans, two fingers pinch);
 * HTML pages, diagrams (the canvas pans) and videos (native controls) take
 * every touch themselves, so they get no swipe.
 *
 * What the finger is on decides too (`sidewaysOwner`): a block that still
 * scrolls sideways in the swipe's direction (a wide code line, a table,
 * Pierre's code scroller inside its shadow root), a field, a video, the
 * diagram canvas or a frame keeps the touch. Selected text keeps it, and so
 * does a second finger. The swipe is decided once the finger has moved
 * `SWIPE_DECIDE_PX`, and only when it moves `SWIPE_RATIO` times more sideways
 * than up or down, so scrolling a document is never taken.
 *
 * The files a swipe cannot step (HTML pages, and code that scrolls sideways)
 * step through the sheet the toolbar's pill opens: its ‹ Previous and Next ›
 * (the owner's answer; no floating tabs), shown for every file
 * (AttachmentStepper.tsx `FilePeek`'s `onStep`).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { InboxAttachmentKind } from '@plannotator/core/inbox-types';

/** How a file takes a sideways swipe: follows the finger here, the image's own swipe at Fit, or none. */
export type FileSwipeMode = 'follow' | 'image' | 'none';

export function fileSwipeMode(kind: InboxAttachmentKind, tooLarge: boolean): FileSwipeMode {
  // A text file too large to show is the download card: it follows the finger like any card.
  if (tooLarge) return 'follow';
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'code':
    case 'pdf':
    case 'file':
      return 'follow';
    case 'image':
      return 'image';
    // HTML pages take every touch inside their frame; the diagram canvas pans; a video has native controls.
    case 'html':
    case 'mermaid':
    case 'graphviz':
    case 'video':
      return 'none';
  }
}

/** The finger moves this far before the swipe is decided either way. */
export const SWIPE_DECIDE_PX = 10;
/** And must move this many times more sideways than up or down to be a swipe. */
export const SWIPE_RATIO = 1.5;
/** Released past this share of the width, the swipe steps. */
export const SWIPE_COMMIT_SHARE = 1 / 3;
/** A flick: this fast (px/ms) in the swipe's direction, and at least `SWIPE_FLICK_MIN_PX` across, steps too. */
export const SWIPE_FLICK_SPEED = 0.5;
export const SWIPE_FLICK_MIN_PX = 40;
/** Past the first or last file the file follows only this share of the finger. */
export const SWIPE_END_RESIST = 1 / 3;
/** The file leaves (and the next one comes in) in this long. */
export const SWIPE_SLIDE_MS = 180;

/** 1: the next file (the finger moves left); -1: the previous one. */
export type SwipeDir = 1 | -1;

export const swipeDirOf = (dx: number): SwipeDir => (dx < 0 ? 1 : -1);

/** Once the finger has moved (`mx`, `my` from where it went down): wait, a swipe, or the page's own (a scroll). */
export function decideSwipe(mx: number, my: number): 'wait' | 'swipe' | 'native' {
  if (Math.abs(mx) < SWIPE_DECIDE_PX && Math.abs(my) < SWIPE_DECIDE_PX) return 'wait';
  return Math.abs(mx) > SWIPE_RATIO * Math.abs(my) ? 'swipe' : 'native';
}

/** Released at `dx` (raw finger travel) with speed `vx` (px/ms): whether it steps. */
export function swipeCommits(dx: number, width: number, vx: number): boolean {
  if (Math.abs(dx) > width * SWIPE_COMMIT_SHARE) return true;
  return Math.abs(vx) > SWIPE_FLICK_SPEED && Math.abs(dx) > SWIPE_FLICK_MIN_PX && Math.sign(vx) === Math.sign(dx);
}

/** What keeps a touch itself, by the elements the finger went down on. */
const TOUCH_OWNERS = 'video, audio, input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, [data-diagram-canvas], [data-claims-arrows="true"]';

/**
 * Why the touch is not the swipe's, or null when it may be: `owner` (a field,
 * a video, a frame, the diagram canvas), `sideways` (a block that can still
 * scroll that way). `path` is the touchstart's composed path (through shadow
 * roots); `dir` the way the swipe would step.
 */
export function sidewaysOwner(path: readonly EventTarget[], dir: SwipeDir): 'owner' | 'sideways' | null {
  for (const node of path) {
    if (typeof Element === 'undefined' || !(node instanceof Element)) continue;
    if (node === document.documentElement || node === document.body) continue;
    if (node.matches(TOUCH_OWNERS)) return 'owner';
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        // At its edge in the swipe's direction the block has nothing more to show: the swipe may step.
        // Next (the finger moves left) scrolls the block right, so it is at its edge when scrolled to its end.
        const max = node.scrollWidth - node.clientWidth;
        const atEdge = dir > 0 ? node.scrollLeft >= max - 1 : node.scrollLeft <= 1;
        if (!atEdge) return 'sideways';
      }
    }
  }
  return null;
}

const textSelected = () => {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== '';
};

export const prefersReducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where a swipe is, for the card: how far (px, as drawn) and which way, or nothing under way. */
export interface SwipeProgress {
  dir: SwipeDir;
  /** 0..1 of the width (raw finger travel). */
  progress: number;
}

interface ProgressStore {
  get: () => SwipeProgress | null;
  set: (next: SwipeProgress | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createProgressStore(): ProgressStore {
  let value: SwipeProgress | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value || (next && value && next.dir === value.dir && Math.abs(next.progress - value.progress) < 0.005)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The swipe's progress, read by the card only (the pane never re-renders while the finger moves). */
export function useSwipeProgress(store: FileSwipe): SwipeProgress | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export type FileSwipe = Pick<ProgressStore, 'get' | 'subscribe'>;

export interface FileSwipeOptions {
  /** The swipe is on (a phone, full screen, two or more files, a file that follows the finger, nothing open over it). */
  enabled: boolean;
  /** There is a file that way (else the file resists, and a release past the line says the end note). */
  canStep: (dir: SwipeDir) => boolean;
  /** Step that way (also at an end: the pane says "Last file in this thread"). */
  onStep: (dir: SwipeDir) => void;
  /** Leaving now would raise the question row (a typed comment): the file springs back and the step asks first. */
  wouldAsk: () => boolean;
}

/**
 * Wire the swipe onto `area` (the pane's `.ib-docarea`): touch listeners
 * (touchmove not passive, so a decided swipe is never also a scroll), the
 * file moved by `transform` only, and the progress for the card.
 */
export function useFileSwipe(area: RefObject<HTMLElement | null>, options: FileSwipeOptions): FileSwipe {
  const store = useMemo(createProgressStore, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled } = options;

  useEffect(() => {
    const el = area.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number; path: EventTarget[] } | null = null;
    let mode: 'idle' | 'swipe' | 'native' = 'idle';
    let last = { x: 0, t: 0 };
    let vx = 0;
    let raw = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let frame = 0;
    const width = () => el.getBoundingClientRect().width || 1;
    const draw = (offset: number, transition: string | null, opacity = '') => {
      el.style.transition = transition ?? 'none';
      el.style.transform = offset ? `translateX(${offset}px)` : '';
      el.style.opacity = opacity;
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };
    /** Once a spring-back or slide-in has run, the file carries no inline transition (unless a new swipe took it meanwhile). */
    const clearTransitionAfter = (ms: number) =>
      later(ms, () => {
        if (mode !== 'swipe') el.style.transition = '';
      });
    const springBack = () => {
      const reduced = prefersReducedMotion();
      draw(0, reduced ? null : `transform 260ms cubic-bezier(0.32, 0.72, 0, 1)`);
      store.set(null);
      if (reduced) el.style.transition = '';
      else clearTransitionAfter(260);
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        if (mode === 'swipe') springBack();
        start = null;
        mode = 'native';
        return;
      }
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, path: event.composedPath() };
      mode = 'idle';
      last = { x: touch.clientX, t: event.timeStamp };
      vx = 0;
      raw = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!start || mode === 'native') return;
      if (event.touches.length !== 1) {
        if (mode === 'swipe') springBack();
        mode = 'native';
        return;
      }
      const touch = event.touches[0]!;
      const mx = touch.clientX - start.x;
      const my = touch.clientY - start.y;
      if (mode === 'idle') {
        const decided = decideSwipe(mx, my);
        if (decided === 'wait') return;
        if (decided === 'native' || textSelected()) {
          mode = 'native';
          return;
        }
        if (sidewaysOwner(start.path, swipeDirOf(mx))) {
          mode = 'native';
          return;
        }
        mode = 'swipe';
      }
      if (event.cancelable) event.preventDefault();
      const dt = Math.max(1, event.timeStamp - last.t);
      vx = (touch.clientX - last.x) / dt;
      last = { x: touch.clientX, t: event.timeStamp };
      raw = mx;
      const dir = swipeDirOf(mx);
      const can = optionsRef.current.canStep(dir);
      // Reduced motion: nothing follows the finger (the card still says where a release goes).
      if (!prefersReducedMotion()) draw(can ? mx : mx * SWIPE_END_RESIST, null);
      store.set(can ? { dir, progress: Math.min(1, Math.abs(mx) / width()) } : null);
    };
    const onEnd = () => {
      if (mode !== 'swipe') {
        start = null;
        mode = 'idle';
        return;
      }
      start = null;
      mode = 'idle';
      const dir = swipeDirOf(raw);
      const w = width();
      const commits = swipeCommits(raw, w, vx);
      const { canStep, onStep, wouldAsk } = optionsRef.current;
      if (!commits) return springBack();
      if (!canStep(dir) || wouldAsk() || prefersReducedMotion()) {
        // An end (the note), a typed comment (the question row) or reduced motion: no slide, the step (or its answer) at once.
        draw(0, null);
        el.style.transition = '';
        store.set(null);
        onStep(dir);
        return;
      }
      // The file leaves the way the finger went; the next one comes in from the other side.
      draw(dir > 0 ? -w : w, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)`);
      later(SWIPE_SLIDE_MS, () => {
        store.set(null);
        onStep(dir);
        draw(dir > 0 ? w * 0.25 : -w * 0.25, null, '0');
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            draw(0, `transform ${SWIPE_SLIDE_MS + 40}ms cubic-bezier(0.23, 1, 0.32, 1), opacity ${SWIPE_SLIDE_MS}ms ease-out`, '');
            clearTransitionAfter(SWIPE_SLIDE_MS + 40);
          });
        });
      });
    };
    // The file's own listeners are there for the whole time the swipe is on, and touchmove is not passive
    // from the touch's first move (iOS treats a touch's moves as cancelable only for listeners present when
    // it began). preventDefault runs only once a swipe is decided (`onMove`), so a vertical scroll stays native.
    // A gesture is also followed on its first target: a touch keeps firing at the element it started on, and
    // that element may be drawn again mid-gesture (Pierre's code view does), after which it is out of the page
    // and nothing it gets bubbles to the file.
    let following: EventTarget | null = null;
    let seen: Event | null = null;
    const follow = (target: EventTarget | null) => {
      if (following) {
        following.removeEventListener('touchmove', onMoveAny as EventListener);
        following.removeEventListener('touchend', onEndAny as EventListener);
        following.removeEventListener('touchcancel', onEndAny as EventListener);
      }
      following = target;
      if (following) {
        following.addEventListener('touchmove', onMoveAny as EventListener, { passive: false });
        following.addEventListener('touchend', onEndAny as EventListener);
        following.addEventListener('touchcancel', onEndAny as EventListener);
      }
    };
    const onStartEl = (event: TouchEvent) => {
      onStart(event);
      const first = event.composedPath()[0];
      follow(start !== null && first && first !== el ? first : null);
    };
    // The same event reaches the target and the file while the target is in the page: handled once.
    const onMoveAny = (event: TouchEvent) => {
      if (event === seen) return;
      seen = event;
      onMove(event);
    };
    const onEndAny = (event: TouchEvent) => {
      if (event === seen) return;
      seen = event;
      // A second finger lifting while one stays down is not the end of the gesture.
      if (event.type === 'touchend' && event.touches.length > 0) return;
      onEnd();
      follow(null);
    };
    el.addEventListener('touchstart', onStartEl, { passive: true });
    el.addEventListener('touchmove', onMoveAny, { passive: false });
    el.addEventListener('touchend', onEndAny);
    el.addEventListener('touchcancel', onEndAny);
    return () => {
      el.removeEventListener('touchstart', onStartEl);
      el.removeEventListener('touchmove', onMoveAny);
      el.removeEventListener('touchend', onEndAny);
      el.removeEventListener('touchcancel', onEndAny);
      follow(null);
      for (const timer of timers) clearTimeout(timer);
      cancelAnimationFrame(frame);
      el.style.transform = '';
      el.style.transition = '';
      el.style.opacity = '';
      store.set(null);
    };
  }, [area, enabled, store]);

  return store;
}
