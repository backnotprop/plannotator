import {
  getScrollViewportRect,
  getScrollViewportTop,
  offsetScrollViewport,
  scrollViewportTo,
} from '../hooks/useScrollViewport';

export interface ScrollAnchor {
  blockId: string | null;
  offset: number;
  scrollTop: number;
}

function blocksIn(viewport: HTMLElement): HTMLElement[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>('[data-block-id]'));
}

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor {
  const scrollTop = getScrollViewportTop(viewport);
  const viewportTop = getScrollViewportRect(viewport).top;
  for (const block of blocksIn(viewport)) {
    const rect = block.getBoundingClientRect();
    if (rect.height <= 0 && rect.width <= 0) continue;
    if (rect.bottom > viewportTop + 1) {
      return {
        blockId: block.getAttribute('data-block-id'),
        offset: rect.top - viewportTop,
        scrollTop,
      };
    }
  }
  return { blockId: null, offset: 0, scrollTop };
}

function findBlock(viewport: HTMLElement, blockId: string): HTMLElement | null {
  for (const block of blocksIn(viewport)) {
    if (block.getAttribute('data-block-id') === blockId) return block;
  }
  return null;
}

export function scrollAnchorReady(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
  if (anchor.blockId === null) return blocksIn(viewport).length > 0 || anchor.scrollTop === 0;
  return findBlock(viewport, anchor.blockId) !== null;
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): number {
  const block = anchor.blockId === null ? null : findBlock(viewport, anchor.blockId);
  if (block) {
    const viewportTop = getScrollViewportRect(viewport).top;
    const delta = block.getBoundingClientRect().top - viewportTop - anchor.offset;
    if (Math.abs(delta) >= 1) offsetScrollViewport(viewport, delta);
  } else if (Math.abs(getScrollViewportTop(viewport) - anchor.scrollTop) >= 1) {
    scrollViewportTo(viewport, { top: anchor.scrollTop, behavior: 'auto' });
  }
  return getScrollViewportTop(viewport);
}
