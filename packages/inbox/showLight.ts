/**
 * Show's light (design record "inbox-polish", item 6; inbox.css `data-lit`, `ib-lit`): the rows Show brought in
 * light up where they landed, for `SHOW_LIT_MS`, and the light is then taken off. One light at a time: a new one
 * takes the last one's place.
 *
 * `arrive`: the row the list is scrolling to (the press on the list's pill, ListNewPill.tsx, which may be far
 * from the rows). The light then waits until that row is in view, so its whole time runs in front of the reader
 * (the owner, on the pill: "if I hit the pill, then the timer should reset so I can still see the new one"). The
 * same light and the same time; only its start waits.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SHOW_LIT_MS } from './settle';

const NONE: ReadonlySet<string> = new Set();
/** The share of the row that must show in the list for it to have arrived. */
const ARRIVED = 0.9;

/** Runs `then` once, when `row` is in view in its list (at once when it is, or where the browser cannot say). Returns its cancel. */
function whenInView(row: HTMLElement, then: () => void): () => void {
  const root = row.closest('.ib-lbody');
  if (!root || typeof IntersectionObserver === 'undefined') {
    then();
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.intersectionRatio >= ARRIVED)) return;
      observer.disconnect();
      then();
    },
    { root, threshold: [ARRIVED] },
  );
  observer.observe(row);
  return () => observer.disconnect();
}

export function useShowLight(): {
  /** The rows lit now (`data-lit`). */
  lit: ReadonlySet<string>;
  /** Light `ids` after `after` ms (the rows' slide into place), and no sooner than `arrive` is in view. */
  light: (ids: ReadonlySet<string>, after: number, arrive?: HTMLElement | null) => void;
} {
  const [lit, setLit] = useState(NONE);
  const pending = useRef<(() => void)[]>([]);
  const cancel = useCallback(() => {
    for (const stop of pending.current) stop();
    pending.current = [];
  }, []);
  useEffect(() => cancel, [cancel]);
  const light = useCallback(
    (ids: ReadonlySet<string>, after: number, arrive?: HTMLElement | null) => {
      cancel();
      setLit(NONE);
      const ready = Date.now() + after;
      const start = () => {
        const wait = Math.max(0, ready - Date.now());
        const on = setTimeout(() => setLit(ids), wait);
        const off = setTimeout(() => setLit(NONE), wait + SHOW_LIT_MS);
        pending.current.push(() => clearTimeout(on), () => clearTimeout(off));
      };
      if (arrive) pending.current.push(whenInView(arrive, start));
      else start();
    },
    [cancel],
  );
  return { lit, light };
}
