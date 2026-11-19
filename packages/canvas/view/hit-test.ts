/**
 * What is under a point, and what is inside a rectangle. Both ask the
 * spatial index first, so neither looks at the whole canvas.
 */
import { resolveArrow } from '../model/document';
import {
  type Point,
  type Rect,
  distanceToSegment,
  rectContainsPoint,
  rectContainsRect,
  rectsIntersect,
} from '../model/geometry';
import { type CanvasDocument, type CanvasObject, type ObjectId, isPlaced } from '../model/types';
import type { DocumentIndex } from './document-index';

/** How far inside a frame's edge still grabs the frame, in world units at zoom 1. */
export const FRAME_GRAB_BAND = 10;
/** The strip above a frame that holds its title, in world units at zoom 1. */
export const FRAME_TITLE_HEIGHT = 24;

function hits(doc: CanvasDocument, object: CanvasObject, p: Point, tolerance: number): boolean {
  if (object.type === 'arrow') {
    const geometry = resolveArrow(doc, object);
    return !!geometry && distanceToSegment(p, geometry.from, geometry.to) <= tolerance;
  }
  if (!isPlaced(object)) return false;
  if (object.type === 'frame') {
    // A frame is grabbed by its edge or its title. Its inside is open board,
    // so a drag there draws a marquee instead of carrying the frame away.
    const band = Math.max(FRAME_GRAB_BAND, tolerance);
    const title = { x: object.x, y: object.y - Math.max(FRAME_TITLE_HEIGHT, tolerance * 2), w: object.w, h: Math.max(FRAME_TITLE_HEIGHT, tolerance * 2) };
    if (rectContainsPoint(title, p)) return true;
    const outer = { x: object.x - tolerance, y: object.y - tolerance, w: object.w + tolerance * 2, h: object.h + tolerance * 2 };
    if (!rectContainsPoint(outer, p)) return false;
    const inner = { x: object.x + band, y: object.y + band, w: object.w - band * 2, h: object.h - band * 2 };
    return inner.w <= 0 || inner.h <= 0 || !rectContainsPoint(inner, p);
  }
  return rectContainsPoint(object, p);
}

/**
 * The topmost object at a world point, or null. Arrows are drawn above
 * everything else, so an arrow wins over what it crosses; among the rest the
 * drawing order decides. `tolerance` is how near counts (world units): pass
 * a few screen pixels divided by the zoom.
 */
export function hitTest(doc: CanvasDocument, index: DocumentIndex, p: Point, tolerance = 4): ObjectId | null {
  const reach = Math.max(tolerance, FRAME_TITLE_HEIGHT);
  const candidates = index.spatial.query({ x: p.x - reach, y: p.y - reach * 2, w: reach * 2, h: reach * 3 });
  const order = index.order(doc);
  let best: ObjectId | null = null;
  let bestRank = -1;
  for (const id of candidates) {
    const object = doc.objects[id];
    if (!object || !hits(doc, object, p, tolerance)) continue;
    const rank = (order.get(id) ?? 0) + (object.type === 'arrow' ? doc.order.length : 0);
    if (rank > bestRank) {
      bestRank = rank;
      best = id;
    }
  }
  return best;
}

/**
 * What a marquee takes: every object it touches, except that a frame or an
 * arrow must be wholly inside (a marquee drawn inside a frame should not
 * pick the frame up, and a long arrow's empty box should not catch).
 */
export function objectsInRect(doc: CanvasDocument, index: DocumentIndex, area: Rect): ObjectId[] {
  const order = index.order(doc);
  const out: ObjectId[] = [];
  for (const id of index.spatial.query(area)) {
    const object = doc.objects[id];
    if (!object) continue;
    if (object.type === 'arrow') {
      const geometry = resolveArrow(doc, object);
      if (geometry && rectContainsPoint(area, geometry.from) && rectContainsPoint(area, geometry.to)) out.push(id);
    } else if (isPlaced(object)) {
      if (object.type === 'frame' ? rectContainsRect(area, object) : rectsIntersect(area, object)) out.push(id);
    }
  }
  return out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * What goes along when these objects are dragged: everything wholly inside
 * a dragged frame. Decided once, when the drag starts, so a frame passing
 * over other objects does not sweep them up.
 */
export function withFrameContents(doc: CanvasDocument, index: DocumentIndex, ids: readonly ObjectId[]): ObjectId[] {
  const out = new Set(ids);
  for (const id of ids) {
    const frame = doc.objects[id];
    if (!frame || frame.type !== 'frame') continue;
    for (const inside of index.spatial.query(frame)) {
      const object = doc.objects[inside];
      if (!object || inside === id) continue;
      const bounds = index.spatial.rectOf(inside);
      if (object.type !== 'arrow' && bounds && rectContainsRect(frame, bounds)) out.add(inside);
    }
  }
  // An arrow goes too when both of its ends do.
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'arrow' || out.has(object.id)) continue;
    const from = 'object' in object.from ? out.has(object.from.object) : false;
    const to = 'object' in object.to ? out.has(object.to.object) : false;
    if (from && to) out.add(object.id);
  }
  return [...out];
}
