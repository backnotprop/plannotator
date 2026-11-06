/**
 * The review's Comments on a phone, a sheet over the whole window with the page hidden under it. What both reviews
 * (ReviewPane, PullReview) need for that beyond the CSS.
 */
import { useEffect, useRef, type RefObject } from 'react';

/** Long enough for a double tap's second tap, short enough that a real tap after it is not lost. */
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

/**
 * While the sheet is open: focus starts on its close, whatever floated over the page goes, and Escape closes it first.
 * A key inside the sheet is the sheet's own (Escape in its edit box only cancels the edit); this one is for when focus
 * has dropped to the body (after a Cancel or a Delete), where the Inbox's Escape would leave the whole review.
 */
export function usePhoneCommentsSheet(open: boolean, closeRef: RefObject<HTMLElement | null>, close: () => void): void {
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    // What a tap on the Comments button does on its way here, for the other ways in (a keyboard): a press outside
    // dismisses the selection's bar over the page, which would otherwise float over the sheet and take its taps.
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
