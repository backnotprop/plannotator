import { useLayoutEffect, useState, type RefObject } from 'react';

export const UNDER_FOOT_PX = 1;

export function textUnderFoot(body: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight > UNDER_FOOT_PX;
}

export function useTextUnderFoot(bodyRef: RefObject<HTMLElement | null>, key: unknown): boolean {
  const [under, setUnder] = useState(false);
  // Before paint: the pane is not keyed per thread, so another thread never shows the last one's line for a frame.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const check = () => setUnder(textUnderFoot(body));
    check();
    body.addEventListener('scroll', check, { passive: true });
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
