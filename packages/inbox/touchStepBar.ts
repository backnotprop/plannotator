/**
 * Stepping a thread's files on a touch tablet (approval "inbox-touch-file-stepping", 2026-11-12, "Arrows plus a
 * swipe"; the mock is not in this repo). A touch tablet is a touch screen (phone.ts `TOUCH_QUERY`: a coarse pointer
 * without hover) that does not have the phone layout: an iPad in either orientation. There the stepper under the open
 * file has finger-sized ‹ › at its two ends (touchStepBar.css), beside the thread and in full screen, and the phone's
 * swipe steps on the file (fileSwipe.ts) with the window's left and right edges left to Safari's Back and Forward. A
 * mouse and a phone keep what they had.
 *
 * The bar hides while the on-screen keyboard is up (it would sit under it), and comes back when it goes down.
 */

import { useEffect, useState } from 'react';
import { useTouchScreen } from './phone';

/** Whether the window is a touch tablet now (and again on a rotation or a resize into the phone layout). */
export function useTouchTablet(phone: boolean): boolean {
  return useTouchScreen() && !phone;
}

/**
 * Whether the on-screen keyboard covers the bottom of the window: the visual viewport, unzoomed, is shorter than the
 * layout (`clientHeight`, never `innerHeight`: phone.ts `keyboardLayout`) by more than a hardware keyboard's 80 px bar.
 */
export function keyboardCovers(vv: { height: number; scale: number } | null, layoutHeight: number): boolean {
  return vv !== null && Math.abs(vv.scale - 1) < 0.01 && layoutHeight - vv.height > 80;
}

/** `keyboardCovers`, read again as the visual viewport changes and as a field takes or loses focus. Off: false. */
export function useOnScreenKeyboard(on: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? (window.visualViewport ?? null) : null;
    if (!on || !vv) {
      setUp(false);
      return;
    }
    let frame = 0;
    const read = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setUp(keyboardCovers(vv, document.documentElement.clientHeight));
      });
    };
    read();
    vv.addEventListener('resize', read);
    window.addEventListener('resize', read);
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', read);
      window.removeEventListener('resize', read);
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', read);
    };
  }, [on]);
  return up;
}

/**
 * The open file's touch bar: on a touch tablet with files to step through, `shown`, or `typing` while the on-screen
 * keyboard is up (the bar hides); null elsewhere (a mouse and a phone keep what they had).
 */
export function useTouchStepBar(phone: boolean, steps: boolean): { tablet: boolean; bar: 'shown' | 'typing' | null } {
  const tablet = useTouchTablet(phone);
  const keyboard = useOnScreenKeyboard(tablet && steps);
  return { tablet, bar: tablet && steps ? (keyboard ? 'typing' : 'shown') : null };
}
