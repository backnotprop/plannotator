// Moved from the Workspaces app's `shell-motion.ts` with its contents rail
// (MarkdownContentsRail, approved 2026-10-03). Port: none.

import { useEffect, useState } from 'react';

/** Whether the reader asked for reduced motion; follows the setting live. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    // Older WebKit shims lack addEventListener on MediaQueryList.
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}
