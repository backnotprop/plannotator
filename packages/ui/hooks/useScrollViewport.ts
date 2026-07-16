import { createContext, useContext, createElement, type ReactNode } from 'react';

/**
 * Provides the currently-active scroll viewport element to descendants.
 *
 * The element that actually scrolls is the host element rendered by
 * <OverlayScrollArea> (native scroll) — not <main>. Any code that needs the
 * scroll container (IntersectionObserver roots, scroll event listeners,
 * scrollTo / getBoundingClientRect offsets) must consume this context instead
 * of `document.querySelector('main')`.
 *
 * The value is `null` until the scroll element has mounted. Consumers should
 * handle that transient state.
 */
export const ScrollViewportContext = createContext<HTMLElement | null>(null);

/** Returns the active scroll viewport element, or `null` before it mounts. */
export function useScrollViewport(): HTMLElement | null {
  return useContext(ScrollViewportContext);
}

/**
 * Render-transparent provider for the active scroll viewport element.
 *
 * The host mounts this around its layout and feeds it the MAIN content's scroll
 * element, so descendants — including a sidebar Table-of-Contents rendered
 * inside it — resolve to the main viewport (not the sidebar's own scroll area).
 * Ships with the package so consumers work without app-shell wiring.
 */
export function ScrollViewportProvider({
  viewport,
  children,
}: {
  viewport: HTMLElement | null;
  children: ReactNode;
}) {
  return createElement(ScrollViewportContext.Provider, { value: viewport }, children);
}
