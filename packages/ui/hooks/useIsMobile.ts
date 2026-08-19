import { useState, useEffect } from 'react';

/** Maximum CSS viewport width that can enter Plannotator's compact touch shell. */
export const COMPACT_TOUCH_LAYOUT_MAX_WIDTH = 1024;

/**
 * Canonical media query for the compact application shell.
 *
 * The primary pointer is intentional: `any-pointer: coarse` also matches
 * touchscreen laptops whose primary mouse or trackpad needs the desktop shell.
 */
export const COMPACT_TOUCH_LAYOUT_MEDIA_QUERY =
  `(max-width: ${COMPACT_TOUCH_LAYOUT_MAX_WIDTH}px) and (pointer: coarse)`;

export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpoint]);

  return isMobile;
}

/**
 * Reports whether the current viewport needs Plannotator's compact touch shell.
 * Plan and Code Review must share this decision so responsive chrome and scroll
 * ownership cannot diverge on hybrid devices.
 */
export function useCompactTouchLayout(): boolean {
  const [isCompactTouchLayout, setIsCompactTouchLayout] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia(COMPACT_TOUCH_LAYOUT_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_TOUCH_LAYOUT_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setIsCompactTouchLayout(event.matches);
    };

    mediaQuery.addEventListener('change', onChange);
    setIsCompactTouchLayout(mediaQuery.matches);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  return isCompactTouchLayout;
}
