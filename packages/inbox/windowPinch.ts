/** Pinch over an HTML page on a phone zooms the whole window. The only lever to undo it is the viewport meta: `maximum-scale` 1 clamps the zoom in browsers that honor it (Chromium), then the meta goes back. iOS Safari lets people zoom past it on purpose, so there it does nothing. */

import { useCallback, useSyncExternalStore } from 'react';

export const PINCH_TUCK_SCALE = 1.05;

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener('resize', onChange);
  viewport.addEventListener('scroll', onChange);
  return () => {
    viewport.removeEventListener('resize', onChange);
    viewport.removeEventListener('scroll', onChange);
  };
}

export function isWindowPinched(): boolean {
  return (window.visualViewport?.scale ?? 1) > PINCH_TUCK_SCALE;
}

const never = () => () => {};

export function useWindowPinched(enabled: boolean): boolean {
  const read = useCallback(() => enabled && isWindowPinched(), [enabled]);
  return useSyncExternalStore(enabled ? subscribe : never, read, () => false);
}

/** A release whose two frames have not run yet: the tag as it was before the clamp. */
let pending: { meta: HTMLMetaElement; original: string } | null = null;

/** A second call while one is pending does nothing: it would read the clamped tag as the original and keep pinch off. */
export function releaseWindowZoom(): void {
  if (pending || !isWindowPinched()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const release = { meta, original: meta.content };
  pending = release;
  meta.content = `${release.original}, maximum-scale=1`;
  // Two frames: the browser reads the clamp at its next layout, and pinch comes back right after.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      release.meta.content = release.original;
      pending = null;
    }),
  );
}
