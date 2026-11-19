/**
 * What to draw. Two decisions, both made from the camera:
 *
 * - **Culling.** Only objects near the view are mounted. "Near" is the view
 *   grown by `OVERSCAN` of its size on every side: the render window. While
 *   the view stays inside the window nothing is recomputed, so most frames
 *   of a pan cost one CSS transform and no React work at all.
 * - **Level of detail.** Zoomed far out, text is unreadable and the screen
 *   holds the most objects, so the renderer draws less of each: see `Lod`.
 */
import { type Rect, rectContainsRect } from '../model/geometry';
import type { CanvasDocument, ObjectId } from '../model/types';
import { type Camera, type Size, viewportRect } from './camera';
import type { DocumentIndex } from './document-index';

/** How much of the view's size the render window adds on each side. */
export const OVERSCAN = 0.5;

/**
 * - `full`: everything.
 * - `plain`: no shadows, no second line of a box, no embedded HTML or
 *   playing sprite (text is about 5 px tall here).
 * - `far`: shapes only. No text at all.
 */
export type Lod = 'full' | 'plain' | 'far';

export const LOD_PLAIN_BELOW = 0.45;
export const LOD_FAR_BELOW = 0.2;

export const lodForZoom = (z: number): Lod => (z < LOD_FAR_BELOW ? 'far' : z < LOD_PLAIN_BELOW ? 'plain' : 'full');

export function renderWindow(camera: Camera, size: Size, overscan = OVERSCAN): Rect {
  const view = viewportRect(camera, size);
  const padX = view.w * overscan;
  const padY = view.h * overscan;
  return { x: view.x - padX, y: view.y - padY, w: view.w + padX * 2, h: view.h + padY * 2 };
}

/**
 * Whether the mounted set must be recomputed: the view has left the window
 * it was computed for, or has zoomed in so far that the window now mounts
 * much more than the view needs.
 */
export function windowIsStale(window: Rect | null, camera: Camera, size: Size, overscan = OVERSCAN): boolean {
  if (!window) return true;
  const view = viewportRect(camera, size);
  if (!rectContainsRect(window, view)) return true;
  return window.w > view.w * (1 + overscan * 2) * 2;
}

/** Ids of the objects to mount for `area`, back to front. */
export function visibleIds(doc: CanvasDocument, index: DocumentIndex, area: Rect): ObjectId[] {
  const order = index.order(doc);
  return index.spatial
    .query(area)
    .filter((id) => doc.objects[id])
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
