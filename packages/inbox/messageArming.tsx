/**
 * A long thread draws its far messages' tooltips and menus as plain controls (#2948, heavy thread).
 *
 * Every open message carries about five tooltips and two menus (its ⋯ and the head line's right-click menu), plus
 * an "Open in…" menu per attached file. Each is a Base UI root of 50 to 200 hooks, mounted whether or not anyone
 * points at it: on a thread of 245 open messages they held about 100 of the window's 160 MB of JS heap. A message
 * is "armed" while it is near the view (within one view's height of it, `ARM_MARGIN`), and is reached by the pointer
 * or focus: then its tooltips and menus are the real ones. A message far from the view (past `DISARM_MARGIN`) is
 * disarmed again, unless focus or an open menu is inside it, so the cost stays with the few messages near the view
 * however far the person scrolls. Disarmed, every control is still drawn, the same element with the same text,
 * label and size (ui's `TooltipArmed`; CopyMenus.tsx and OpenIn.tsx draw their ⋯ plain): nothing a person or the
 * browser's find sees changes, and the thread reads the same.
 *
 * Arming mounts a new copy of a trigger. Focus that lands in a disarmed message (Tab past a very tall message) is
 * put back on the same control once it is armed. A browser with no IntersectionObserver arms everything, as before;
 * a message whose box meets the view's (with the margin) when it is first drawn is armed at once.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { TooltipArmed } from '@plannotator/ui/components/Tooltip';

/** Within this much of the view (a share of its height, above and below), a message's controls are armed. */
export const ARM_MARGIN = '100% 0px';
/** Past this much, they are disarmed again (wider than ARM_MARGIN, so a small scroll does not arm and disarm). */
export const DISARM_MARGIN = '300% 0px';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export interface MessageArms {
  armed(id: string): boolean;
  subscribe(id: string, listener: () => void): () => void;
  /** The ref for a message's `<article>` (stable per id). */
  ref(id: string): (element: HTMLElement | null) => void;
  /** Arm a message now (a press on one of its plain controls). */
  arm(id: string): void;
  /** After an armed message's controls are drawn: put back focus a re-mounted trigger lost. */
  settled(id: string): void;
  disconnect(): void;
}

/** The nearest ancestor that scrolls vertically; null for the document. */
function scrollRootOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

/** The view's box grown by one view's height above and below, as ARM_MARGIN. */
function nearView(element: HTMLElement, root: HTMLElement | null): boolean {
  const box = element.getBoundingClientRect();
  const view = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, height: window.innerHeight };
  return box.bottom >= view.top - view.height && box.top <= view.bottom + view.height;
}

