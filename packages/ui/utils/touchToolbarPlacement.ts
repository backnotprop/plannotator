/**
 * Where the selection toolbar (`components/AnnotationToolbar`) sits on a touch
 * screen, for hosts that opt in with
 * `configurePlannotatorUI({ touchSelectionToolbar: true })`.
 *
 * Why below: iOS Safari draws its own edit menu (Copy, Find Selection, Look
 * Up) above a text selection, and a page cannot turn that menu off for
 * selected text. It goes below only when there is no room above. A toolbar
 * above the selection is covered by it; one below the selection is not. The
 * gap below leaves room for the end selection handle, which hangs under the
 * last line.
 *
 * The toolbar always stays inside the visible screen, with a margin on every
 * side; it flips above the selection only when there is no room below, and
 * when neither fits (a selection taller than the screen) it rests at the
 * bottom edge.
 *
 * Default: off, so a host that does not opt in (Workspaces) keeps the
 * toolbar's desktop placement everywhere, exactly as before. Plannotator's
 * plan review, annotate, code review and Inbox pass true. With it on, nothing
 * changes where the main pointer is a mouse or trackpad.
 */

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

/** Space kept between the toolbar and every edge of the visible screen. */
export const TOUCH_TOOLBAR_EDGE_MARGIN = 8;
/** Space under the selection: clears iOS's end selection handle. */
export const TOUCH_TOOLBAR_GAP_BELOW = 20;
/** Space over the selection when the toolbar has to flip above it. */
export const TOUCH_TOOLBAR_GAP_ABOVE = 8;
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

export type TouchToolbarPlacement = 'below' | 'above' | 'pinned';

export interface TouchToolbarPosition {
  /** Top edge of the toolbar, in the same (layout viewport) coordinates as `anchor`. */
  top: number;
  /** Left edge of the toolbar (no centering transform). */
  left: number;
  placement: TouchToolbarPlacement;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Pure: the toolbar's top-left corner for one reading of the anchor, the
 * toolbar's own size and the visible screen. `center-above` (a text
 * selection) goes centered under the anchor; `top-right` (a hovered block)
 * keeps its right-aligned place over the block. Both are kept inside the
 * screen with `margin` on each side; a toolbar wider than the screen starts
 * at the left margin.
 */
export function placeTouchToolbar(input: {
  anchor: ToolbarRect;
  toolbar: { width: number; height: number };
  viewport: ToolbarViewport;
  mode: 'center-above' | 'top-right';
  margin?: number;
}): TouchToolbarPosition {
  const { anchor, toolbar, viewport, mode } = input;
  const margin = input.margin ?? TOUCH_TOOLBAR_EDGE_MARGIN;

  const minLeft = viewport.left + margin;
  const maxLeft = viewport.left + viewport.width - margin - toolbar.width;
  const idealLeft = mode === 'center-above'
    ? (anchor.left + anchor.right) / 2 - toolbar.width / 2
    : anchor.right - toolbar.width;
  const left = maxLeft < minLeft ? minLeft : clamp(idealLeft, minLeft, maxLeft);

  const minTop = viewport.top + margin;
  const maxTop = Math.max(minTop, viewport.top + viewport.height - margin - toolbar.height);

  if (mode === 'top-right') {
    // A hovered block, not a selection: no native menu to avoid.
    return { top: clamp(anchor.top - toolbar.height - 4, minTop, maxTop), left, placement: 'above' };
  }

  const below = anchor.bottom + TOUCH_TOOLBAR_GAP_BELOW;
  if (below <= maxTop) {
    // Selection scrolled up past the top edge: keep the toolbar on screen.
    return { top: Math.max(below, minTop), left, placement: 'below' };
  }
  const above = anchor.top - TOUCH_TOOLBAR_GAP_ABOVE - toolbar.height;
  if (above >= minTop) {
    return { top: Math.min(above, maxTop), left, placement: 'above' };
  }
  return { top: maxTop, left, placement: 'pinned' };
}

/** The visible part of the page, in the coordinates `position: fixed` uses. */
export function readVisibleViewport(): ToolbarViewport {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv && vv.width > 0 && vv.height > 0) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
  }
  const width = document.documentElement?.clientWidth || window.innerWidth;
  return { left: 0, top: 0, width, height: window.innerHeight };
}
