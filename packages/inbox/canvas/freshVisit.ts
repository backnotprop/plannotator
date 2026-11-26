/**
 * A visit to a canvas that already holds something, opened from the reply box's + → Canvas: the view opens on a clear
 * spot beside the drawing, and the bar's Send carries only what was drawn on this visit (CanvasBoard.tsx `fresh`).
 * The thread header's canvas button opens the whole board as before.
 */
import type { Box } from '@plannotator/shared/inbox/canvas/scene';

/** How far right of the drawing the clear spot's left edge is, and how far below its top the view starts. */
export const CLEAR_SPOT_GAP = 240;
export const CLEAR_SPOT_TOP = 80;

/**
 * What was drawn on this visit: each element shown now whose id the board did not hold when it opened, nor took from
 * the Inbox since (an agent's addition while the person draws is not theirs), nor sent already on this visit.
 */
export function drawnThisVisit<E extends { id: string; isDeleted?: boolean }>(elements: readonly E[], known: ReadonlySet<string>): E[] {
  return elements.filter((e) => !e.isDeleted && !known.has(e.id));
}

/**
 * The view (Excalidraw's `scrollX`, `scrollY` at zoom 1) that puts its top-left corner a gap right of everything on
 * the board, level with the drawing's top: an empty place, with the drawing a pan away. Null for an empty board.
 */
export function clearSpotView(drawing: Box | null): { scrollX: number; scrollY: number } | null {
  if (!drawing || (drawing.w <= 0 && drawing.h <= 0)) return null;
  // On screen, x = (sceneX + scrollX) * zoom: the drawing's right edge plus the gap lands at the view's left edge.
  return { scrollX: -(drawing.x + drawing.w + CLEAR_SPOT_GAP), scrollY: -drawing.y + CLEAR_SPOT_TOP };
}
