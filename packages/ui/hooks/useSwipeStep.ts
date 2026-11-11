/** Under reduced motion nothing follows the finger: the step happens on release. */

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';

/** The finger moves this far before the swipe is decided either way. */
export const SWIPE_DECIDE_PX = 10;
/** And must move this many times more sideways than up or down to be a swipe (or more down than sideways to close). */
export const SWIPE_RATIO = 1.5;
export const SWIPE_COMMIT_SHARE = 1 / 3;
/** A flick: this fast (px/ms) in the swipe's direction, and at least `SWIPE_FLICK_MIN_PX` across, steps too. */
export const SWIPE_FLICK_SPEED = 0.5;
export const SWIPE_FLICK_MIN_PX = 40;
/** Past the first or last item the thing follows only this share of the finger. */
export const SWIPE_END_RESIST = 1 / 3;
/** The item leaves (and the next one comes in) in this long. */
export const SWIPE_SLIDE_MS = 180;
export const SWIPE_SPRING_MS = 260;
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

/** What keeps a touch itself, by the elements the finger went down on. A host adds its own. */
const TOUCH_OWNERS = 'video, audio, input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, [data-claims-arrows="true"]';

/** `path` is the touchstart's composed path (through shadow roots); `dir` the way the swipe would step. */
export function sidewaysOwner(path: readonly EventTarget[], dir: SwipeDir, owners?: string): 'owner' | 'sideways' | null {
  const own = owners ? `${TOUCH_OWNERS}, ${owners}` : TOUCH_OWNERS;
  for (const node of path) {
    if (typeof Element === 'undefined' || !(node instanceof Element)) continue;
    if (node === document.documentElement || node === document.body) continue;
    if (node.matches(own)) return 'owner';
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
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
  settle: () => void;
}

export interface SwipeStepOptions {
  enabled: boolean;
  canStep: (dir: SwipeDir) => boolean;
  onStep: (dir: SwipeDir) => void;
  wouldAsk: () => boolean;
  /** More elements that keep a touch themselves (a selector, added to fields, videos and frames). */
  owners?: string;
  /**
   * What follows the finger, when it is not `area` itself (`area` is where the touches are
   * heard): for a swipe that way (`step`) or a drag down (`dismiss`).
   */
  move?: (gesture: 'step' | 'dismiss', dir: SwipeDir) => readonly (HTMLElement | null | undefined)[] | null;
  /** The item keeps this touch itself (a zoomed image that can still pan that way): no swipe. */
  keeps?: (dir: SwipeDir) => boolean;
  peek?: (dir: SwipeDir) => boolean;
  dismiss?: {
    can: () => boolean;
    onDismiss: () => void;
    onProgress?: (share: number) => void;
  };
}

/**
 * Wire the swipe onto `area`: touch listeners (touchmove not passive, so a decided swipe is
 * never also a scroll), the item (`area`.
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
     * A touch that comes meanwhile lands it at once (`landNow`), so the new swipe starts from
     * the item it brought in.
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
      draw(h, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1), opacity ${SWIPE_SLIDE_MS}ms ease-out`, '0', 'y');
      fade(1);
      later(SWIPE_SLIDE_MS, () => {
        dismiss.onDismiss();
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
      draw(dir > 0 ? -w : w, `transform ${SWIPE_SLIDE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)`);
      slideThen(SWIPE_SLIDE_MS, (interrupted) => {
        progressStore.set(null);
        onStep(dir);
        if (interrupted) {
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
    // The area's listeners are there for the whole time the swipe is on, and touchmove is not
    // passive from the touch's first move (iOS treats a touch's moves as cancelable only for
    // listeners present when it began). preventDefault runs only once a swipe is decided
    // (`onMove`), so a vertical scroll stays native.
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
    const onMoveAny = (event: TouchEvent) => {
      if (event === seen) return;
      seen = event;
      onMove(event);
    };
    const onEndAny = (event: TouchEvent) => {
      if (event === seen) return;
      seen = event;
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
