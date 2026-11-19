/**
 * Capturing part of a canvas. A snapshot is a **materialized view**: when it
 * is taken (and each time someone updates it) the planner calls `captureOf`
 * and stores the answer, a frozen copy of the objects and the rectangle they
 * were in, inside the snapshot's own record. Editing the canvas afterwards
 * does not touch that copy.
 *
 * Whether a snapshot is behind is answered by the same function: capture the
 * source again and compare (`capturesEqual`). There is no clock and no
 * version counter to keep in step between peers, and "changed" means exactly
 * "a new capture would look different", per source kind:
 * - a frame: the frame itself, or anything now in its rectangle;
 * - a set of objects: any of them changed or was deleted;
 * - a region: anything now in the rectangle.
 *
 * Cost. A capture holds the objects themselves, not copies: the document
 * never mutates an object, so until one of them is edited the capture and
 * the canvas share it. Fifty snapshots of an unchanged canvas cost fifty
 * small arrays. The comparison takes the same shortcut: an object that is
 * the same reference is equal without being read.
 */
import { idMap, isBoundEnd, objectBounds, resolveArrow } from './document';
import { type Rect, expandRect, rectContainsRect, rectsIntersect, unionRects } from './geometry';
import { type CanvasDocument, type CanvasObject, type ObjectId, type SnapshotCapture, type SnapshotSource, isPlaced } from './types';

/** The strip above a frame that holds its title, in world units. */
export const FRAME_TITLE_HEIGHT = 24;
/** World units of air around a chosen set of objects. */
export const SNAPSHOT_PADDING = 24;

/** Ids of the objects that might overlap a rectangle. Absent: every object is looked at. */
export type RectQuery = (area: Rect) => readonly ObjectId[];

/** What a captured object keeps. Group membership is not part of the picture. */
function frozen(object: CanvasObject): CanvasObject {
  if (!object.group) return object;
  const { group: _group, ...rest } = object;
  return rest as CanvasObject;
}

function inRect(doc: CanvasDocument, area: Rect, query?: RectQuery): ObjectId[] {
  const candidates = query ? new Set(query(area)) : null;
  const out: ObjectId[] = [];
  for (const id of doc.order) {
    if (candidates && !candidates.has(id)) continue;
    const object = doc.objects[id];
    if (!object || object.type === 'group') continue;
    const bounds = objectBounds(doc, id);
    if (!bounds) continue;
    // An arrow's box may have no width or no height; it counts when it is wholly inside.
    if (object.type === 'arrow' ? rectContainsRect(area, bounds) || rectsIntersect(area, bounds) : rectsIntersect(area, bounds)) out.push(id);
  }
  return out;
}

/**
 * What the source shows right now, or null when there is nothing to show
 * (the frame is gone, every chosen object is gone, the rectangle is empty).
 * Objects come back to front. An arrow stuck to an object that is not in the
 * capture has that end fixed where it was, so the capture draws by itself.
 */
export function captureOf(doc: CanvasDocument, source: SnapshotSource, query?: RectQuery): SnapshotCapture | null {
  let rect: Rect;
  let ids: ObjectId[];
  if (source.kind === 'frame') {
    const frame = doc.objects[source.frame];
    if (!frame || frame.type !== 'frame') return null;
    rect = expandRect({ x: frame.x, y: frame.y - FRAME_TITLE_HEIGHT, w: frame.w, h: frame.h + FRAME_TITLE_HEIGHT }, SNAPSHOT_PADDING / 2);
    ids = inRect(doc, rect, query);
  } else if (source.kind === 'region') {
    rect = source.rect;
    ids = inRect(doc, rect, query);
    if (ids.length === 0) return null;
  } else {
    const chosen = new Set(source.objects);
    ids = doc.order.filter((id) => chosen.has(id) && doc.objects[id].type !== 'group' && objectBounds(doc, id));
    const bounds = unionRects(ids.map((id) => objectBounds(doc, id)!));
    if (!bounds) return null;
    rect = expandRect(bounds, SNAPSHOT_PADDING);
  }
  const held = new Set(ids);
  const objects: CanvasObject[] = [];
  for (const id of ids) {
    const object = doc.objects[id];
    if (object.type !== 'arrow') {
      objects.push(frozen(object));
      continue;
    }
    const fromOut = isBoundEnd(object.from) && !held.has(object.from.object);
    const toOut = isBoundEnd(object.to) && !held.has(object.to.object);
    if (!fromOut && !toOut) {
      objects.push(frozen(object));
      continue;
    }
    const geometry = resolveArrow(doc, object);
    if (geometry) objects.push(frozen({ ...object, from: fromOut ? geometry.from : object.from, to: toOut ? geometry.to : object.to }));
  }
  return { rect, objects };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Whether two captures would draw the same picture. */
export function capturesEqual(a: SnapshotCapture | null, b: SnapshotCapture | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.objects.length !== b.objects.length || !same(a.rect, b.rect)) return false;
  for (let i = 0; i < a.objects.length; i++) if (!same(a.objects[i], b.objects[i])) return false;
  return true;
}

/** A small document holding just a capture, so the ordinary renderer can draw it. */
export function captureDocument(capture: SnapshotCapture): CanvasDocument {
  const objects = idMap<CanvasObject>();
  for (const object of capture.objects) objects[object.id] = object;
  return { version: 1, id: 'capture', title: '', objects, order: capture.objects.map((object) => object.id), snapshots: idMap() };
}

/** True for an object type a capture may hold. */
export const isCapturable = (object: CanvasObject): boolean => object.type !== 'group' && (isPlaced(object) || object.type === 'arrow');
