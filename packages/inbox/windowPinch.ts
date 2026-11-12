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

let pending: { meta: HTMLMetaElement; original: string } | null = null;

export function releaseWindowZoom(): void {
  if (pending || !isWindowPinched()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const release = { meta, original: meta.content };
  pending = release;
  meta.content = `${release.original}, maximum-scale=1`;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      release.meta.content = release.original;
      pending = null;
    }),
  );
}
