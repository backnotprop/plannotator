import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * The thread's scroll, kept while something takes the messages' place (the Artifacts view, the thread's board): the
 * body is `display:none` meanwhile, and WebKit forgets a hidden scroller's `scrollTop`. It goes back as the messages
 * come back, before the paint, so the thread is where it was left. Going from one view to the other keeps it too.
 */
export function useKeptScroll(bodyRef: RefObject<HTMLElement | null>, away: boolean) {
  const kept = useRef(0);
  const was = useRef(away);
  useLayoutEffect(() => {
    if (was.current === away) return;
    was.current = away;
    if (!away && bodyRef.current) bodyRef.current.scrollTop = kept.current;
  }, [bodyRef, away]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || away) return;
    const keep = () => {
      kept.current = body.scrollTop;
    };
    body.addEventListener('scroll', keep, { passive: true });
    return () => body.removeEventListener('scroll', keep);
  }, [bodyRef, away]);
}
