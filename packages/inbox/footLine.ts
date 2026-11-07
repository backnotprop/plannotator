/**
 * The thread's bottom bar draws its line only while thread text scrolls under it (approval
 * "inbox-reaction-tray", addendum 2026-11-07 "bottom bar B1"). With nothing under it (the thread all
 * fits, or it is scrolled to its end) the bar sits on the page with no line. The foot carries
 * `data-under` while some of the thread is below the view; inbox.css draws the line and its faint
 * shadow from that.
 */
import { useEffect, useState, type RefObject } from 'react';

/** Under a pixel left below the view counts as the end (a zoomed page scrolls by fractions). */
export const UNDER_FOOT_PX = 1;

/** Some of the thread is below the view, so it runs under the bottom bar. */
export function textUnderFoot(body: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight > UNDER_FOOT_PX;
}

/**
 * Whether the thread's text runs under the bar now. Read again on a scroll, when the thread's box
 * changes (the reply box opens, a file opens beside it, the window resizes) and when what is in it
 * changes size (a message arrives, a fold opens, an image loads). `key` starts over for another thread.
 */
export function useTextUnderFoot(bodyRef: RefObject<HTMLElement | null>, key: unknown): boolean {
  const [under, setUnder] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const check = () => setUnder(textUnderFoot(body));
    check();
    body.addEventListener('scroll', check, { passive: true });
    // The body and each of its children: a child growing (a message, a fold, an image) changes what is
    // below the view with no scroll. A child that comes or goes is observed (or dropped) as it does.
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    const watched = new Set<Element>();
    const watchChildren = () => {
      if (!sized) return;
      const now = new Set(body.children);
      for (const el of watched) {
        if (now.has(el)) continue;
        sized.unobserve(el);
        watched.delete(el);
      }
      for (const el of now) {
        if (watched.has(el)) continue;
        sized.observe(el);
        watched.add(el);
      }
    };
    sized?.observe(body);
    watchChildren();
    const added =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            watchChildren();
            check();
          })
        : null;
    added?.observe(body, { childList: true });
    return () => {
      body.removeEventListener('scroll', check);
      sized?.disconnect();
      added?.disconnect();
    };
  }, [bodyRef, key]);
  return under;
}
