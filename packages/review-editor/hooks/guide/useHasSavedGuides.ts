import { useEffect, useState } from 'react';

/**
 * Whether this repo has saved guides (`GET /api/guides`), asked only while
 * `enabled`. With AI features off the Guide button stays for them: the saved
 * guides are still served, and the person can still read them.
 */
export function useHasSavedGuides(enabled: boolean): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch('/api/guides')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (alive) setHas(Array.isArray(data) && data.length > 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return has;
}
