import { createContext, useContext, useEffect, useState } from 'react';

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

export const PHONE_REVIEW_LAYOUT_MEDIA_QUERY =
  `(max-width: 639px), (max-width: ${COMPACT_TOUCH_LAYOUT_MAX_WIDTH}px) and (max-height: 500px) and (pointer: coarse)`;

const CompactLayoutQuery = createContext(COMPACT_TOUCH_LAYOUT_MEDIA_QUERY);
export const CompactLayoutQueryProvider = CompactLayoutQuery.Provider;

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
 */
export function useCompactTouchLayout(override?: string): boolean {
  const inherited = useContext(CompactLayoutQuery);
  const query = override ?? inherited;
  const [isCompactTouchLayout, setIsCompactTouchLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => {
      setIsCompactTouchLayout(event.matches);
    };

    mediaQuery.addEventListener('change', onChange);
    setIsCompactTouchLayout(mediaQuery.matches);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, [query]);

  return isCompactTouchLayout;
}
