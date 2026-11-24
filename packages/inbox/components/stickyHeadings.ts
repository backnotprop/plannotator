import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them, and the next
 * heading pushes them off (approval "inbox-sidebar-sticky-headings"; a phone's sheet since "inbox-phone-sidebar-sheet").
 * CSS `position: sticky` does the sticking (inbox.css). This only marks what is drawn: the heading that is stuck takes
 * a hairline (`data-stuck`), and while none is but the scroll has moved, the scroll's top edge takes the header's line
 * (`data-edge`). Both are set in one read, so the two lines never show at once.
 */
export function markStuckHeadings(scroll: HTMLElement): void {
  const top = scroll.getBoundingClientRect().top;
  const scrolled = scroll.scrollTop > 0;
  let any = false;
  for (const head of scroll.querySelectorAll<HTMLElement>('.ib-secrow')) {
    const section = head.parentElement?.getBoundingClientRect();
    // At the top, and its own section still runs on under it (a heading being pushed off is no longer stuck).
    const stuck = scrolled && head.getBoundingClientRect().top - top <= 1 && (section ? section.bottom - top > head.offsetHeight + 2 : true);
    head.toggleAttribute('data-stuck', stuck);
    any ||= stuck;
  }
  scroll.toggleAttribute('data-edge', scrolled && !any);
}

const headingOf = (scroll: HTMLElement, section: string) =>
  scroll.querySelector<HTMLElement>(`[data-sidebar-section="${section}"]`)?.closest<HTMLElement>('.ib-secrow') ?? null;

/**
 * Keeps the marks of `markStuckHeadings` on the scroll `scrollRef` holds, and returns what a heading calls just before
 * it folds or opens its section: a heading pressed while stuck stays where it was on screen, rather than leaping
 * up out of view with its rows.
 */
export function useStickyHeadings(scrollRef: RefObject<HTMLElement | null>): (section: string) => void {
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const read = () => markStuckHeadings(scroll);
    read();
    scroll.addEventListener('scroll', read, { passive: true });
    return () => scroll.removeEventListener('scroll', read);
  });
  const kept = useRef<{ section: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const want = kept.current;
    const scroll = scrollRef.current;
    kept.current = null;
    const head = want && scroll ? headingOf(scroll, want.section) : null;
    if (!want || !scroll || !head) return;
    scroll.scrollTop += head.getBoundingClientRect().top - want.top;
    markStuckHeadings(scroll);
  });
  return (section) => {
    const head = scrollRef.current ? headingOf(scrollRef.current, section) : null;
    if (head?.hasAttribute('data-stuck')) kept.current = { section, top: head.getBoundingClientRect().top };
  };
}
