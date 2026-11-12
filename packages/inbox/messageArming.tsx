import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { TooltipArmed } from '@plannotator/ui/components/Tooltip';

export const ARM_MARGIN = '100% 0px';
export const DISARM_MARGIN = '300% 0px';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export interface MessageArms {
  armed(id: string): boolean;
  subscribe(id: string, listener: () => void): () => void;
  ref(id: string): (element: HTMLElement | null) => void;
  arm(id: string): void;
  settled(id: string): void;
  disconnect(): void;
}

function scrollRootOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

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
    if (element.contains(document.activeElement) || element.querySelector('[data-popup-open]')) return;
    armedIds.delete(id);
    notify(id);
  };
  const articleOf = (target: EventTarget | null): [string, HTMLElement] | null => {
    const article = target instanceof Element ? target.closest<HTMLElement>('[data-message-article]') : null;
    const id = article ? ids.get(article) : undefined;
    return article && id ? [id, article] : null;
  };
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

export interface MessageArm {
  armed: boolean;
  arm: () => void;
}

const ALWAYS: MessageArm = { armed: true, arm: () => {} };
const MessageArmContext = createContext<MessageArm>(ALWAYS);

export function useMessageArm(): MessageArm {
  return useContext(MessageArmContext);
}

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
