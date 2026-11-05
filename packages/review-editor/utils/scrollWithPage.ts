/**
 * Lets a Pierre CodeView live in the page's flow, as tall as its content, and still draw only the rows near the
 * viewport. CodeView asks its root element four things: `scrollTop`, `scrollTo`, its height and its `scroll` event.
 * Those are answered from the page's scroller, so Pierre's own windowing and anchoring run against the page, the
 * browser scrolls everything natively, and sticky headers stick to the page. No rows are positioned here.
 */

const FORWARDED_INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

function scrollerOf(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export interface PageScroll {
  /** The next moves are a jump asked for by name (a line, a comment): take them as they come. */
  expectJump(): void;
  undo(): void;
}

/** How long a jump's moves can keep coming, its animation included. */
const JUMP_MS = 1_000;

/** Answers `root`'s scroll questions from the page. */
export function scrollWithPage(root: HTMLElement): PageScroll {
  const page = scrollerOf(root);
  const realRect = () => Element.prototype.getBoundingClientRect.call(root);
  const pageTop = () => (page === document.documentElement ? 0 : page.getBoundingClientRect().top);
  // The tallest the viewport can get, so a resize needs no new window: CodeView reads its height only when told to.
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
      // CodeView keeping its anchor. Wholly above the viewport, the browser's own scroll anchoring already keeps the
      // reader's place; past the last whole window CodeView sees `last`, not `at`, so what it asks for is a move from there.
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
    // Never taller than the root: CodeView would hold its rows that far down the viewport.
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
  // A person moving the page ends any scroll CodeView has under way, as a wheel over its own root would.
  const intent = (event: Event) => {
    jumpUntil = 0;
    if (!root.contains(event.target as Node)) root.dispatchEvent(new Event(event.type));
  };
  page.addEventListener('scroll', follow, { passive: true });
  for (const type of FORWARDED_INTENT) page.addEventListener(type, intent, { passive: true });
  // Something above grew or shrank without a scroll: the root moved all the same.
  const moved = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
  for (const child of Array.from(page.children)) moved?.observe(child);

  return {
    expectJump: () => {
      jumpUntil = performance.now() + JUMP_MS;
    },
    undo: () => {
      page.removeEventListener('scroll', follow);
      for (const type of FORWARDED_INTENT) page.removeEventListener(type, intent);
      moved?.disconnect();
      delete (root as { scrollTop?: number }).scrollTop;
      delete (root as { scrollTo?: unknown }).scrollTo;
      delete (root as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    },
  };
}