export function createMessageArms(): MessageArms {
  const armedIds = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const elements = new Map<string, HTMLElement>();
  const ids = new WeakMap<Element, string>();
  const refs = new Map<string, (element: HTMLElement | null) => void>();
  /** Focus a re-mount took away: the message and the place of the focused control among its focusable ones. */
  const refocus = new Map<string, number>();
  let near: IntersectionObserver | null = null;
  let far: IntersectionObserver | null = null;
  let root: HTMLElement | null = null;
  let started = false;
  const noObserver = typeof IntersectionObserver === 'undefined';

  const notify = (id: string) => listeners.get(id)?.forEach((listener) => listener());
  const arm = (id: string) => {
    if (armedIds.has(id)) return;
    armedIds.add(id);
    notify(id);
  };
  const disarm = (id: string) => {
    const element = elements.get(id);
    if (!armedIds.has(id) || !element) return;
    // Never under the person's hands: focus inside, or a menu or tooltip of it open.
    if (element.contains(document.activeElement) || element.querySelector('[data-popup-open]')) return;
    armedIds.delete(id);
    notify(id);
  };
  const articleOf = (target: EventTarget | null): [string, HTMLElement] | null => {
    const article = target instanceof Element ? target.closest<HTMLElement>('[data-message-article]') : null;
    const id = article ? ids.get(article) : undefined;
    return article && id ? [id, article] : null;
  };
  // Reached before an observer said so (the first frame, a jump): the pointer arms the message it is over.
  const onPointer = (event: Event) => {
    const hit = articleOf(event.target);
    if (hit && !armedIds.has(hit[0])) arm(hit[0]);
  };
  const onFocus = (event: Event) => {
    const hit = articleOf(event.target);
    if (!hit || armedIds.has(hit[0])) return;
    const [id, article] = hit;
    const place = [...article.querySelectorAll(FOCUSABLE)].indexOf(event.target as Element);
    if (place >= 0) refocus.set(id, place);
    arm(id);
  };
  const start = (element: HTMLElement) => {
    started = true;
    root = scrollRootOf(element);
    const host: HTMLElement | Document = root ?? document;
    host.addEventListener('pointerover', onPointer, true);
    host.addEventListener('focusin', onFocus, true);
    if (noObserver) return;
    // `?? []`: a stand-in observer (the DOM tests') may report with no entries.
    near = new IntersectionObserver(
      (entries) => {
        for (const entry of entries ?? []) {
          const id = ids.get(entry.target);
          if (id && entry.isIntersecting) arm(id);
        }
      },
      { root, rootMargin: ARM_MARGIN },
    );
    far = new IntersectionObserver(
      (entries) => {
        for (const entry of entries ?? []) {
          const id = ids.get(entry.target);
          if (id && !entry.isIntersecting) disarm(id);
        }
      },
      { root, rootMargin: DISARM_MARGIN },
    );
  };

  return {
    armed: (id) => noObserver || armedIds.has(id),
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(id);
      };
    },
    ref(id) {
      let ref = refs.get(id);
      if (ref) return ref;
      ref = (element) => {
        const before = elements.get(id);
        if (before && before !== element) {
          near?.unobserve(before);
          far?.unobserve(before);
          elements.delete(id);
        }
        if (!element) {
          refs.delete(id);
          armedIds.delete(id);
          refocus.delete(id);
          return;
        }
        if (before === element) return;
        if (!started) start(element);
        elements.set(id, element);
        ids.set(element, id);
        near?.observe(element);
        far?.observe(element);
        // Drawn near the view: armed at once, before the observer's first report.
        if (nearView(element, root)) arm(id);
      };
      refs.set(id, ref);
      return ref;
    },
    arm,
    settled(id) {
      const place = refocus.get(id);
      if (place === undefined) return;
      refocus.delete(id);
      const element = elements.get(id);
      if (!element || element.contains(document.activeElement)) return;
      element.querySelectorAll<HTMLElement>(FOCUSABLE)[place]?.focus({ preventScroll: true });
    },
    disconnect() {
      near?.disconnect();
      far?.disconnect();
      const host: HTMLElement | Document = root ?? document;
      host.removeEventListener('pointerover', onPointer, true);
      host.removeEventListener('focusin', onFocus, true);
      listeners.clear();
      elements.clear();
      armedIds.clear();
    },
  };
}

/** A message's arming, for its plain controls: whether it is armed, and a way to arm it on a press. */
export interface MessageArm {
  armed: boolean;
  arm: () => void;
}

const ALWAYS: MessageArm = { armed: true, arm: () => {} };
const MessageArmContext = createContext<MessageArm>(ALWAYS);

/** Inside a message: whether its menus are the real ones (outside any message: always). */
export function useMessageArm(): MessageArm {
  return useContext(MessageArmContext);
}

/** Wraps one message's content: its tooltips and menus follow the message's arming. Draws no element. */
export function ArmScope({ arms, id, children }: { arms: MessageArms; id: string; children: ReactNode }) {
  const armed = useSyncExternalStore(
    (listener) => arms.subscribe(id, listener),
    () => arms.armed(id),
    () => true,
  );
  useLayoutEffect(() => {
    if (armed) arms.settled(id);
  }, [armed, arms, id]);
  const arm = useMemo<MessageArm>(() => (armed ? ALWAYS : { armed: false, arm: () => arms.arm(id) }), [armed, arms, id]);
  return (
    <MessageArmContext.Provider value={arm}>
      <TooltipArmed.Provider value={armed}>{children}</TooltipArmed.Provider>
    </MessageArmContext.Provider>
  );
}
