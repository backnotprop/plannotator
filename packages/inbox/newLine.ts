import { useLayoutEffect, useRef, type RefObject } from 'react';
import { captureSettle, playSettle, prefersReducedMotion } from './settle';

export function useNewLineSlide(body: RefObject<HTMLElement | null>, shown: boolean): void {
  const was = useRef(shown);
  useLayoutEffect(() => {
    const arrived = shown && !was.current;
    was.current = shown;
    const list = body.current;
    const line = list?.querySelector<HTMLElement>('[data-inbox-notice]');
    if (!arrived || !list || !line || prefersReducedMotion()) return;
    line.style.display = 'none';
    const before = captureSettle(list);
    line.style.display = '';
    playSettle(list, before);
  }, [shown, body]);
}
