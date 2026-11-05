import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const INITIAL_MOUNTED_CODE_VIEWS = 2;
/**
 * Guides with at most this many files mount every CodeView up front instead of
 * running the outer window: the window exists to bound hundreds of shells, and
 * for a small changeset the eviction/remount churn (and the blank shells it
 * leaves while scrolling) costs more than the handful of CodeViews it saves.
 */
export const GUIDE_EAGER_MOUNT_MAX_FILES = 15;
const OUTER_OVERSCAN_PX = 1_200;
const FORCE_MOUNT_MS = 1_500;
/**
 * Scrolling faster than this (px per ms, 750 px a frame) passes files instead of showing them: End, Home, a long
 * scrollbar throw. Nothing mounts until it slows. A hard trackpad flick peaks near 600 px a frame and stays under it.
 */
const PASSING_SPEED = 45;
/** How long End or Home may take to start moving the view before it counts as having done nothing (a text field has the key). */
const KEY_SCROLL_START_FRAMES = 6;
/** A jump further than this many views goes at once: a smooth scroll would mount everything it passes. */
const SMOOTH_JUMP_VIEWS = 2;
/** A smooth scroll that has not moved for this many frames is over. */
const SMOOTH_DONE_FRAMES = 3;
/** The target held still this many frames, with nothing left to mount, ends a jump. */
const LANDED_FRAMES = 8;
const LANDING_MAX_MS = 4_000;

interface RegisteredShell {
  element: HTMLElement;
  near: boolean;
}

type Subscriber = () => void;

/** A jump on its way to its file: see `jumpTo`. */
interface Landing {
  element: HTMLElement;
  root: HTMLElement | null;
  /** A smooth scroll is still running: leave it alone until it stops. */
  smooth: boolean;
  lastTop: number;
  stillFrames: number;
  startedAt: number;
  raf: number;
}

/** Any of these on the page means the person took the scroll back. */
const TAKE_OVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * The nearest ancestor that actually scrolls the guide, or null for the
 * window. `body`/`html` are never returned: an overflow set on them propagates
 * to the viewport (the element itself does not scroll — its scrollHeight equals
 * its clientHeight), so observing it as an IntersectionObserver root would make
 * every shell "near" and mount every file, and hang the scroll listener on an
 * element that never emits scroll events.
 */
