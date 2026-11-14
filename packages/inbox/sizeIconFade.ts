import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The size icon on an HTML page on a phone gets out of the way (approval
 * "inbox-html-attachments-phone", addendum 2026-11-07 17:53Z, q-a68aff4a): it
 * shows when the page opens and fades after about 3 seconds; a scroll back up,
 * or a tap near the top of the page, brings it back for another 3 seconds.
 * Faded, it takes no taps (inbox.css), so they reach the page. Keyboard focus on
 * it holds it shown. The tools hidden (») still hide it, as before, and the
 * tools coming back bring it back.
 */
export const SIZE_ICON_SHOW_MS = 3000;

/** How far below the icon a tap still counts as "near the top", in screen pixels. */
export const SIZE_ICON_TAP_BELOW = 44;

/** A tap at `clientY` is near the top of the page: above the icon's bottom plus a finger's width. */
export function tapNearSizeIcon(clientY: number, iconBottom: number): boolean {
  return clientY <= iconBottom + SIZE_ICON_TAP_BELOW;
}

export interface SizeIconFade {
  /** Drawn at full strength; false once faded. */
  shown: boolean;
  /** Show it again and start the 3 seconds over. */
  wake: () => void;
  /** Keyboard focus is on it: hold it shown (true), or let it fade again (false; starts the 3 seconds over only
   *  if it was held, so a blur after a finger's press does not bring a faded icon back). */
  hold: (held: boolean) => void;
}

/**
 * `active`: the icon is on screen. `openKey`: the page that is open; a new one
 * (another file, another version) shows the icon again as when it opened.
 */
export function useSizeIconFade(active: boolean, openKey: string): SizeIconFade {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const wake = useCallback(() => {
    setShown(true);
    clear();
    if (held.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(false);
    }, SIZE_ICON_SHOW_MS);
  }, [clear]);

  const hold = useCallback(
    (on: boolean) => {
      const was = held.current;
      held.current = on;
      if (on || was) wake();
    },
    [wake],
  );

  useEffect(() => {
    if (!active) {
      clear();
      return;
    }
    held.current = false;
    wake();
    return clear;
  }, [active, openKey, wake, clear]);

  return { shown, wake, hold };
}
