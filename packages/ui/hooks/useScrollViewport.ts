import { createContext, useContext, createElement, type ReactNode } from 'react';

/** Return whether this element is the browser's page-scrolling element. */
export function isDocumentScrollViewport(
  viewport: HTMLElement | null,
): boolean {
  return viewport !== null
    && viewport.ownerDocument.scrollingElement === viewport;
}

/** Resolve the document scroller without assuming whether WebKit chose html or body. */
export function getDocumentScrollViewport(
  targetDocument: Document = document,
): HTMLElement | null {
  return targetDocument.scrollingElement as HTMLElement | null;
}

/**
 * Page scrolling needs viewport geometry, not the document element's full
 * content rect. Element-backed scroll areas retain their incumbent geometry.
 */
export function getScrollViewportRect(viewport: HTMLElement): DOMRect {
  if (!isDocumentScrollViewport(viewport)) return viewport.getBoundingClientRect();

  const targetWindow = viewport.ownerDocument.defaultView;
  const visualViewport = targetWindow?.visualViewport;
  const left = visualViewport?.offsetLeft ?? 0;
  const top = visualViewport?.offsetTop ?? 0;
  const width = visualViewport?.width ?? targetWindow?.innerWidth ?? viewport.clientWidth;
  const height = visualViewport?.height ?? targetWindow?.innerHeight ?? viewport.clientHeight;
  const DOMRectConstructor = targetWindow?.DOMRect ?? DOMRect;
  return new DOMRectConstructor(left, top, width, height);
}

export function getScrollViewportTop(viewport: HTMLElement): number {
  if (!isDocumentScrollViewport(viewport)) return viewport.scrollTop;
  return viewport.ownerDocument.defaultView?.scrollY ?? viewport.scrollTop;
}

export function scrollViewportTo(
  viewport: HTMLElement,
  options: ScrollToOptions,
): void {
  if (!isDocumentScrollViewport(viewport)) {
    viewport.scrollTo(options);
    return;
  }
  viewport.ownerDocument.defaultView?.scrollTo(options);
}

export function offsetScrollViewport(viewport: HTMLElement, delta: number): void {
  if (!isDocumentScrollViewport(viewport)) {
    viewport.scrollTop += delta;
    return;
  }
  viewport.ownerDocument.defaultView?.scrollBy({ top: delta, behavior: 'auto' });
}

export function addScrollViewportListener(
  viewport: HTMLElement,
  listener: EventListener,
): () => void {
  const target: EventTarget = isDocumentScrollViewport(viewport)
    ? viewport.ownerDocument.defaultView ?? viewport
    : viewport;
  target.addEventListener('scroll', listener, { passive: true });
  return () => target.removeEventListener('scroll', listener);
}

/** A document scroll uses the browser viewport as its IntersectionObserver root. */
export function getScrollViewportIntersectionRoot(
  viewport: HTMLElement,
): Element | null {
  return isDocumentScrollViewport(viewport) ? null : viewport;
}

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
