import { useLayoutEffect, useRef, useState } from 'react';

/** Whether an element is narrower than `min`, read before paint and on every resize. Crossing `min` swaps the row elements, which would drop keyboard focus: the focused row is noted before the swap and refocused (without scrolling) after. */
export function useNarrowerThan<T extends HTMLElement = HTMLElement>(min: number, unmeasured: boolean, drawn = true) {
  const ref = useRef<T>(null);
  const [narrower, setNarrower] = useState(unmeasured);
  const current = useRef(unmeasured);
  const focused = useRef<{ attr: string; id: string } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !drawn) return;
    const read = (width: number) => {
      const next = width > 0 ? width < min : unmeasured;
      if (next === current.current) return;
      const active = document.activeElement;
      focused.current = null;
      if (active instanceof HTMLElement && el.contains(active)) {
        for (const attr of ROW_ATTRS) {
          const id = active.closest(`[${attr}]`)?.getAttribute(attr);
          if (id) {
            focused.current = { attr, id };
            break;
          }
        }
      }
      current.current = next;
      setNarrower(next);
    };
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    // The border box, as getBoundingClientRect reads it: contentRect leaves out
    // the column's 1px border, so a 900px column would read 899 here.
    const observer = new ResizeObserver((entries) => read(entries[0]?.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [min, unmeasured, drawn]);
  useLayoutEffect(() => {
    const target = focused.current;
    focused.current = null;
    if (!target || !ref.current) return;
    const row = [...ref.current.querySelectorAll<HTMLElement>(`[${target.attr}]`)].find((r) => r.getAttribute(target.attr) === target.id);
    row?.focus({ preventScroll: true });
  }, [narrower]);
  return [ref, narrower] as const;
}

const ROW_ATTRS = ['data-thread-id'];
