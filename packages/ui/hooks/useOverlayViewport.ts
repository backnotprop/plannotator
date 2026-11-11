import { useCallback, useRef, useState } from 'react';

/**
 * Bridges a scroll element (delivered by `OverlayScrollArea`'s `onViewportReady`, now a native
 * scroll node) into React state and a ref at the same time.
 */
export function useOverlayViewport<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [viewport, setViewport] = useState<T | null>(null);

  const onViewportReady = useCallback((next: HTMLElement | null) => {
    const el = next as T | null;
    ref.current = el;
    setViewport(el);
  }, []);

  return { ref, viewport, onViewportReady };
}
