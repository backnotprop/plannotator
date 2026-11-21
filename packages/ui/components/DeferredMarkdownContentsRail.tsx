// Moved from the Workspaces app's DeferredMarkdownContentsRail with its
// contents rail (MarkdownContentsRail, approved 2026-10-03). Port: the props
// are the rail's own (`MarkdownContentsRailProps`), passed through.

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

/** Load the reading aid after the document is interactive, never in the
 * critical document-paint path. The timeout still guarantees it appears on
 * a busy page; Safari and tests use the zero-delay fallback. */
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
