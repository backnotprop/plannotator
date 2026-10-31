import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeHeadingBinding, bindHeadings, type HeadingBinding } from '../utils/headingScrollSpy';

/**
 * The block id of the heading being read in `scrollViewport`, by the contents
 * rail's own scroll math (utils/headingScrollSpy): cached heading tops, read
 * on every scroll frame, the last heading at the document's end. For a
 * Contents list on the rail's surface (`DocumentContents`), so the two never
 * disagree. Plan review's list keeps `useActiveSection`.
 *
 * Reads at once on mount (a sheet opened mid-document marks the section being
 * read on its first paint), and re-binds when the document's elements change
 * (an edit can replace the headings and keep their count) or resize. Before
 * any heading is drawn the answer stays what it was.
 */
export function useHeadingScrollSpy(
  scrollViewport: HTMLElement | null,
  blockIds: readonly string[],
): string | null {
  const idsKey = blockIds.join('\n');
  // Stable while the ids are the same, whatever array the caller passes.
  const ids = useMemo(() => (idsKey === '' ? [] : idsKey.split('\n')), [idsKey]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const bindingsRef = useRef<readonly HeadingBinding[]>([]);

  const refresh = useCallback(() => {
    if (scrollViewport === null) return;
    const binding = activeHeadingBinding(bindingsRef.current, scrollViewport);
    if (binding !== null) setActiveIndex(binding.itemIndex);
  }, [scrollViewport]);

  useLayoutEffect(() => {
    setActiveIndex(null);
    bindingsRef.current = [];
    if (scrollViewport === null || ids.length === 0) return;
    const rebind = () => {
      bindingsRef.current = bindHeadings(scrollViewport, ids);
      refresh();
    };
    rebind();

    let scrollFrame: number | null = null;
    const onScroll = () => {
      if (scrollFrame !== null) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        refresh();
      });
    };
    let bindFrame: number | null = null;
    const scheduleRebind = () => {
      if (bindFrame !== null) cancelAnimationFrame(bindFrame);
      bindFrame = requestAnimationFrame(() => {
        bindFrame = null;
        rebind();
      });
    };
    scrollViewport.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleRebind);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleRebind);
    resizeObserver?.observe(scrollViewport);
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(scheduleRebind);
    mutationObserver?.observe(scrollViewport, { childList: true, subtree: true });
    return () => {
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      if (bindFrame !== null) cancelAnimationFrame(bindFrame);
      scrollViewport.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleRebind);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [ids, refresh, scrollViewport]);

  return activeIndex === null ? null : (ids[activeIndex] ?? null);
}
