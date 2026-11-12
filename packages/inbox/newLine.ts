import { useLayoutEffect, useRef, type RefObject } from 'react';
import { captureSettle, playSettle, prefersReducedMotion } from './settle';

export type NewLineArrival = 'today' | 'slide' | 'float';

function readArrival(): NewLineArrival {
  if (typeof location === 'undefined') return 'float';
  const asked = new URLSearchParams(location.search).get('newline');
  return asked === 'today' || asked === 'slide' ? asked : 'float';
}

export const NEW_LINE_ARRIVAL: NewLineArrival = readArrival();

export function newLineArrival(flatList: boolean): NewLineArrival {
  return flatList && NEW_LINE_ARRIVAL === 'float' ? 'slide' : NEW_LINE_ARRIVAL;
}

export function useNewLineSlide(body: RefObject<HTMLElement | null>, shown: boolean, arrival: NewLineArrival): void {
  const was = useRef(shown);
  useLayoutEffect(() => {
    const arrived = shown && !was.current;
    was.current = shown;
    const list = body.current;
    const line = list?.querySelector<HTMLElement>('[data-inbox-notice]');
    if (!arrived || arrival !== 'slide' || !list || !line || prefersReducedMotion()) return;
    line.style.display = 'none';
    const before = captureSettle(list);
    line.style.display = '';
    playSettle(list, before);
  }, [shown, arrival, body]);
}
