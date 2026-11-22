/**
 * Show never moves the reader (the owner, 2026-11-10 and 2026-11-17). Show redraws the list: the "N new" bar leaves
 * the flow, rows come in, and the settle's slide starts transform animations on the rows in the same commit. Browser
 * scroll anchoring cannot be trusted to keep the rows on screen where they were (Chromium suppresses an adjustment
 * when the anchor's transform changes, Safari has none, a phone's list turns it off). So the list holds its own view:
 * `holdView` notes where the rows on screen are before Show, and `restoreView`, after the redraw and before the slide
 * is played, scrolls the list by however far those rows moved, so they are where they were.
 *
 * Rows that Show moved to another place moved by their own amounts; the rows that kept their order moved together.
 * The shift is the one most of them share (ties: the smallest), never a single row's.
 */

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** The rows on screen in the list's scroll box: each row's id and its top, from the box's top. */
export interface ViewHold {
  tops: ReadonlyMap<string, number>;
}

const ROWS = '[data-thread-id]';

function rowsOnScreen(body: HTMLElement): Map<string, number> {
  const box = body.getBoundingClientRect();
  const tops = new Map<string, number>();
  for (const el of body.querySelectorAll<HTMLElement>(ROWS)) {
    if (el.getClientRects().length === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const id = el.getAttribute('data-thread-id');
    if (id && !tops.has(id)) tops.set(id, rect.top - box.top);
  }
  return tops;
}

export function holdView(body: HTMLElement): ViewHold {
  return { tops: rowsOnScreen(body) };
}

/** How far the rows held moved (the shift most of them share), from where they are drawn now. 0 when none is left. */
export function viewShift(body: HTMLElement, hold: ViewHold): number {
  const box = body.getBoundingClientRect();
  const counts = new Map<number, number>();
  for (const [id, was] of hold.tops) {
    const el = [...body.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)].find((node) => node.getClientRects().length > 0);
    if (!el) continue;
    const shift = Math.round(el.getBoundingClientRect().top - box.top - was);
    counts.set(shift, (counts.get(shift) ?? 0) + 1);
  }
  let best = 0;
  let most = 0;
  for (const [shift, count] of counts) {
    if (count > most || (count === most && Math.abs(shift) < Math.abs(best))) {
      best = shift;
      most = count;
    }
  }
  return best;
}

/** Scroll the list so the rows held are where they were. Returns the shift it made up for. */
export function restoreView(body: HTMLElement, hold: ViewHold): number {
  const shift = viewShift(body, hold);
  if (shift !== 0) body.scrollTop += shift;
  return shift;
}

/**
 * For the list (InboxList): `note()` as Show is pressed; the next commit puts the rows back. Its layout effect is the
 * list's, so it runs before App's `[shown]` layout effect measures and plays the settle's slide: the rows that kept
 * their order then have nothing to slide.
 */
export function useShowHold(body: RefObject<HTMLElement | null>): () => void {
  const held = useRef<ViewHold | null>(null);
  useLayoutEffect(() => {
    const hold = held.current;
    held.current = null;
    if (hold && body.current) restoreView(body.current, hold);
  });
  return useCallback(() => {
    held.current = body.current ? holdView(body.current) : null;
  }, [body]);
}