function findScrollRoot(host: HTMLElement): HTMLElement | null {
  let current = host.parentElement;
  while (current) {
    if (current === document.body || current === document.documentElement) return null;
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
}

function isOnScreen(rect: DOMRectReadOnly, view: DOMRectReadOnly): boolean {
  return rect.bottom >= view.top && rect.top <= view.bottom;
}

function setEquals(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/**
 * One outer-window coordinator for every file shell in a Guided Review.
 *
 * Pierre virtualizes lines INSIDE each mounted CodeView. This manager keeps a
 * CodeView for every file on screen or within the overscan of it, however many
 * that is (anything on screen draws, at any window size), and none for the rest,
 * without making 250 shell components rerender on every scroll-window update:
 * subscribers are keyed per file id.
 *
 * When a window change lands depends on the scroll. Moving: at once, so a flick
 * runs into files already drawn. Passing (see PASSING_SPEED, and End and Home at
 * any speed): not yet, because those files are gone by the next frame. At rest:
 * what is on screen at once, the rest of the window one file a frame, nearest
 * first, so arriving somewhere far never blocks on mounts nobody is looking at yet.
 */
class GuideViewportManager {
  private entries = new Map<string, RegisteredShell>();
  private elementIds = new WeakMap<HTMLElement, string>();
  private mounted = new Set<string>();
  private pinned = new Set<string>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private observer: IntersectionObserver | null = null;
  private scrollRoot: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private reconcileRaf: number | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private forcedId: string | null = null;
  private eager: boolean;
  private lastScrollTop = 0;
  private lastScrollAt = 0;
  private passedLastFrame = false;
  /** End or Home was pressed: the browser's animated scroll to the far end, if the key moves this view. */
  private keyScroll: { moved: boolean; frames: number } | null = null;
  private landing: Landing | null = null;

  constructor(eager = false) {
    this.eager = eager;
  }

  /**
   * Eager mode mounts every registered shell and keeps it mounted: no window,
   * no observer, no scroll tracking. Flipping it at runtime (a refreshed diff
   * crossing the file threshold) either mounts everything or re-arms the
   * window machinery against the current host.
   */
  setEager = (eager: boolean): void => {
    if (eager === this.eager) return;
    this.eager = eager;
    if (eager) {
      this.cleanObservers();
      this.setMounted(new Set(this.entries.keys()));
      return;
    }
    const host = this.host;
    this.host = null;
    this.attachHost(host);
  };

  attachHost = (host: HTMLElement | null): void => {
    if (host === this.host) return;
    this.cleanObservers();
    this.host = host;
    if (!host) return;
    if (this.eager) {
      this.setMounted(new Set(this.entries.keys()));
      return;
    }

    this.scrollRoot = findScrollRoot(host);
    this.lastScrollTop = this.readScrollTop();
    // Each scroll reads how fast the view is moving (and, with no observer, the window itself).
    const scrollTarget: EventTarget = this.scrollRoot ?? window;
    scrollTarget.addEventListener('scroll', this.handleOuterScroll, { passive: true });
    window.addEventListener('keydown', this.handleKey, { passive: true });

    if (typeof IntersectionObserver === 'undefined') {
      this.reconcile();
      return;
    }

    this.observer = new IntersectionObserver(this.handleIntersections, {
      root: this.scrollRoot,
      rootMargin: `${OUTER_OVERSCAN_PX}px 0px`,
      threshold: 0,
    });
    for (const entry of this.entries.values()) this.observer.observe(entry.element);
  };

  register = (id: string, element: HTMLElement | null): void => {
    const previous = this.entries.get(id);
    if (previous?.element === element) return;
    if (previous) {
      this.observer?.unobserve(previous.element);
      this.elementIds.delete(previous.element);
    }

    if (!element) {
      this.entries.delete(id);
      this.pinned.delete(id);
      // Ref detachment means the subscriber is unmounting too; remove the id
      // without notifying that departing component. A future shell with the
      // same id reads the fresh false snapshot on subscription.
      this.mounted.delete(id);
      this.scheduleReconcile();
      return;
    }

    this.entries.set(id, { element, near: false });
    this.elementIds.set(element, id);
    if (this.eager) {
      this.setMounted(new Set([...this.mounted, id]));
      return;
    }
    this.observer?.observe(element);

    // Avoid a blank first paint before IntersectionObserver's first delivery.
    // Only the first couple of shells seed eagerly; the observer immediately
    // replaces them with the real viewport window.
    if (this.mounted.size < INITIAL_MOUNTED_CODE_VIEWS) {
      this.setMounted(new Set([...this.mounted, id]));
    }
    if (typeof IntersectionObserver === 'undefined' || this.forcedId === id) this.scheduleReconcile();
  };

  subscribe = (id: string, subscriber: Subscriber): (() => void) => {
    let listeners = this.subscribers.get(id);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(id, listeners);
    }
    listeners.add(subscriber);
    return () => {
      listeners?.delete(subscriber);
      if (listeners?.size === 0) this.subscribers.delete(id);
    };
  };

  isMounted = (id: string): boolean => this.mounted.has(id);

  setPinned = (id: string, pinned: boolean): void => {
    if (pinned === this.pinned.has(id)) return;
    if (this.eager) {
      // Everything registered is already mounted; only track the pin so a later
      // switch back to the window keeps the focused file alive.
      if (pinned) this.pinned.add(id);
      else this.pinned.delete(id);
      return;
    }
    if (!pinned) {
      this.pinned.delete(id);
      this.scheduleReconcile();
      return;
    }

    this.pinned.add(id);
    this.mountOrWait(id);
  };

  requestMount = (id: string): void => {
    if (this.eager) {
      if (this.entries.has(id) && !this.mounted.has(id)) this.setMounted(new Set([...this.mounted, id]));
      return;
    }
    this.forcedId = id;
    this.mountOrWait(id);

    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => {
      if (this.forcedId === id) this.forcedId = null;
      this.forceTimer = null;
      this.reconcile();
    }, FORCE_MOUNT_MS);
  };

  /** At once, unless a fast scroll is carrying files under the pointer: each would mount for the one frame it is there. */
  private mountOrWait(id: string): void {
    if (this.passedLastFrame) this.scheduleReconcile();
    else this.setMounted(new Set([...this.mounted, id]));
  }

  /**
   * Takes this file to the top of the view. Near, the scroll is smooth; far, it goes at once, so nothing on the way
   * mounts. Files above the target may still swap their estimated height for a measured one as they draw, so this
   * keeps the target in place until they settle, unless the person scrolls first.
   */
  jumpTo = (id: string): void => {
    const element = this.entries.get(id)?.element;
    if (!element) return;
    this.endLanding();
    const root = this.scrollRoot ?? (this.host ? findScrollRoot(this.host) : null);
    const view = root?.getBoundingClientRect() ?? new DOMRectReadOnly(0, 0, window.innerWidth, window.innerHeight);
    const smooth = Math.abs(element.getBoundingClientRect().top - view.top) <= SMOOTH_JUMP_VIEWS * view.height;
    element.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
    // Arrived in this frame: what is on screen there draws in it too, not when the observer next reports.
    if (!smooth) {
      const onScreen = [...this.entries].filter(([, entry]) => isOnScreen(entry.element.getBoundingClientRect(), view));
      this.setMounted(new Set([...this.mounted, ...onScreen.map(([entryId]) => entryId)]));
    }
    this.landing = { element, root, smooth, lastTop: Number.NaN, stillFrames: 0, startedAt: performance.now(), raf: 0 };
    for (const type of TAKE_OVER_EVENTS) window.addEventListener(type, this.endLanding, { capture: true, passive: true });
    this.landing.raf = requestAnimationFrame(this.holdLanding);
  };

  private holdLanding = (): void => {
    const landing = this.landing;
    if (!landing) return;
    if (!landing.element.isConnected || performance.now() - landing.startedAt > LANDING_MAX_MS) {
      this.endLanding();
      return;
    }
    const top = landing.element.getBoundingClientRect().top;
    landing.stillFrames = Math.abs(top - landing.lastTop) < 0.5 ? landing.stillFrames + 1 : 0;
    landing.lastTop = top;
    if (landing.stillFrames >= SMOOTH_DONE_FRAMES) landing.smooth = false;
    if (!landing.smooth) {
      const viewTop = landing.root?.getBoundingClientRect().top ?? 0;
      const wanted = viewTop + (parseFloat(getComputedStyle(landing.element).scrollMarginTop) || 0);
      // At the very end of the scroll this does nothing, and the target holds still where it is.
      if (Math.abs(top - wanted) >= 1) landing.element.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
    if (landing.stillFrames >= LANDED_FRAMES && this.reconcileRaf == null) {
      this.endLanding();
      return;
    }
    landing.raf = requestAnimationFrame(this.holdLanding);
  };

  private endLanding = (): void => {
    if (!this.landing) return;
    cancelAnimationFrame(this.landing.raf);
    this.landing = null;
    for (const type of TAKE_OVER_EVENTS) window.removeEventListener(type, this.endLanding, { capture: true });
  };

  private handleIntersections = (changes: IntersectionObserverEntry[]): void => {
    for (const change of changes) {
      if (!(change.target instanceof HTMLElement)) continue;
      const id = this.elementIds.get(change.target);
      const entry = id ? this.entries.get(id) : undefined;
      if (entry) entry.near = change.isIntersecting;
    }
    this.scheduleReconcile();
  };

  private handleOuterScroll = (): void => {
    this.scheduleReconcile();
  };

  private handleKey = (event: KeyboardEvent): void => {
    if (event.key !== 'End' && event.key !== 'Home') return;
    this.keyScroll = { moved: false, frames: 0 };
    this.scheduleReconcile();
  };

  private scheduleReconcile(): void {
    if (this.reconcileRaf != null) return;
    this.reconcileRaf = requestAnimationFrame(() => {
      this.reconcileRaf = null;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (this.eager) {
      this.setMounted(new Set(this.entries.keys()));
      return;
    }
    const motion = this.readMotion();
    if (motion === 'passing') {
      this.scheduleReconcile();
      return;
    }

    // With no IntersectionObserver (older embedded browsers) this reads the window itself on each scroll.
    const measuredRoot = typeof IntersectionObserver === 'undefined' ? this.getRootRect() : null;
    const next = new Set<string>();
    for (const [id, entry] of this.entries) {
      const near = measuredRoot ? this.isWithinOverscan(entry.element.getBoundingClientRect(), measuredRoot) : entry.near;
      if (near || id === this.forcedId || this.pinned.has(id)) next.add(id);
    }

    // Before the first observer delivery, retain the tiny eager seed rather
    // than flashing every CodeView off and back on.
    if (next.size === 0 && this.mounted.size > 0) return;

    if (motion === 'moving') {
      this.setMounted(next);
      // A scroll ends with no event of its own: the next frame finds out.
      this.scheduleReconcile();
      return;
    }
    const step = this.settleStep(next);
    this.setMounted(step);
    if (!setEquals(step, next)) this.scheduleReconcile();
  }

  /** How the view moved since the last look. A smooth jump's scroll counts as moving; a landing's small re-aims do not. */
  private readMotion(): 'rest' | 'moving' | 'passing' {
    const top = this.readScrollTop();
    const now = performance.now();
    const moved = Math.abs(top - this.lastScrollTop);
    // Capped: the first scroll after a pause is measured against a frame or two, not the whole pause.
    const elapsed = Math.max(1, Math.min(now - this.lastScrollAt, 50));
    this.lastScrollTop = top;
    this.lastScrollAt = now;
    if (this.landing && !this.landing.smooth) return 'rest';
    if (this.keyScroll) {
      if (moved >= 1) this.keyScroll.moved = true;
      else if (this.keyScroll.moved || ++this.keyScroll.frames > KEY_SCROLL_START_FRAMES) this.keyScroll = null;
      if (this.keyScroll) {
        this.passedLastFrame = true;
        return 'passing';
      }
    }
    if (moved < 1) {
      // One still frame in the middle of a fast scroll (input slower than the frames) is not the end of it.
      const passedLastFrame = this.passedLastFrame;
      this.passedLastFrame = false;
      return passedLastFrame ? 'passing' : 'rest';
    }
    // A step of more than a view: nothing on screen now was on screen last frame, however slow the frames are.
    const viewHeight = this.scrollRoot ? this.scrollRoot.clientHeight : window.innerHeight;
    this.passedLastFrame = moved > viewHeight || moved / elapsed > PASSING_SPEED;
    return this.passedLastFrame ? 'passing' : 'moving';
  }

  private readScrollTop(): number {
    return this.scrollRoot ? this.scrollRoot.scrollTop : window.scrollY;
  }

  /**
   * One frame's step toward the window at rest: everything on screen now, plus the nearest other file, and as many
   * files dropped as that mounted (at least one). Pins and jump targets mounted at once already, on their own paths.
   */
  private settleStep(next: Set<string>): Set<string> {
    const root = this.getRootRect();
    const step = new Set<string>();
    let added = 0;
    let nearest: string | null = null;
    let nearestDistance = Infinity;
    for (const id of next) {
      if (this.mounted.has(id)) {
        step.add(id);
        continue;
      }
      const rect = this.entries.get(id)?.element.getBoundingClientRect();
      const distance = rect ? Math.max(0, root.top - rect.bottom, rect.top - root.bottom) : 0;
      if (distance === 0) {
        step.add(id);
        added += 1;
      } else if (distance < nearestDistance) {
        nearest = id;
        nearestDistance = distance;
      }
    }
    if (nearest !== null) {
      step.add(nearest);
      added += 1;
    }
    let drops = Math.max(1, added);
    for (const id of this.mounted) {
      if (next.has(id)) continue;
      if (drops > 0) drops -= 1;
      else step.add(id);
    }
    return step;
  }

  private setMounted(next: Set<string>): void {
    if (setEquals(this.mounted, next)) return;
    const changed = new Set<string>();
    for (const id of this.mounted) {
      if (!next.has(id)) changed.add(id);
    }
    for (const id of next) {
      if (!this.mounted.has(id)) changed.add(id);
    }
    this.mounted = next;
    for (const id of changed) this.notify(id);
  }

  private notify(id: string): void {
    for (const subscriber of this.subscribers.get(id) ?? []) subscriber();
  }

  private getRootRect(): DOMRectReadOnly {
    if (this.scrollRoot) return this.scrollRoot.getBoundingClientRect();
    return new DOMRectReadOnly(0, 0, window.innerWidth, window.innerHeight);
  }

  private isWithinOverscan(rect: DOMRectReadOnly, root: DOMRectReadOnly): boolean {
    return rect.bottom > root.top - OUTER_OVERSCAN_PX && rect.top < root.bottom + OUTER_OVERSCAN_PX;
  }

  private cleanObservers(): void {
    this.observer?.disconnect();
    this.observer = null;
    const scrollTarget: EventTarget = this.scrollRoot ?? window;
    scrollTarget.removeEventListener('scroll', this.handleOuterScroll);
    window.removeEventListener('keydown', this.handleKey);
    this.keyScroll = null;
    this.scrollRoot = null;
    if (this.reconcileRaf != null) cancelAnimationFrame(this.reconcileRaf);
    this.reconcileRaf = null;
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = null;
    this.forcedId = null;
    this.passedLastFrame = false;
    this.endLanding();
  }
}

const GuideViewportContext = createContext<GuideViewportManager | null>(null);

export function GuideViewportProvider({
  children,
  className,
  eager = false,
}: {
  children: ReactNode;
  className?: string;
  /** Mount every registered shell immediately and keep it mounted (small guides). */
  eager?: boolean;
}) {
  const [manager] = useState(() => new GuideViewportManager(eager));
  useEffect(() => {
    manager.setEager(eager);
  }, [manager, eager]);
  return (
    <GuideViewportContext.Provider value={manager}>
      <div ref={manager.attachHost} className={className}>
        {children}
      </div>
    </GuideViewportContext.Provider>
  );
}

export function useGuideFileWindow(id: string, pinned = false): {
  mounted: boolean;
  register: (element: HTMLElement | null) => void;
  requestMount: () => void;
  jumpTo: () => void;
} {
  const manager = useContext(GuideViewportContext);
  if (!manager) throw new Error('useGuideFileWindow must be used within GuideViewportProvider');

  const subscribe = useCallback((callback: Subscriber) => manager.subscribe(id, callback), [manager, id]);
  const getSnapshot = useCallback(() => manager.isMounted(id), [manager, id]);
  const mounted = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const register = useCallback((element: HTMLElement | null) => manager.register(id, element), [manager, id]);
  const requestMount = useCallback(() => manager.requestMount(id), [manager, id]);
  const jumpTo = useCallback(() => manager.jumpTo(id), [manager, id]);

  // The guide has one focus arbiter. Keeping that file pinned preserves any
  // portaled annotation composer and its draft-owning CodeView during scrolling.
  useEffect(() => {
    manager.setPinned(id, pinned);
    return () => manager.setPinned(id, false);
  }, [manager, id, pinned]);

  return { mounted, register, requestMount, jumpTo };
}
