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
 * Whether a visit opens on a clear spot: opened from the reply box's + and the canvas the board read holds something.
 * Decided from that read, never from the marks list (which may not have loaded, or failed): a canvas taken for empty
 * would open whole, and its Send would carry the whole board.
 */
export function opensOnClearSpot(fromPlus: boolean, read: readonly { id: string; isDeleted?: boolean }[]): boolean {
  return fromPlus && read.some((e) => !e.isDeleted);
}

/**
 * The pictures a Send with nothing selected gives its freehand sketches. On the whole board each sketch gets a picture
 * of its own (cut from canvas.png) when the board holds more than that one thing, so no reader has to find it among the
 * rest. On a fresh visit canvas.png is already only the new drawing, so it is the one picture: every sketch points at it.
 */
export function sketchPictures<T extends { id: string; kind: string; box: Box }>(things: readonly T[], fresh: boolean): { own: T[]; whole: string[] } {
  const sketches = things.filter((t) => t.kind === 'sketch').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  if (fresh || (things.length === 1 && sketches.length === 1)) return { own: [], whole: sketches.map((s) => s.id) };
  return { own: sketches.slice(0, 6), whole: [] };
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
