/**
 * A one-finger swipe that steps between files or images on a touch screen
 * (the Plannotator Inbox's phone viewer, approval "mobile-file-stepping",
 * and its images, approval "inbox-image-swipe"; ui's `ImageLightbox` with its
 * `swipe` prop). The thing on screen follows the finger and the neighbour
 * comes in from the edge; past a third of the width, or on a flick, it
 * steps; short of that it springs back. At the first and last item it
 * resists and, released far enough, the host says it is the end. Under
 * reduced motion nothing follows the finger: the step happens on release.
 *
 * What the finger is on decides too (`sidewaysOwner`): a block that still
 * scrolls sideways in the swipe's direction (a wide code line, a table, a
 * scroller inside a shadow root), a field, a video, the diagram canvas or a
 * frame keeps the touch, and so does whatever the host says keeps it
 * (`keeps`: a zoomed image that can still pan that way). Selected text keeps
 * it, and so does a second finger. The swipe is decided once the finger has
 * moved `SWIPE_DECIDE_PX`, and only when it moves `SWIPE_RATIO` times more
 * sideways than up or down, so scrolling a document is never taken.
 *
 * Optional, for an image: a drag down closes (`dismiss`), and the neighbour
 * can be drawn whole by the host (`peek`), in which case a committed step
 * leaves the host's picture in place until the new image is shown
 * (`settle`), with no fade in. The touches are heard on `area`; what moves
 * can be something inside it (`move`: the picture, while its controls stay
 * put), so `area` itself stays where it is and a finger that comes back
 * while the last step is still sliding is heard: that step lands at once
 * and the new swipe starts from it.
 *
 * Moved here from the Inbox's `fileSwipe.ts` (which re-exports it) so ui's
 * lightbox steps the same way; the numbers did not change.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';

/** The finger moves this far before the swipe is decided either way. */
export const SWIPE_DECIDE_PX = 10;
/** And must move this many times more sideways than up or down to be a swipe (or more down than sideways to close). */
export const SWIPE_RATIO = 1.5;
/** Released past this share of the width, the swipe steps. */
export const SWIPE_COMMIT_SHARE = 1 / 3;
/** A flick: this fast (px/ms) in the swipe's direction, and at least `SWIPE_FLICK_MIN_PX` across, steps too. */
export const SWIPE_FLICK_SPEED = 0.5;
export const SWIPE_FLICK_MIN_PX = 40;
/** Past the first or last item the thing follows only this share of the finger. */
export const SWIPE_END_RESIST = 1 / 3;
/** The item leaves (and the next one comes in) in this long. */
export const SWIPE_SLIDE_MS = 180;
/** Short of the line, it springs back in this long. */
export const SWIPE_SPRING_MS = 260;
/** The gap between an image and the neighbour that peeks in beside it (`peek`). */
export const SWIPE_PEEK_GAP = 16;
/** A drag down closes once released past this share of the height (or on a downward flick). */
export const SWIPE_DISMISS_SHARE = 0.15;
/** The backdrop is fully faded once the drag down has gone this share of the height. */
export const SWIPE_DISMISS_FADE_SHARE = 1 / 3;
/** The host's picture of the new item stays at most this long after a step, should the new item never say it is shown. */
export const SWIPE_HANDOFF_MAX_MS = 700;

/** 1: the next item (the finger moves left); -1: the previous one. */
export type SwipeDir = 1 | -1;

export const swipeDirOf = (dx: number): SwipeDir => (dx < 0 ? 1 : -1);

/** Once the finger has moved (`mx`, `my` from where it went down): wait, a swipe, or the page's own (a scroll). */
export function decideSwipe(mx: number, my: number): 'wait' | 'swipe' | 'native' {
  if (Math.abs(mx) < SWIPE_DECIDE_PX && Math.abs(my) < SWIPE_DECIDE_PX) return 'wait';
  return Math.abs(mx) > SWIPE_RATIO * Math.abs(my) ? 'swipe' : 'native';
}

/** A drag that is mostly down (`my` from where the finger went down): a drag to close. */
export function isDragDown(mx: number, my: number): boolean {
  return my >= SWIPE_DECIDE_PX && my > SWIPE_RATIO * Math.abs(mx);
}

/** Released at `dx` (raw finger travel) with speed `vx` (px/ms): whether it steps. */
export function swipeCommits(dx: number, width: number, vx: number): boolean {
  if (Math.abs(dx) > width * SWIPE_COMMIT_SHARE) return true;
  return Math.abs(vx) > SWIPE_FLICK_SPEED && Math.abs(dx) > SWIPE_FLICK_MIN_PX && Math.sign(vx) === Math.sign(dx);
}

