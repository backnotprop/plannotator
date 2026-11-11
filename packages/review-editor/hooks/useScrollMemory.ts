import { useCallback, useEffect, useRef } from 'react';

// The dock hides a tab that is not on screen (or unmounts it), and the browser drops a hidden box's
// scroll, so coming back to it (a click on its tab, or on its file in the tree) would start at line
// 1.
const positions = new Map<string, number>();
const MAX_REMEMBERED = 200;

export function useScrollMemory(key: string, ready: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el || el.clientHeight === 0) return;
    positions.delete(key);
    positions.set(key, el.scrollTop);
    if (positions.size > MAX_REMEMBERED) positions.delete(positions.keys().next().value!);
  }, [key]);
  useEffect(() => {
    const el = ref.current;
    if (!ready || !el) return;
    let frame = 0;
    const restore = () => {
      const top = positions.get(key);
      if (!top) return;
      cancelAnimationFrame(frame);
      let attempts = 0;
      const step = () => {
        el.scrollTop = top;
        if (Math.abs(el.scrollTop - top) > 1 && attempts++ < 60) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    restore();
    let shown = el.clientHeight > 0;
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const now = el.clientHeight > 0;
          if (now && !shown) restore();
          shown = now;
        });
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [key, ready]);
  return { ref, onScroll };
}
