/**
 * GitHub's wide-diff bar: while a file's code runs past the bottom of its scroll pane, a native scrollbar pinned to
 * the pane's bottom edge mirrors that file's sideways scroll (one per column in split view). Pierre's own bar at the
 * bottom of the code stays; this one shows only while that bar is below the screen, and only for the file in view.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Lane {
  left: number;
  top: number;
  width: number;
  scrollWidth: number;
}

/** Pierre's bar is 6px; a file must show at least this much code above the pane's bottom to get one. */
const MIN_CODE_IN_VIEW = 40;

/** The element that scrolls `el` up and down: itself, or the nearest ancestor that does. */
function scrollportOf(el: HTMLElement): HTMLElement | null {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

export function DiffBottomBar({ root }: { root: HTMLElement | null }) {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const codes = useRef<HTMLElement[]>([]);
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const follow = useRef(() => {
    bars.current.forEach((bar, i) => {
      const code = codes.current[i];
      if (bar && code && bar.scrollLeft !== code.scrollLeft) bar.scrollLeft = code.scrollLeft;
    });
  }).current;

  useEffect(() => {
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const port = scrollportOf(root);
      const bottom = Math.min(port?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight);
      let found: HTMLElement[] = [];
      for (const host of root.querySelectorAll('diffs-container')) {
        const columns = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? [])].filter((code) => code.scrollWidth > code.clientWidth);
        const box = columns[0]?.getBoundingClientRect();
        if (box && box.top < bottom - MIN_CODE_IN_VIEW && box.bottom > bottom) {
          found = columns;
          break;
        }
      }
      for (const code of codes.current) if (!found.includes(code)) code.removeEventListener('scroll', follow);
      for (const code of found) code.addEventListener('scroll', follow, { passive: true });
      codes.current = found;
      const next = found.map((code) => {
        const box = code.getBoundingClientRect();
        return { left: box.left, top: bottom, width: box.width, scrollWidth: code.scrollWidth };
      });
      setLanes((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // A pane's own scroll does not bubble; captured at the window, every light-DOM scroller's does.
    window.addEventListener('scroll', queue, { capture: true, passive: true });
    window.addEventListener('resize', queue, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue);
    resized?.observe(root);
    // Files mount as they scroll into view, after the scroll that brought them.
    const mounted = new MutationObserver(queue);
    mounted.observe(root, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', queue, { capture: true });
      window.removeEventListener('resize', queue);
      resized?.disconnect();
      mounted.disconnect();
      for (const code of codes.current) code.removeEventListener('scroll', follow);
      codes.current = [];
    };
  }, [root, follow]);

  useLayoutEffect(follow, [lanes, follow]);

  if (lanes.length === 0) return null;
  return createPortal(
    lanes.map((lane, i) => (
      <div
        key={i}
        ref={(el) => {
          bars.current[i] = el;
        }}
        aria-hidden
        data-diff-bottom-bar
        className="pn-diff-bottom-bar"
        style={{ left: lane.left, top: lane.top, width: lane.width }}
        onScroll={(event) => {
          const code = codes.current[i];
          if (code && code.scrollLeft !== event.currentTarget.scrollLeft) code.scrollLeft = event.currentTarget.scrollLeft;
        }}
      >
        <div style={{ width: lane.scrollWidth, height: 1 }} />
      </div>
    )),
    document.body,
  );
}
