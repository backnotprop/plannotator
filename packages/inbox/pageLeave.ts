/**
 * The page hiding or going: a closed tab, a reload, a phone switching apps. Words still waiting for their typing pause
 * are saved then with a keepalive request, so they outlive the page (the thread's answer cards, decision mode).
 */
import { useEffect, useRef } from 'react';

/** Runs `onLeave` each time the page hides or goes (`pagehide`, or the tab turning hidden). */
export function usePageLeave(onLeave: () => void): void {
  const latest = useRef(onLeave);
  latest.current = onLeave;
  useEffect(() => {
    const onHide = () => latest.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
