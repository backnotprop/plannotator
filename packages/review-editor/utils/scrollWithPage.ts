const FORWARDED_INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

function scrollerOf(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export interface PageScroll {
  expectJump(): void;
  undo(): void;
}

const JUMP_MS = 1_000;

export function scrollWithPage(root: HTMLElement): PageScroll {
  const page = scrollerOf(root);
  const realRect = () => Element.prototype.getBoundingClientRect.call(root);
  const pageTop = () => (page === document.documentElement ? 0 : page.getBoundingClientRect().top);
  const windowHeight = () => Math.max(window.innerHeight, window.screen?.height ?? 0);
  const position = () => Math.max(0, pageTop() - realRect().top);

  let jumpUntil = 0;
  const moveTo = (top: number | undefined, behavior?: ScrollBehavior) => {
    if (top === undefined) return;
    const rect = realRect();
    const viewTop = pageTop();
    const at = viewTop - rect.top;
    let from = at;
    if (performance.now() >= jumpUntil) {
      if (rect.bottom <= viewTop) return;
      const last = Math.max(0, rect.height - windowHeight());
      if (at > last) from = last;
    }
    page.scrollTo({ top: page.scrollTop + top - from, ...(behavior ? { behavior } : {}) });
  };

  Object.defineProperty(root, 'scrollTop', { configurable: true, get: position, set: (top: number) => moveTo(top) });
  root.scrollTo = ((options: ScrollToOptions) => moveTo(options.top, options.behavior)) as typeof root.scrollTo;
  root.getBoundingClientRect = () => {
    const rect = realRect();
    const top = pageTop();
    const height = Math.min(windowHeight(), rect.height);
    return { x: rect.x, y: top, left: rect.left, right: rect.right, width: rect.width, top, bottom: top + height, height, toJSON: () => ({}) };
  };

  let last = position();
  const follow = () => {
    const now = position();
    if (now === last) return;
    last = now;
    root.dispatchEvent(new Event('scroll'));
  };
  const intent = (event: Event) => {
    jumpUntil = 0;
    if (!root.contains(event.target as Node)) root.dispatchEvent(new Event(event.type));
  };
  page.addEventListener('scroll', follow, { passive: true });
  for (const type of FORWARDED_INTENT) page.addEventListener(type, intent, { passive: true });
  let frame = 0;
  const moved =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(follow);
        });
  for (const child of Array.from(page.children)) moved?.observe(child);

  return {
    expectJump: () => {
      jumpUntil = performance.now() + JUMP_MS;
    },
    undo: () => {
      page.removeEventListener('scroll', follow);
      for (const type of FORWARDED_INTENT) page.removeEventListener(type, intent);
      moved?.disconnect();
      cancelAnimationFrame(frame);
      delete (root as { scrollTop?: number }).scrollTop;
      delete (root as { scrollTo?: unknown }).scrollTo;
      delete (root as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    },
  };
}
