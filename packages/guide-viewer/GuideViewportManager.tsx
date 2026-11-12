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
export const GUIDE_EAGER_MOUNT_MAX_FILES = 15;
const OUTER_OVERSCAN_PX = 1_200;
const FORCE_MOUNT_MS = 1_500;
const PASSING_SPEED = 45;
const FALLING_BEHIND_MS = 40;
const KEY_SCROLL_START_FRAMES = 6;
const SMOOTH_JUMP_VIEWS = 2;
const SMOOTH_DONE_FRAMES = 3;
const LANDED_FRAMES = 8;
const LANDING_MAX_MS = 4_000;

interface RegisteredShell {
  element: HTMLElement;
  near: boolean;
}

type Subscriber = () => void;

interface Landing {
  element: HTMLElement;
  root: HTMLElement | null;
  end: boolean;
  lastEnd: number;
  heldTop: number | null;
  lastScrollTop: number;
  smooth: boolean;
  lastTop: number;
  stillFrames: number;
  startedAt: number;
  raf: number;
}

const TAKE_OVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

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
  private lastMotion: 'rest' | 'moving' | 'passing' = 'rest';
  private fallingBehind = false;
  private keyScroll: { moved: boolean; frames: number; end: boolean } | null = null;
  private endArriving = false;
  private landing: Landing | null = null;

  constructor(eager = false) {
    this.eager = eager;
  }

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

  private mountOrWait(id: string): void {
    if (this.passedLastFrame) this.scheduleReconcile();
    else this.setMounted(new Set([...this.mounted, id]));
  }

  jumpTo = (id: string, options: { instant?: boolean } = {}): void => {
    const element = this.entries.get(id)?.element;
    if (!element) return;
    this.endLanding();
    this.endArriving = false;
    const root = this.scrollRoot ?? (this.host ? findScrollRoot(this.host) : null);
    const view = root?.getBoundingClientRect() ?? new DOMRectReadOnly(0, 0, window.innerWidth, window.innerHeight);
    const smooth = !options.instant && Math.abs(element.getBoundingClientRect().top - view.top) <= SMOOTH_JUMP_VIEWS * view.height;
    element.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
    if (!smooth) {
      const onScreen = [...this.entries].filter(([, entry]) => isOnScreen(entry.element.getBoundingClientRect(), view));
      this.setMounted(new Set([...this.mounted, ...onScreen.map(([entryId]) => entryId)]));
    }
    this.startLanding({ element, root, heldTop: null, smooth, end: false });
  };

  private holdInPlace(): void {
    if (this.landing) return;
    const view = this.getRootRect();
    let top = Infinity;
    let element: HTMLElement | null = null;
    for (const entry of this.entries.values()) {
      const rect = entry.element.getBoundingClientRect();
      if (rect.bottom > view.top && rect.top < top) {
        top = rect.top;
        element = entry.element;
      }
    }
    if (element) this.startLanding({ element, root: this.scrollRoot, heldTop: top, smooth: false, end: false });
  }

  private holdEnd(): boolean {
    const host = this.host;
    if (!host) return false;
    const root = this.scrollRoot;
    if (this.readScrollEnd(root) - this.readScrollTop() >= (root ? root.clientHeight : window.innerHeight)) return false;
    this.endLanding();
    this.startLanding({ element: host, root, heldTop: null, smooth: false, end: true });
    return true;
  }

  private readScrollEnd(root: HTMLElement | null): number {
    return root ? root.scrollHeight - root.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
  }

  private startLanding(start: Pick<Landing, 'element' | 'root' | 'heldTop' | 'smooth' | 'end'>): void {
    this.landing = { ...start, lastTop: Number.NaN, lastScrollTop: start.root ? start.root.scrollTop : window.scrollY, lastEnd: Number.NaN, stillFrames: 0, startedAt: performance.now(), raf: 0 };
    for (const type of TAKE_OVER_EVENTS) window.addEventListener(type, this.endLanding, { capture: true, passive: true });
    this.landing.raf = requestAnimationFrame(this.holdLanding);
  }

  private holdLanding = (): void => {
    const landing = this.landing;
    if (!landing) return;
    if (!landing.element.isConnected || performance.now() - landing.startedAt > LANDING_MAX_MS) {
      this.endLanding();
      return;
    }
    if (landing.end) {
      const scrollTop = landing.root ? landing.root.scrollTop : window.scrollY;
      const end = this.readScrollEnd(landing.root);
      if (end === landing.lastEnd && scrollTop <= landing.lastScrollTop - 1) {
        this.endLanding();
        return;
      }
      const short = end - scrollTop >= 1;
      if (short) {
        if (landing.root) landing.root.scrollTop = end;
        else window.scrollTo({ top: end, behavior: 'instant' });
      }
      landing.stillFrames = short || end !== landing.lastEnd ? 0 : landing.stillFrames + 1;
      landing.lastEnd = end;
      landing.lastScrollTop = landing.root ? landing.root.scrollTop : window.scrollY;
      if (landing.stillFrames >= LANDED_FRAMES && this.reconcileRaf == null) {
        this.endLanding();
        return;
      }
      landing.raf = requestAnimationFrame(this.holdLanding);
      return;
    }
    const top = landing.element.getBoundingClientRect().top;
    const scrollTop = landing.root ? landing.root.scrollTop : window.scrollY;
    const moved = Math.abs(top - landing.lastTop) >= 0.5;
    if (!landing.smooth && moved && Math.abs(scrollTop - landing.lastScrollTop) >= 1) {
      this.endLanding();
      return;
    }
    landing.stillFrames = moved ? 0 : landing.stillFrames + 1;
    landing.lastTop = top;
    if (landing.stillFrames >= SMOOTH_DONE_FRAMES) landing.smooth = false;
    if (!landing.smooth) {
      const viewTop = landing.root?.getBoundingClientRect().top ?? 0;
      const wanted = landing.heldTop ?? viewTop + (parseFloat(getComputedStyle(landing.element).scrollMarginTop) || 0);
      if (Math.abs(top - wanted) >= 1) {
        if (landing.heldTop === null) landing.element.scrollIntoView({ behavior: 'instant', block: 'start' });
        else if (landing.root) landing.root.scrollTop += top - wanted;
        else window.scrollBy({ top: top - wanted, behavior: 'instant' });
      }
    }
    landing.lastScrollTop = landing.root ? landing.root.scrollTop : window.scrollY;
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
    this.endArriving = false;
    if (event.key !== 'End' && event.key !== 'Home') return;
    this.keyScroll = { moved: false, frames: 0, end: event.key === 'End' };
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
    const arrived = motion === 'rest' && this.lastMotion === 'passing';
    this.lastMotion = motion;
    if (motion === 'passing') {
      this.scheduleReconcile();
      return;
    }
    if (motion === 'rest' && this.endArriving) {
      this.endArriving = false;
      if (!this.holdEnd() && arrived) this.holdInPlace();
    } else if (arrived) this.holdInPlace();

    const measuredRoot = typeof IntersectionObserver === 'undefined' ? this.getRootRect() : null;
    const next = new Set<string>();
    for (const [id, entry] of this.entries) {
      const near = measuredRoot ? this.isWithinOverscan(entry.element.getBoundingClientRect(), measuredRoot) : entry.near;
      if (near || id === this.forcedId || this.pinned.has(id)) next.add(id);
    }

    if (next.size === 0 && this.mounted.size > 0) return;

    if (motion === 'moving' && !this.fallingBehind) {
      this.setMounted(next);
      this.scheduleReconcile();
      return;
    }
    const step = this.settleStep(next);
    this.setMounted(step);
    if (motion === 'moving' || !setEquals(step, next)) this.scheduleReconcile();
  }

  private readMotion(): 'rest' | 'moving' | 'passing' {
    const top = this.readScrollTop();
    const now = performance.now();
    const moved = Math.abs(top - this.lastScrollTop);
    const elapsed = Math.max(1, Math.min(now - this.lastScrollAt, 50));
    this.fallingBehind = this.lastMotion === 'moving' && now - this.lastScrollAt > FALLING_BEHIND_MS;
    this.lastScrollTop = top;
    this.lastScrollAt = now;
    if (this.landing && !this.landing.smooth) {
      this.passedLastFrame = false;
      return 'rest';
    }
    if (this.keyScroll) {
      if (moved >= 1) this.keyScroll.moved = true;
      else if (this.keyScroll.moved || ++this.keyScroll.frames > KEY_SCROLL_START_FRAMES) {
        this.endArriving = this.keyScroll.moved && this.keyScroll.end;
        this.keyScroll = null;
      }
      if (this.keyScroll) {
        this.passedLastFrame = true;
        return 'passing';
      }
    }
    if (moved < 1) {
      const passedLastFrame = this.passedLastFrame;
      this.passedLastFrame = false;
      return passedLastFrame ? 'passing' : 'rest';
    }
    const viewHeight = this.scrollRoot ? this.scrollRoot.clientHeight : window.innerHeight;
    this.passedLastFrame = moved > viewHeight || moved / elapsed > PASSING_SPEED;
    return this.passedLastFrame ? 'passing' : 'moving';
  }

  private readScrollTop(): number {
    return this.scrollRoot ? this.scrollRoot.scrollTop : window.scrollY;
  }

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
    this.endArriving = false;
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
  jumpTo: (options?: { instant?: boolean }) => void;
} {
  const manager = useContext(GuideViewportContext);
  if (!manager) throw new Error('useGuideFileWindow must be used within GuideViewportProvider');

  const subscribe = useCallback((callback: Subscriber) => manager.subscribe(id, callback), [manager, id]);
  const getSnapshot = useCallback(() => manager.isMounted(id), [manager, id]);
  const mounted = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const register = useCallback((element: HTMLElement | null) => manager.register(id, element), [manager, id]);
  const requestMount = useCallback(() => manager.requestMount(id), [manager, id]);
  const jumpTo = useCallback((options?: { instant?: boolean }) => manager.jumpTo(id, options), [manager, id]);

  useEffect(() => {
    manager.setPinned(id, pinned);
    return () => manager.setPinned(id, false);
  }, [manager, id, pinned]);

  return { mounted, register, requestMount, jumpTo };
}
