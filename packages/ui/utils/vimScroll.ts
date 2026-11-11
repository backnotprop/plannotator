import {
  getScrollViewportRect,
  offsetScrollViewport,
} from '../hooks/useScrollViewport';

/**
 * Keyboard motion then lands the caret behind an overlay, while a mouse wheel (which the browser
 * lets overshoot) keeps the same text nearer the centre.
 */

export interface VimScrollViewportRect {
  readonly top: number;
  readonly height: number;
}

export interface VimScrollTargetRect {
  readonly top: number;
  readonly bottom: number;
}

/** The occluded strips to keep the caret out of, measured from each edge. */
export interface VimScrollBand {
  readonly topMargin: number;
  readonly bottomMargin: number;
}

/** Fraction of the viewport height reserved as a HUD band at each edge. */
export const VIM_SCROLL_MARGIN_RATIO = 0.2;
/** Lower clamp so short viewports still leave a usable margin. */
export const VIM_SCROLL_MARGIN_MIN = 24;
/** Upper clamp so tall viewports do not reserve most of the screen. */
export const VIM_SCROLL_MARGIN_MAX = 160;

/** How far to move `scrollTop` so `target` clears the HUD bands. */
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

  // Behind the bottom HUD → scroll down, but never past the point where the
  // target's top would slip under the top margin.
  if (relativeBottom > safeBottom) {
    const bottomDelta = relativeBottom - safeBottom;
    const topRoom = relativeTop - safeTop;
    return Math.min(bottomDelta, Math.max(0, topRoom));
  }

  return 0;
}

/** Resolve the ratio-based HUD margin, clamped for very short or tall viewports. */
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

/** Scroll `element` into view while keeping it clear of the Vim HUD bands. */
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

  // Mirror of the top band: keep the caret above the floating HUD by the same 8px gap.
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
