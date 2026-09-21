import {
  getScrollViewportRect,
  offsetScrollViewport,
} from '../hooks/useScrollViewport';

/**
 * Keep the Vim cursor clear of the HUD bands that hug the viewport edges.
 *
 * `Element.scrollIntoView({ block: 'nearest' })` parks a target flush against
 * the nearest viewport edge — exactly where the sticky action bar (top) and the
 * key HUD / status pill (bottom) float. Keyboard motion then lands the caret
 * behind an overlay, while a mouse wheel (which the browser lets overshoot)
 * keeps the same text nearer the centre. These helpers reproduce that mouse
 * feel: a target inside the safe band never scrolls, and one that strays into a
 * HUD band is revealed with a margin instead of being pinned to the edge.
 */

/** A viewport's vertical geometry, relative to the page. */
export interface VimScrollViewportRect {
  readonly top: number;
  readonly height: number;
}

/** A target's vertical extent, relative to the page. */
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

/**
 * How far to move `scrollTop` so `target` clears the HUD bands.
 *
 * Returns a signed delta (negative scrolls up, positive scrolls down) or `0`
 * when the target already sits inside the safe band. A target taller than the
 * band is aligned to its top edge — reading order wins, so the start of the
 * block is never pushed above the top margin to chase its bottom.
 */
export function computeVimScrollDelta(
  viewport: VimScrollViewportRect,
  target: VimScrollTargetRect,
  band: VimScrollBand,
): number {
  const relativeTop = target.top - viewport.top;
  const relativeBottom = target.bottom - viewport.top;
  const safeTop = band.topMargin;
  const safeBottom = viewport.height - band.bottomMargin;

  // Behind the top HUD → scroll up just enough to reach the top margin.
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

/**
 * Top edge of the lowest floating Vim HUD, or `undefined` when none is shown.
 *
 * The key HUD and the mode badge are portaled to `document.body`, outside the
 * scroll viewport's subtree, so the query is necessarily document-wide. It is
 * still scoped to `element.ownerDocument` (never the global `document`) so a
 * host mounted inside another document measures its own HUD, and because both
 * widgets are fixed-position singletons, a host mounting two viewers in one
 * document gets the same band geometry from either instance.
 *
 * The expanded key HUD is deliberately skipped: it is a modal state that can
 * stand taller than the viewport, so no band could clear it — scrolling keeps
 * the ratio margin until the user collapses it.
 */
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

/**
 * Scroll `element` into view while keeping it clear of the Vim HUD bands.
 *
 * `scrollViewport` is the element that actually scrolls — the caller passes the
 * value it already holds from ScrollViewportContext (the same node the reticle
 * measures against), because the native-scroll host carries no attribute that
 * would rediscover it. When it is absent the helper falls back to the
 * historical `scrollIntoView({ block: 'nearest' })`, so behaviour never
 * regresses.
 *
 * Both bands are measured from live geometry rather than guessed constants:
 * the top band clears the sticky action bar when present, and the bottom band
 * clears the floating key HUD / mode pill, so the caret is never parked behind
 * either overlay — and the default pill configuration no longer reserves the
 * full ratio band for a 25px widget.
 */
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

  // Mirror of the top band: keep the caret above the floating HUD by the same
  // 8px gap. The HUD rect wins over the ratio band whenever it is larger (the
  // key HUD needs ~238px, well past the 160px clamp) and is allowed to shrink
  // past it when only the small mode pill floats (floor: the minimum margin).
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
