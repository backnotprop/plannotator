import { useEffect, useRef, type RefObject } from 'react';

const BAR_HOLD_MS = 350;
let barHold: number | undefined;

/**
 * The sheet's close sits right over the page's bar, which shows the moment the sheet closes: a double tap's second tap
 * would land on whatever is there (Close the review, with words typed in the sheet). For a moment the bar takes no taps.
 */
export function holdBarAfterClose(barChild: HTMLElement | null): void {
  const bar = barChild?.closest<HTMLElement>('.ib-vhead');
  if (!bar) return;
  window.clearTimeout(barHold);
  bar.style.pointerEvents = 'none';
  barHold = window.setTimeout(() => {
    bar.style.pointerEvents = '';
  }, BAR_HOLD_MS);
}

export function usePhoneCommentsSheet(open: boolean, closeRef: RefObject<HTMLElement | null>, close: () => void): void {
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target !== document.body) return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, closeRef]);
}
