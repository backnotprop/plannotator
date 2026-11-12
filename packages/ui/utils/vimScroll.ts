import {
  getScrollViewportRect,
  offsetScrollViewport,
} from '../hooks/useScrollViewport';

export interface VimScrollViewportRect {
  readonly top: number;
  readonly height: number;
}

export interface VimScrollTargetRect {
  readonly top: number;
  readonly bottom: number;
}

export interface VimScrollBand {
  readonly topMargin: number;
  readonly bottomMargin: number;
}

export const VIM_SCROLL_MARGIN_RATIO = 0.2;
export const VIM_SCROLL_MARGIN_MIN = 24;
export const VIM_SCROLL_MARGIN_MAX = 160;

export function computeVimScrollDelta(
  viewport: VimScrollViewportRect,
  target: VimScrollTargetRect,
  band: VimScrollBand,
): number {
  const relativeTop = target.top - viewport.top;
  const relativeBottom = target.bottom - viewport.top;
  const safeTop = band.topMargin;
  const safeBottom = viewport.height - band.bottomMargin;

  if (relativeTop < safeTop) return relativeTop - safeTop;

  if (relativeBottom > safeBottom) {
    const bottomDelta = relativeBottom - safeBottom;
    const topRoom = relativeTop - safeTop;
    return Math.min(bottomDelta, Math.max(0, topRoom));
  }

  return 0;
}

export function resolveVimScrollMargin(viewportHeight: number): number {
  return Math.min(
    Math.max(viewportHeight * VIM_SCROLL_MARGIN_RATIO, VIM_SCROLL_MARGIN_MIN),
    VIM_SCROLL_MARGIN_MAX,
  );
}

function vimHudBandTop(element: HTMLElement): number | undefined {
  const doc = element.ownerDocument;
  const keyHud = doc.querySelector<HTMLElement>('[data-vim-key-hud]');
  const badge = doc.querySelector<HTMLElement>('[data-vim-mode-badge]');
  const tops: number[] = [];
  if (keyHud && keyHud.getAttribute('data-expanded') !== 'true') {
    const rect = keyHud.getBoundingClientRect();
    if (rect.height > 0) tops.push(rect.top);
  }
  if (badge) {
    const rect = badge.getBoundingClientRect();
    if (rect.height > 0) tops.push(rect.top);
  }
  return tops.length > 0 ? Math.min(...tops) : undefined;
}

export function scrollVimTargetIntoView(
  element: HTMLElement,
  scrollViewport?: HTMLElement | null,
): void {
  const viewport = scrollViewport ?? null;
  if (!viewport) {
    element.scrollIntoView({ block: 'nearest' });
    return;
  }

  const viewportRect = getScrollViewportRect(viewport);
  const targetRect = element.getBoundingClientRect();
  if (targetRect.height === 0 && targetRect.width === 0) return;

  const margin = resolveVimScrollMargin(viewportRect.height);
  const stickyBottom = viewport
    .querySelector<HTMLElement>('[data-viewer-document-header], [data-sticky-actions]')
    ?.getBoundingClientRect().bottom;
  const topMargin = stickyBottom !== undefined
    ? Math.max(margin, stickyBottom - viewportRect.top + 8)
    : margin;

  const hudTop = vimHudBandTop(element);
  const bottomMargin = hudTop !== undefined
    ? Math.max(VIM_SCROLL_MARGIN_MIN, viewportRect.bottom - hudTop + 8)
    : margin;

  const delta = computeVimScrollDelta(
    { top: viewportRect.top, height: viewportRect.height },
    { top: targetRect.top, bottom: targetRect.bottom },
    { topMargin, bottomMargin },
  );
  if (delta === 0) return;
  offsetScrollViewport(viewport, delta);
}
