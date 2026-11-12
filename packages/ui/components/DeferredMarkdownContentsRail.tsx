import { lazy, Suspense, useEffect, useState } from 'react';

import type { MarkdownContentsRailProps } from './MarkdownContentsRail';

const MarkdownContentsRail = lazy(() =>
  import('./MarkdownContentsRail').then((module) => ({
    default: module.MarkdownContentsRail,
  })),
);

export function scheduleMarkdownContentsRail(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

export function DeferredMarkdownContentsRail(props: MarkdownContentsRailProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => scheduleMarkdownContentsRail(() => setReady(true)), []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <MarkdownContentsRail {...props} />
    </Suspense>
  );
}