/** Released `dy` down (with speed `vy`, px/ms) on a stage `height` tall: whether it closes. */
export function dismissCommits(dy: number, height: number, vy: number): boolean {
  if (dy > height * SWIPE_DISMISS_SHARE) return true;
  return vy > SWIPE_FLICK_SPEED && dy > SWIPE_FLICK_MIN_PX;
}

/**
 * What keeps a touch itself, by the elements the finger went down on. A host
 * adds its own (`SwipeStepOptions.owners`: the Inbox adds the diagram canvas,
 * which ui's document Viewer must not reach statically).
 */
const TOUCH_OWNERS = 'video, audio, input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, [data-claims-arrows="true"]';

/**
 * Why the touch is not the swipe's, or null when it may be: `owner` (a field,
 * a video, a frame, the diagram canvas), `sideways` (a block that can still
 * scroll that way). `path` is the touchstart's composed path (through shadow
 * roots); `dir` the way the swipe would step.
 */
export function sidewaysOwner(path: readonly EventTarget[], dir: SwipeDir, owners?: string): 'owner' | 'sideways' | null {
  const own = owners ? `${TOUCH_OWNERS}, ${owners}` : TOUCH_OWNERS;
  for (const node of path) {
    if (typeof Element === 'undefined' || !(node instanceof Element)) continue;
    if (node === document.documentElement || node === document.body) continue;
    if (node.matches(own)) return 'owner';
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

/**
 * Where a swipe is, for what the host draws beside it: which way, how far
 * (`progress`, 0..1 of the width, raw finger travel), where the item is drawn
 * (`offset`, px), and the phase: `drag` (under the finger), `slide` (leaving
 * after a release; `ms` long), `back` (springing back; `ms` long) or
 * `handoff` (stepped; the host's picture of the new item stays until
 * `settle`). Nothing while no swipe is under way.
 */
export interface SwipeProgress {
  dir: SwipeDir;
  progress: number;
  offset: number;
  phase: 'drag' | 'slide' | 'back' | 'handoff';
  ms?: number;
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
      if (next === value) return;
      if (next && value && next.dir === value.dir && next.phase === value.phase && Math.abs(next.progress - value.progress) < 0.005 && Math.abs(next.offset - value.offset) < 0.5) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The swipe's progress, read by what the host draws beside it (the host never re-renders while the finger moves). */
export function useSwipeProgress(store: SwipeStep): SwipeProgress | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Only the swipe's phase and direction, for what needs no redraw while the finger moves (it redraws when either changes). */
export function useSwipePhase(store: SwipeStep): Pick<SwipeProgress, 'dir' | 'phase'> | null {
  const read = () => {
    const progress = store.get();
    return progress ? `${progress.phase}:${progress.dir}` : '';
  };
  const key = useSyncExternalStore(store.subscribe, read, read);
  return useMemo(() => {
    if (!key) return null;
    const [phase, dir] = key.split(':');
    return { phase: phase as SwipeProgress['phase'], dir: (dir === '1' ? 1 : -1) as SwipeDir };
  }, [key]);
}

export interface SwipeStep extends Pick<ProgressStore, 'get' | 'subscribe'> {
  /** The new item is shown: the host's picture of it (`peek`) can go. */
  settle: () => void;
}

export interface SwipeStepOptions {
  /** The swipe is on (a phone, full screen, two or more items, nothing open over it). */
  enabled: boolean;
  /** There is an item that way (else the item resists, and a release past the line asks `onStep` for the end note). */
  canStep: (dir: SwipeDir) => boolean;
  /** Step that way (also at an end: the host says it is the end). */
  onStep: (dir: SwipeDir) => void;
  /** Leaving now would raise a question (a typed comment): the item springs back and the step asks first. */
  wouldAsk: () => boolean;
  /** More elements that keep a touch themselves (a selector, added to fields, videos and frames). */
  owners?: string;
  /**
   * What follows the finger, when it is not `area` itself (`area` is where the touches are heard): for a swipe that
   * way (`step`) or a drag down (`dismiss`). Read once the swipe is decided, and again when the finger turns back
   * the other way. The elements stay those until the swipe has landed; with `peek`, a step resets them after
   * `onStep` (the host's picture covers the change), so they may be the item's own. Without `peek` the next item
   * fades in on the same elements, so they must outlive the step. Absent, null or empty: `area` moves.
   */
  move?: (gesture: 'step' | 'dismiss', dir: SwipeDir) => readonly (HTMLElement | null | undefined)[] | null;
  /** The item keeps this touch itself (a zoomed image that can still pan that way): no swipe. Absent: nothing does. */
  keeps?: (dir: SwipeDir) => boolean;
  /**
   * The host draws the neighbour that way whole, beside the item (`SWIPE_PEEK_GAP` apart): a committed step slides
   * the item a full width and the gap, steps, and leaves the host's picture in place (`handoff`) until `settle`
   * (or `SWIPE_HANDOFF_MAX_MS`), with no fade in. Absent or false: the next item fades in after the step.
   */
  peek?: (dir: SwipeDir) => boolean;
  /** A drag down closes. Absent: a vertical drag is the page's own. */
  dismiss?: {
    /** Whether a drag down may close now (an image at Fit that cannot pan down). */
    can: () => boolean;
    /** Close (as Back does). */
    onDismiss: () => void;
    /** How far the drag down has gone, 0..1 of a third of the height, to fade the backdrop; 0 when it ends. */
    onProgress?: (share: number) => void;
  };
}

/**
 * Wire the swipe onto `area`: touch listeners (touchmove not passive, so a
 * decided swipe is never also a scroll), the item (`area`, or what `move`
 * names) moved by `transform` only, and the progress for what the host draws
 * beside it.
 */
export function useSwipeStep(area: RefObject<HTMLElement | null>, options: SwipeStepOptions): SwipeStep {
  const progressStore = useMemo(createProgressStore, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled } = options;
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const store = useMemo<SwipeStep>(
    () => ({
      get: progressStore.get,
      subscribe: progressStore.subscribe,
      settle: () => {
        if (progressStore.get()?.phase !== 'handoff') return;
        if (handoffTimer.current) clearTimeout(handoffTimer.current);
        handoffTimer.current = null;
        progressStore.set(null);
      },
    }),
    [progressStore],
  );

  useEffect(() => {
    const el = area.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number; path: EventTarget[] } | null = null;
    let mode: 'idle' | 'swipe' | 'dismiss' | 'native' = 'idle';
    let last = { x: 0, y: 0, t: 0 };
    let vx = 0;
    let vy = 0;
    let raw = 0;
    let rawY = 0;
    let pickedDir: SwipeDir = 1;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let frame = 0;
    /** What follows the finger: `area`, or what the host's `move` names. */
    let moved: readonly HTMLElement[] = [el];
    /** The area's size, read once the swipe is decided (never on every move). */
    let size = { width: 1, height: 1 };
    const measure = () => {
      const rect = el.getBoundingClientRect();
      size = { width: rect.width || 1, height: rect.height || 1 };
    };
    const width = () => size.width;
    const height = () => size.height;
    const reset = (nodes: readonly HTMLElement[]) => {
      for (const node of nodes) {
        node.style.transform = '';
        node.style.transition = '';
        node.style.opacity = '';
      }
    };
    /** Point the swipe at what follows the finger for this gesture (the last one's are put back first). */
    const pick = (gesture: 'step' | 'dismiss', dir: SwipeDir) => {
      const named = optionsRef.current.move?.(gesture, dir)?.filter((node): node is HTMLElement => !!node) ?? [];
      const next = named.length > 0 ? named : [el];
      if (next.length !== moved.length || next.some((node, i) => node !== moved[i])) {
        reset(moved.filter((node) => !next.includes(node)));
        moved = next;
      }
    };
    const draw = (offset: number, transition: string | null, opacity = '', axis: 'x' | 'y' = 'x') => {
      const transform = offset ? (axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`) : '';
      for (const node of moved) {
        node.style.transition = transition ?? 'none';
        node.style.transform = transform;
        node.style.opacity = opacity;
      }
    };
    const unsetTransition = () => {
      for (const node of moved) node.style.transition = '';
    };
    /**
     * A step's slide that is still under way: what lands it. A touch that comes meanwhile lands it at once
     * (`landNow`), so the new swipe starts from the item it brought in.
     */
    let sliding: { timer: ReturnType<typeof setTimeout>; land: (interrupted: boolean) => void } | null = null;
    const slideThen = (ms: number, land: (interrupted: boolean) => void) => {
      const timer = setTimeout(() => {
        sliding = null;
        land(false);
      }, ms);
      sliding = { timer, land };
    };
    const landNow = () => {
      if (frame) {
        // The next item still fading in after a step: in place at once.
        cancelAnimationFrame(frame);
        frame = 0;
        draw(0, null, '');
        unsetTransition();
      }
      if (!sliding) return;
      const { timer, land } = sliding;
      sliding = null;
      clearTimeout(timer);
      land(true);
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };
    /** Once a spring-back or slide-in has run, the item carries no inline transition (unless a new swipe took it meanwhile). */
    const clearTransitionAfter = (ms: number) =>
      later(ms, () => {
        if (mode !== 'swipe' && mode !== 'dismiss') unsetTransition();
      });
    const fade = (share: number) => optionsRef.current.dismiss?.onProgress?.(share);
    const springBack = () => {
      const reduced = prefersReducedMotion();
      const was = progressStore.get();
      draw(0, reduced ? null : `transform ${SWIPE_SPRING_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`);
      fade(0);
      if (was && !reduced) {
        progressStore.set({ dir: was.dir, progress: 0, offset: 0, phase: 'back', ms: SWIPE_SPRING_MS });
        later(SWIPE_SPRING_MS, () => {
          if (progressStore.get()?.phase === 'back') progressStore.set(null);
        });
      } else progressStore.set(null);
      if (reduced) unsetTransition();
      else clearTransitionAfter(SWIPE_SPRING_MS);
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        if (mode === 'swipe' || mode === 'dismiss') springBack();
        start = null;
        mode = 'native';
        return;
      }
      // The last step still sliding in: it lands now, and this swipe starts from the item it brought.
      landNow();
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, path: event.composedPath() };
      mode = 'idle';
      last = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
      vx = 0;
      vy = 0;
      raw = 0;
      rawY = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!start || mode === 'native') return;
      if (event.touches.length !== 1) {
        if (mode === 'swipe' || mode === 'dismiss') springBack();
        mode = 'native';
        return;
      }
      const touch = event.touches[0]!;
      const mx = touch.clientX - start.x;
      const my = touch.clientY - start.y;
      if (mode === 'idle') {
        const decided = decideSwipe(mx, my);
        if (decided === 'wait') return;
        const { dismiss, keeps } = optionsRef.current;
        if (decided === 'native') {
          // Mostly down: a drag to close, where the host allows one now; anything else is the page's own.
          if (dismiss && isDragDown(mx, my) && !textSelected() && sidewaysOwner(start.path, 1, optionsRef.current.owners) !== 'owner' && dismiss.can()) {
            mode = 'dismiss';
            pick('dismiss', 1);
          } else {
            mode = 'native';
            return;
          }
        } else {
          if (textSelected() || sidewaysOwner(start.path, swipeDirOf(mx), optionsRef.current.owners) || keeps?.(swipeDirOf(mx))) {
            mode = 'native';
            return;
          }
          mode = 'swipe';
          pickedDir = swipeDirOf(mx);
          pick('step', pickedDir);
        }
        measure();
      }
      if (event.cancelable) event.preventDefault();
      const dt = Math.max(1, event.timeStamp - last.t);
      vx = (touch.clientX - last.x) / dt;
      vy = (touch.clientY - last.y) / dt;
      last = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
      if (mode === 'dismiss') {
        rawY = Math.max(0, my);
        // Reduced motion: nothing follows the finger; a release far enough still closes.
        if (!prefersReducedMotion()) {
          draw(rawY, null, '', 'y');
          fade(Math.min(1, rawY / (height() * SWIPE_DISMISS_FADE_SHARE)));
        }
        return;
      }
      raw = mx;
      const dir = swipeDirOf(mx);
      if (dir !== pickedDir || !moved[0]!.isConnected) {
        // Turned back past where the finger went down (what moves that way may be something else), or the item was
        // drawn again under the finger (the step a touch landed, drawn after the swipe was decided).
        pickedDir = dir;
        pick('step', dir);
      }
      const can = optionsRef.current.canStep(dir);
      const offset = can ? mx : mx * SWIPE_END_RESIST;
      // Reduced motion: nothing follows the finger (the host's card still says where a release goes).
      if (!prefersReducedMotion()) draw(offset, null);
      progressStore.set(can ? { dir, progress: Math.min(1, Math.abs(mx) / width()), offset: prefersReducedMotion() ? 0 : offset, phase: 'drag' } : null);
    };
    const endDismiss = () => {
      const { dismiss, wouldAsk } = optionsRef.current;
      const h = height();
      if (!dismiss || !dismissCommits(rawY, h, vy)) return springBack();
      if (wouldAsk() || prefersReducedMotion()) {
        // A typed comment (the question row) or reduced motion: no fall, the close (or its question) at once.
        draw(0, null);
        unsetTransition();
        fade(0);
        dismiss.onDismiss();
        return;
      }
      // The image falls away the way the finger went, the backdrop gone with it, then the viewer closes.
      draw(h, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1), opacity ${SWIPE_SLIDE_MS}ms ease-out`, '0', 'y');
      fade(1);
      later(SWIPE_SLIDE_MS, () => {
        dismiss.onDismiss();
        // The close may land a moment later (the route changes on the browser's Back): the item stays gone till
        // then. Still here after that (the close was refused): back as it was.
        later(SWIPE_HANDOFF_MAX_MS, () => {
          draw(0, null);
          unsetTransition();
          fade(0);
        });
      });
    };
    const onEnd = () => {
      if (mode !== 'swipe' && mode !== 'dismiss') {
        start = null;
        mode = 'idle';
        return;
      }
      const was = mode;
      start = null;
      mode = 'idle';
      if (was === 'dismiss') return endDismiss();
      const dir = swipeDirOf(raw);
      const w = width();
      const commits = swipeCommits(raw, w, vx);
      const { canStep, onStep, wouldAsk, peek } = optionsRef.current;
      if (!commits) return springBack();
      if (!canStep(dir) || wouldAsk() || prefersReducedMotion()) {
        // An end (the note), a typed comment (the question row) or reduced motion: no slide, the step (or its answer) at once.
        draw(0, null);
        unsetTransition();
        progressStore.set(null);
        onStep(dir);
        return;
      }
      if (peek?.(dir)) {
        // The neighbour is drawn beside the item: both slide a full width and the gap, and the host's picture of the
        // neighbour stays where it lands until the new item is shown (no fade in: it is the same picture).
        const travel = dir > 0 ? -(w + SWIPE_PEEK_GAP) : w + SWIPE_PEEK_GAP;
        draw(travel, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)`);
        progressStore.set({ dir, progress: 1, offset: travel, phase: 'slide', ms: SWIPE_SLIDE_MS });
        slideThen(SWIPE_SLIDE_MS, () => {
          progressStore.set({ dir, progress: 1, offset: travel, phase: 'handoff' });
          onStep(dir);
          draw(0, null);
          unsetTransition();
          if (handoffTimer.current) clearTimeout(handoffTimer.current);
          handoffTimer.current = setTimeout(() => {
            handoffTimer.current = null;
            if (progressStore.get()?.phase === 'handoff') progressStore.set(null);
          }, SWIPE_HANDOFF_MAX_MS);
        });
        return;
      }
      // The item leaves the way the finger went; the next one comes in from the other side.
      draw(dir > 0 ? -w : w, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)`);
      slideThen(SWIPE_SLIDE_MS, (interrupted) => {
        progressStore.set(null);
        onStep(dir);
        if (interrupted) {
          // A finger is already down for the next swipe: the new item is simply there.
          draw(0, null, '');
          unsetTransition();
          return;
        }
        draw(dir > 0 ? w * 0.25 : -w * 0.25, null, '0');
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = 0;
            draw(0, `transform ${SWIPE_SLIDE_MS + 40}ms cubic-bezier(0.23, 1, 0.32, 1), opacity ${SWIPE_SLIDE_MS}ms ease-out`, '');
            clearTransitionAfter(SWIPE_SLIDE_MS + 40);
          });
        });
      });
    };
    // The area's listeners are there for the whole time the swipe is on, and touchmove is not passive
    // from the touch's first move (iOS treats a touch's moves as cancelable only for listeners present when
    // it began). preventDefault runs only once a swipe is decided (`onMove`), so a vertical scroll stays native.
    // A gesture is also followed on its first target: a touch keeps firing at the element it started on, and
    // that element may be drawn again mid-gesture (Pierre's code view does), after which it is out of the page
    // and nothing it gets bubbles to the item.
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
    // The same event reaches the target and the item while the target is in the page: handled once.
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
      if (sliding) clearTimeout(sliding.timer);
      sliding = null;
      cancelAnimationFrame(frame);
      reset(moved);
      reset([el]);
      optionsRef.current.dismiss?.onProgress?.(0);
      // A step's picture of the new item (`handoff`) outlives the swipe: it goes with `settle` or its own timer.
      if (progressStore.get()?.phase !== 'handoff') progressStore.set(null);
    };
  }, [area, enabled, progressStore]);

  useEffect(
    () => () => {
      if (handoffTimer.current) clearTimeout(handoffTimer.current);
    },
    [],
  );

  return store;
}
