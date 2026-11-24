import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Every hundredth of a box: a heading pushed off, or a section folding under its heading, is seen within a pixel or two. */
const STEPS = Array.from({ length: 101 }, (_, i) => i / 100);

/** Where a box was, from the top of the scroll's box, when the browser last told. */
interface Seen {
  top: number;
  bottom: number;
}

/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them, and the next
 * heading pushes them off (approval "inbox-sidebar-sticky-headings"; a phone's sheet since "inbox-phone-sidebar-sheet").
 * CSS `position: sticky` does the sticking (inbox.css). This only marks what is drawn: the heading that is stuck takes
 * a hairline (`data-stuck`), and while none is but the scroll has moved, the scroll's top edge takes the header's line
 * (`data-edge`). Both are set from one picture, so the two lines never show at once.
 *
 * Nothing here reads layout: the browser says where the headings, their sections and the scroll's first pixel are
 * (IntersectionObserver, after it has drawn), so a render of the window, a poll or a scroll forces no layout. A heading
 * is stuck while it sits at the scroll's top (the observer's 1 px inset cuts it there, so the browser tells the moment
 * it arrives) and its own section runs on under it (a heading being pushed off, or folded alone, is not).
 */
export function watchStuckHeadings(scroll: HTMLElement): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const seen = new Map<Element, Seen>();
  /** Each heading watched, and the section block it heads. */
  const heads = new Map<HTMLElement, Element | null>();
  /** The headings in the sidebar's order (querySelectorAll's), so the one that pushes another off comes after it. */
  let order: HTMLElement[] = [];
  let scrolled = false;
  /**
   * One heading at most is stuck, worked out afresh from everything the browser has told whenever any of it changes:
   * the last heading, in order, at the scroll's top while its section runs on under it. The browser can tell of the
   * heading arriving before the one it pushes off (in another batch, a frame later), so for that moment both look stuck;
   * the later one is the one on top, and the other's mark goes in the same pass, so two hairlines are never drawn.
   */
  const mark = () => {
    let stuck: HTMLElement | null = null;
    if (scrolled) {
      for (const head of order) {
        if (!heads.has(head)) continue;
        const at = seen.get(head);
        const block = heads.get(head);
        const section = block ? seen.get(block) : undefined;
        if (at && Math.abs(at.top) <= 1 && (!section || section.bottom > at.bottom + 2)) stuck = head;
      }
    }
    for (const head of heads.keys()) {
      const on = head === stuck;
      if (head.hasAttribute('data-stuck') !== on) head.toggleAttribute('data-stuck', on);
    }
    const edge = scrolled && !stuck;
    if (scroll.hasAttribute('data-edge') !== edge) scroll.toggleAttribute('data-edge', edge);
  };
  const boxes = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // The observer's box starts 1 px under the scroll's top: its own top, less that pixel, is the scroll's.
        const top = (entry.rootBounds?.top ?? 1) - 1;
        seen.set(entry.target, { top: entry.boundingClientRect.top - top, bottom: entry.boundingClientRect.bottom - top });
      }
      mark();
    },
    { root: scroll, rootMargin: '-1px 0px 0px 0px', threshold: STEPS },
  );
  // The scroll's first pixel (Sidebar.tsx): whole while the scroll is at its top, cut once it has moved.
  const first = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last) scrolled = !last.isIntersecting || last.intersectionRatio < 1;
      mark();
    },
    { root: scroll, threshold: [1] },
  );
  const top = scroll.querySelector(':scope > [data-scroll-top]');
  if (top) first.observe(top);
  // Sections come and go (Tags, Agents, stars arriving): watch the headings there are, and their sections.
  const watch = () => {
    const now = new Map<HTMLElement, Element | null>();
    for (const head of scroll.querySelectorAll<HTMLElement>('.ib-secrow')) now.set(head, head.parentElement === scroll ? null : head.parentElement);
    for (const [head, section] of heads) {
      if (now.get(head) === section) continue;
      heads.delete(head);
      for (const box of [head, section]) {
        if (!box) continue;
        boxes.unobserve(box);
        seen.delete(box);
      }
    }
    for (const [head, section] of now) {
      if (heads.has(head)) continue;
      heads.set(head, section);
      boxes.observe(head);
      if (section) boxes.observe(section);
    }
    order = [...now.keys()];
  };
  watch();
  const changes = new MutationObserver(watch);
  changes.observe(scroll, { childList: true, subtree: true });
  return () => {
    changes.disconnect();
    boxes.disconnect();
    first.disconnect();
  };
}

const headingOf = (scroll: HTMLElement, section: string) =>
  scroll.querySelector<HTMLElement>(`[data-sidebar-section="${section}"]`)?.closest<HTMLElement>('.ib-secrow') ?? null;

/**
 * Keeps the marks of `watchStuckHeadings` on the scroll `scrollRef` holds (set up once), and returns what a heading
 * calls just before it folds or opens its section: a heading pressed while stuck stays where it was on screen, rather
 * than leaping up out of view with its rows. Only that press reads layout.
 */
export function useStickyHeadings(scrollRef: RefObject<HTMLElement | null>): (section: string) => void {
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    return scroll ? watchStuckHeadings(scroll) : undefined;
  }, [scrollRef]);
  const kept = useRef<{ section: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const want = kept.current;
    if (!want) return;
    kept.current = null;
    const scroll = scrollRef.current;
    const head = scroll ? headingOf(scroll, want.section) : null;
    if (!scroll || !head) return;
    scroll.scrollTop += head.getBoundingClientRect().top - want.top;
  });
  return (section) => {
    const head = scrollRef.current ? headingOf(scrollRef.current, section) : null;
    if (head?.hasAttribute('data-stuck')) kept.current = { section, top: head.getBoundingClientRect().top };
  };
}
