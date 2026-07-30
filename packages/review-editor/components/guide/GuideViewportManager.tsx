import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const MAX_MOUNTED_CODE_VIEWS = 8;
const INITIAL_MOUNTED_CODE_VIEWS = 2;
const OUTER_OVERSCAN_PX = 1_200;
const FAST_SCROLL_VELOCITY_PX_PER_MS = 1.2;
const SCROLL_IDLE_MS = 120;
const FORCE_MOUNT_MS = 1_500;

interface RegisteredShell {
  element: HTMLElement;
  near: boolean;
}

type Subscriber = () => void;

function findScrollRoot(host: HTMLElement): HTMLElement | null {
  let current = host.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
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
 * Pierre virtualizes lines INSIDE each mounted CodeView. This manager bounds
 * how many one-file CodeViews exist at all, without making 250 shell components
 * rerender on every scroll-window update: subscribers are keyed per file id.
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
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private forcedId: string | null = null;
  private fastScrolling = false;
  private lastScrollTop = 0;
  private lastScrollAt = 0;

  attachHost = (host: HTMLElement | null): void => {
    if (host === this.host) return;
    this.cleanObservers();
    this.host = host;
    if (!host) return;

    this.scrollRoot = findScrollRoot(host);
    this.lastScrollTop = this.readScrollTop();
    this.lastScrollAt = performance.now();

    // Distance-based reconciliation still works without IntersectionObserver,
    // but only if scrolling continues to schedule it. Register this listener for
    // both paths so older embedded browsers do not freeze the initial window.
    const scrollTarget: EventTarget = this.scrollRoot ?? window;
    scrollTarget.addEventListener('scroll', this.handleOuterScroll, { passive: true });

    if (typeof IntersectionObserver === 'undefined') {
      for (const entry of this.entries.values()) entry.near = true;
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

    const near = typeof IntersectionObserver === 'undefined';
    this.entries.set(id, { element, near });
    this.elementIds.set(element, id);
    this.observer?.observe(element);

    // Avoid a blank first paint before IntersectionObserver's first delivery.
    // Only the first couple of shells seed eagerly; the observer immediately
    // replaces them with the real viewport window.
    if (this.mounted.size < INITIAL_MOUNTED_CODE_VIEWS) {
      this.setMounted(new Set([...this.mounted, id]));
    }
    if (near || this.forcedId === id) this.scheduleReconcile();
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
    if (!pinned) {
      this.pinned.delete(id);
      this.scheduleReconcile();
      return;
    }

    this.pinned.add(id);
    const next = new Set(this.mounted);
    next.add(id);
    if (next.size > MAX_MOUNTED_CODE_VIEWS) {
      const eviction = this.farthestMountedFrom(id, next);
      if (eviction) next.delete(eviction);
    }
    this.setMounted(next);
  };

  requestMount = (id: string): void => {
    this.forcedId = id;
    const next = new Set(this.mounted);
    next.add(id);
    if (next.size > MAX_MOUNTED_CODE_VIEWS) {
      const eviction = this.farthestMountedFrom(id, next);
      if (eviction) next.delete(eviction);
    }
    this.setMounted(next);

    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => {
      if (this.forcedId === id) this.forcedId = null;
      this.forceTimer = null;
      this.reconcile();
    }, FORCE_MOUNT_MS);
  };

  private handleIntersections = (changes: IntersectionObserverEntry[]): void => {
    for (const change of changes) {
      if (!(change.target instanceof HTMLElement)) continue;
      const id = this.elementIds.get(change.target);
      const entry = id ? this.entries.get(id) : undefined;
      if (entry) entry.near = change.isIntersecting;
    }
    if (this.fastScrolling) {
      this.scheduleIdleReconcile();
    } else {
      this.scheduleReconcile();
    }
  };

  private handleOuterScroll = (): void => {
    const now = performance.now();
    const scrollTop = this.readScrollTop();
    const elapsed = Math.max(1, now - this.lastScrollAt);
    const velocity = Math.abs(scrollTop - this.lastScrollTop) / elapsed;
    this.lastScrollTop = scrollTop;
    this.lastScrollAt = now;
    this.fastScrolling = velocity >= FAST_SCROLL_VELOCITY_PX_PER_MS;

    if (this.fastScrolling) this.scheduleIdleReconcile();
    else this.scheduleReconcile();
  };

  private scheduleIdleReconcile(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.fastScrolling = false;
      this.reconcile();
    }, SCROLL_IDLE_MS);
  }

  private scheduleReconcile(): void {
    if (this.reconcileRaf != null) return;
    this.reconcileRaf = requestAnimationFrame(() => {
      this.reconcileRaf = null;
      if (!this.fastScrolling) this.reconcile();
    });
  }

  private reconcile(): void {
    const rootRect = this.getRootRect();
    const candidates = [...this.entries.entries()]
      .filter(([id, entry]) => entry.near || id === this.forcedId || this.pinned.has(id))
      .map(([id, entry]) => ({
        id,
        distance: this.distanceFromViewport(entry.element.getBoundingClientRect(), rootRect)
          - (this.mounted.has(id) ? 80 : 0),
      }))
      .sort((left, right) => left.distance - right.distance);

    // Before the first observer delivery, retain the tiny eager seed rather
    // than flashing every CodeView off and back on.
    if (candidates.length === 0 && this.mounted.size > 0) return;

    const next = new Set<string>();
    for (const id of this.pinned) {
      if (next.size >= MAX_MOUNTED_CODE_VIEWS) break;
      if (this.entries.has(id)) next.add(id);
    }
    if (this.forcedId && this.entries.has(this.forcedId) && next.size < MAX_MOUNTED_CODE_VIEWS) {
      next.add(this.forcedId);
    }
    for (const candidate of candidates) {
      if (next.size >= MAX_MOUNTED_CODE_VIEWS) break;
      next.add(candidate.id);
    }
    this.setMounted(next);
  }

  private farthestMountedFrom(protectedId: string, ids: ReadonlySet<string>): string | null {
    const rootRect = this.getRootRect();
    let farthest: { id: string; distance: number } | null = null;
    for (const id of ids) {
      if (id === protectedId || this.pinned.has(id)) continue;
      const entry = this.entries.get(id);
      if (!entry) return id;
      const distance = this.distanceFromViewport(entry.element.getBoundingClientRect(), rootRect);
      if (!farthest || distance > farthest.distance) farthest = { id, distance };
    }
    return farthest?.id ?? null;
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

  private distanceFromViewport(rect: DOMRectReadOnly, root: DOMRectReadOnly): number {
    if (rect.bottom < root.top) return root.top - rect.bottom;
    if (rect.top > root.bottom) return rect.top - root.bottom;
    const rectCenter = rect.top + rect.height / 2;
    const rootCenter = root.top + root.height / 2;
    return Math.abs(rectCenter - rootCenter) * 0.1;
  }

  private readScrollTop(): number {
    return this.scrollRoot?.scrollTop ?? window.scrollY;
  }

  private cleanObservers(): void {
    this.observer?.disconnect();
    this.observer = null;
    const scrollTarget: EventTarget = this.scrollRoot ?? window;
    scrollTarget.removeEventListener('scroll', this.handleOuterScroll);
    this.scrollRoot = null;
    if (this.reconcileRaf != null) cancelAnimationFrame(this.reconcileRaf);
    this.reconcileRaf = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = null;
    this.forcedId = null;
    this.fastScrolling = false;
  }
}

const GuideViewportContext = createContext<GuideViewportManager | null>(null);

export function GuideViewportProvider({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [manager] = useState(() => new GuideViewportManager());
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
} {
  const manager = useContext(GuideViewportContext);
  if (!manager) throw new Error('useGuideFileWindow must be used within GuideViewportProvider');

  const subscribe = useCallback((callback: Subscriber) => manager.subscribe(id, callback), [manager, id]);
  const getSnapshot = useCallback(() => manager.isMounted(id), [manager, id]);
  const mounted = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const register = useCallback((element: HTMLElement | null) => manager.register(id, element), [manager, id]);
  const requestMount = useCallback(() => manager.requestMount(id), [manager, id]);

  // The guide has one focus arbiter. Keeping that file pinned preserves any
  // portaled annotation composer and its draft-owning CodeView during scrolling.
  useEffect(() => {
    manager.setPinned(id, pinned);
    return () => manager.setPinned(id, false);
  }, [manager, id, pinned]);

  return { mounted, register, requestMount };
}

export const GUIDE_MAX_MOUNTED_CODE_VIEWS = MAX_MOUNTED_CODE_VIEWS;
