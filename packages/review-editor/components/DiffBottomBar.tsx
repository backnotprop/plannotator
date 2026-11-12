import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Lane {
  left: number;
  width: number;
  scrollWidth: number;
}

const MIN_CODE_IN_VIEW = 40;
const CODE_END_ROOM = 8;

function scrollportOf(el: HTMLElement): HTMLElement | null {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

export function DiffBottomBar({ root }: { root: HTMLElement | null }) {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [port, setPort] = useState<HTMLElement | null>(null);
  const dock = useRef<HTMLDivElement>(null);
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
      const scroller = scrollportOf(root);
      setPort(scroller);
      if (!scroller) return;
      const bottom = Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight);
      let found: HTMLElement[] = [];
      for (const host of root.querySelectorAll('diffs-container')) {
        const columns = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? [])].filter((code) => code.scrollWidth > code.clientWidth);
        const box = columns[0]?.getBoundingClientRect();
        if (box && box.top < bottom - MIN_CODE_IN_VIEW && box.bottom - CODE_END_ROOM > bottom) {
          found = columns;
          break;
        }
      }
      for (const code of codes.current) if (!found.includes(code)) code.removeEventListener('scroll', follow);
      for (const code of found) code.addEventListener('scroll', follow, { passive: true });
      codes.current = found;
      const origin = dock.current?.getBoundingClientRect().left ?? scroller.getBoundingClientRect().left;
      const next = found.map((code) => {
        const box = code.getBoundingClientRect();
        return { left: box.left - origin, width: box.width, scrollWidth: code.scrollWidth };
      });
      setLanes((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', queue, { capture: true, passive: true });
    window.addEventListener('resize', queue, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue);
    resized?.observe(root);
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

  if (!port) return null;
  return createPortal(
    <div ref={dock} className="pn-diff-bottom-dock">
      {lanes.map((lane, i) => (
        <div
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          aria-hidden
          data-diff-bottom-bar
          className="pn-diff-bottom-bar"
          style={{ left: lane.left, width: lane.width }}
          onScroll={(event) => {
            const code = codes.current[i];
            if (code && code.scrollLeft !== event.currentTarget.scrollLeft) code.scrollLeft = event.currentTarget.scrollLeft;
          }}
        >
          <div style={{ width: lane.scrollWidth, height: 1 }} />
        </div>
      ))}
    </div>,
    port,
  );
}
