import { useEffect, useState } from 'react';
import { CONTENTS_ACTIVATION_OFFSET } from '../utils/headingScrollSpy';
import { addScrollViewportListener, getScrollViewportRect } from './useScrollViewport';

/** Track the heading at the reading line, even when a scroll skips whole sections. */
export function useActiveSection(
  containerRef: React.RefObject<HTMLElement | null>,
  headingCount: number,
  /** Optional explicit scroll element, available after OverlayScrollArea mounts. */
  scrollElement?: HTMLElement | null,
) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const contentContainer = containerRef.current ?? scrollElement;
    const viewport = scrollElement ?? contentContainer;
    if (!contentContainer || !viewport) return;

    const refresh = () => {
      // Read current nodes, not a count-keyed snapshot: another document can
      // replace every heading while keeping the same count and block ids.
      const headings = contentContainer.querySelectorAll<HTMLElement>(
        '[data-block-type="heading"][data-block-id]',
      );
      const readingLine = getScrollViewportRect(viewport).top + CONTENTS_ACTIVATION_OFFSET;
      let current: HTMLElement | null = null;
      for (const heading of headings) {
        if (heading.getClientRects().length === 0) continue;
        current ??= heading;
        if (heading.getBoundingClientRect().top <= readingLine) current = heading;
        else break;
      }
      setActiveId(current?.dataset.blockId ?? null);
    };

    let frame: number | null = null;
    const scheduleRefresh = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        refresh();
      });
    };
    refresh();
    const removeScrollListener = addScrollViewportListener(viewport, scheduleRefresh);
    window.addEventListener('resize', scheduleRefresh);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null : new ResizeObserver(scheduleRefresh);
    resizeObserver?.observe(contentContainer);
    if (viewport !== contentContainer) resizeObserver?.observe(viewport);
    const mutationObserver = new MutationObserver(scheduleRefresh);
    mutationObserver.observe(contentContainer, { childList: true, characterData: true, subtree: true });

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      removeScrollListener();
      window.removeEventListener('resize', scheduleRefresh);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, headingCount, scrollElement]);

  return activeId;
}
