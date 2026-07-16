import { useCallback, useRef, useState } from 'react';

/**
 * Bridges a scroll element (delivered by `OverlayScrollArea`'s `onViewportReady`,
 * now a native scroll node) into React state and a ref at the same time, for
 * components that need to both:
 *
 *   1. Re-run effects when the viewport becomes available (state), and
 *   2. Access the viewport imperatively without re-rendering (ref).
 *
 * Usage:
 *
 *   const { ref, viewport, onViewportReady } = useOverlayViewport();
 *   // ...
 *   <OverlayScrollArea onViewportReady={onViewportReady}> ... </OverlayScrollArea>
 *
 * Then use `ref.current` inside event handlers / imperative assignments
 * (`ref.current.scrollTop = ...`), and include `viewport` in effect deps so
 * the effect re-runs once the library has attached its viewport div.
 *
 * Without this hook, components that only use a ref silently no-op on first
 * render because the ref is populated after mount and nothing retriggers
 * dependent effects.
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
