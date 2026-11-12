import { useState, useEffect } from 'react';

export const COMPACT_TOUCH_LAYOUT_MAX_WIDTH = 1024;

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
