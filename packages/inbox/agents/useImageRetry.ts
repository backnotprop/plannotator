import { useEffect, useState } from 'react';

/** When a picture that did not load is tried again: the link back, else after 2, 8 and 30 s. */
const RETRY_MS = [2_000, 8_000, 30_000];

/**
 * A picture mark's "did not load" (an uploaded picture, a set's icon): shown as the agent's own mark meanwhile, then
 * tried again, so a picture asked for on a dropped link (a hand-back heard just before the drop) comes back by itself.
 * A picture that is really gone fails each try and stays the agent's own mark.
 */
export function useImageRetry(): [failed: boolean, fail: () => void] {
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!failed || tries >= RETRY_MS.length) return;
    const again = () => {
      setTries((n) => n + 1);
      setFailed(false);
    };
    const timer = setTimeout(again, RETRY_MS[tries]);
    window.addEventListener('online', again);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', again);
    };
  }, [failed, tries]);
  return [failed, () => setFailed(true)];
}
