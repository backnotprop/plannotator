/**
 * Where the selection toolbar (`components/AnnotationToolbar`) sits on a touch
 * screen, for hosts that opt in with
 * `configurePlannotatorUI({ touchSelectionToolbar: true })`.
 *
 * Docked, never next to the selection: iOS Safari draws its own edit menu
 * (Copy, Find Selection, Look Up) beside a text selection, above or below it,
 * and which side it takes cannot be predicted from the page. A page cannot
 * turn that menu off either. So the toolbar docks to the bottom edge of the
 * visible screen, centered, away from wherever iOS's menu goes. When the
 * selection itself reaches into the bottom of the screen (where the docked
 * toolbar would cover it, and where iOS's menu would then sit), it docks to
 * the top edge instead.
 *
 * The visible screen is the visual viewport (keyboard, browser bars and pinch
 * zoom taken into account), less a margin and the device's safe-area insets.
 * While the selection is scrolled out of sight the toolbar is hidden.
 *
 * Default: off, so a host that does not opt in (Workspaces) keeps the
 * toolbar's desktop placement everywhere, exactly as before. Plannotator's
 * plan review, annotate, code review and Inbox pass true. With it on, nothing
 * changes where the main pointer is a mouse or trackpad.
 */

import {
  calculateViewportEnvironment,
  calculateVisibleViewportBounds,
  type ViewportEdgeInsets,
} from '../hooks/useViewportEnvironment';

let touchSelectionToolbar = false;

export function setTouchSelectionToolbar(on: boolean): void {
  touchSelectionToolbar = on;
}

export function resetTouchSelectionToolbar(): void {
  touchSelectionToolbar = false;
}

export function getTouchSelectionToolbar(): boolean {
  return touchSelectionToolbar;
}

/** Space kept between the toolbar and every edge of the visible screen (inside the safe area). */
export const TOUCH_TOOLBAR_EDGE_MARGIN = 8;
/**
 * A selection reaching into this band at the bottom of the visible screen
 * docks the toolbar to the top edge instead: the docked toolbar (about 62px
 * with its margin) and iOS's menu beside the selection would both be there.
 */
export const TOUCH_TOOLBAR_BOTTOM_BAND = 120;
/** Size used before the toolbar has rendered once and can be measured. */
export const TOUCH_TOOLBAR_SIZE_ESTIMATE = { width: 280, height: 54 };

export interface ToolbarRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ToolbarViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TouchToolbarPlacement = 'dock-bottom' | 'dock-top' | 'above' | 'hidden';

export interface TouchToolbarPosition {
  /** Top edge of the toolbar, in the same (layout viewport) coordinates as `anchor`. */
  top: number;
  /** Left edge of the toolbar (no centering transform). */
  left: number;
  /** The widest the toolbar may be: the visible screen less margins and insets. */
  maxWidth: number;
  placement: TouchToolbarPlacement;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The smallest rect holding every piece of a selection (a selection split into marks). */
export function unionToolbarRect(rects: readonly ToolbarRect[]): ToolbarRect | null {
  let out: ToolbarRect | null = null;
  for (const r of rects) {
    if (!(r.right > r.left || r.bottom > r.top)) continue; // an empty piece
    out = out
      ? { top: Math.min(out.top, r.top), bottom: Math.max(out.bottom, r.bottom), left: Math.min(out.left, r.left), right: Math.max(out.right, r.right) }
      : { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }
  return out;
}

/**
 * Pure: the toolbar's top-left corner for one reading of the anchor (the
 * WHOLE selection), the toolbar's own size and the visible screen.
 * `center-above` (a text selection) docks centered to the bottom edge, or to
 * the top edge when the selection reaches into the bottom band; `top-right`
 * (a hovered block, no native menu) keeps its right-aligned place over the
 * block. Both stay inside the screen with `margin` plus `insets` on each
 * side. An anchor entirely out of the visible screen gives `hidden`.
 */
export function placeTouchToolbar(input: {
  anchor: ToolbarRect;
  toolbar: { width: number; height: number };
  viewport: ToolbarViewport;
  mode: 'center-above' | 'top-right';
  margin?: number;
  insets?: Partial<ViewportEdgeInsets>;
}): TouchToolbarPosition {
  const { anchor, toolbar, viewport, mode } = input;
  const margin = input.margin ?? TOUCH_TOOLBAR_EDGE_MARGIN;
  const bounds = calculateVisibleViewportBounds(
    { width: viewport.width, height: viewport.height, offsetTop: viewport.top, offsetLeft: viewport.left, keyboardInset: 0 },
    margin,
    input.insets,
  );

  const minLeft = bounds.left;
  const maxLeft = bounds.right - toolbar.width;
  const idealLeft = mode === 'center-above'
    ? bounds.left + (bounds.width - toolbar.width) / 2
    : anchor.right - toolbar.width;
  const left = maxLeft < minLeft ? minLeft : clamp(idealLeft, minLeft, maxLeft);
  const minTop = bounds.top;
  const maxTop = Math.max(minTop, bounds.bottom - toolbar.height);
  const base = { left, maxWidth: bounds.width };

  const viewportBottom = viewport.top + viewport.height;
  const offscreen = anchor.bottom <= viewport.top
    || anchor.top >= viewportBottom
    || anchor.right <= viewport.left
    || anchor.left >= viewport.left + viewport.width;
  if (offscreen) return { ...base, top: minTop, placement: 'hidden' };

  if (mode === 'top-right') {
    return { ...base, top: clamp(anchor.top - toolbar.height - 4, minTop, maxTop), placement: 'above' };
  }

  if (anchor.bottom > viewportBottom - TOUCH_TOOLBAR_BOTTOM_BAND) {
    return { ...base, top: minTop, placement: 'dock-top' };
  }
  return { ...base, top: maxTop, placement: 'dock-bottom' };
}

/**
 * The visible part of the page, in the coordinates `position: fixed` uses:
 * the visual viewport (the keyboard and browser bars taken out, as
 * `useViewportEnvironment` reads it). Pinch-zoomed, the visible part is the
 * zoomed visual viewport itself.
 */
export function readVisibleViewport(): ToolbarViewport {
  const vv = window.visualViewport;
  const env = calculateViewportEnvironment({
    layoutWidth: window.innerWidth,
    layoutHeight: window.innerHeight,
    visualViewport: vv
      ? { width: vv.width, height: vv.height, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft, scale: vv.scale }
      : null,
  });
  const zoomed = !!vv && Math.abs(vv.scale - 1) > 0.01 && vv.width > 0 && vv.height > 0;
  return {
    left: env.offsetLeft,
    top: env.offsetTop,
    width: zoomed ? vv!.width : env.width,
    height: zoomed ? vv!.height : env.height,
  };
}

let insetCache: { key: string; insets: ViewportEdgeInsets } | null = null;

/** Insets change with the device's orientation, not with pinch zoom (which resizes the window's inner size). */
function insetCacheKey(): string {
  const landscape = typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape)').matches;
  return `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}:${landscape ? 'l' : 'p'}`;
}

/**
 * The device's safe-area insets (notch, rounded corners, home indicator),
 * read once per orientation through a hidden probe: env() is only readable
 * from CSS. Zero where the browser has none.
 */
export function readSafeAreaInsets(): ViewportEdgeInsets {
  const key = insetCacheKey();
  if (insetCache?.key === key) return insetCache.insets;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const px = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const insets = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  probe.remove();
  insetCache = { key, insets };
  return insets;
}
