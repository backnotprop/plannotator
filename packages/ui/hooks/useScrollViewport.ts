import { createContext, useContext, createElement, type ReactNode } from 'react';

export function isDocumentScrollViewport(
  viewport: HTMLElement | null,
): boolean {
  return viewport !== null
    && viewport.ownerDocument.scrollingElement === viewport;
}

export function getDocumentScrollViewport(
  targetDocument: Document = document,
): HTMLElement | null {
  return targetDocument.scrollingElement as HTMLElement | null;
}

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

export function getScrollViewportIntersectionRoot(
  viewport: HTMLElement,
): Element | null {
  return isDocumentScrollViewport(viewport) ? null : viewport;
}

export const ScrollViewportContext = createContext<HTMLElement | null>(null);

export function useScrollViewport(): HTMLElement | null {
  return useContext(ScrollViewportContext);
}

export function ScrollViewportProvider({
  viewport,
  children,
}: {
  viewport: HTMLElement | null;
  children: ReactNode;
}) {
  return createElement(ScrollViewportContext.Provider, { value: viewport }, children);
}
