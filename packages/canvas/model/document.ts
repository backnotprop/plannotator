/**
 * Reading a canvas document: bounds, arrows, groups. All pure. The functions
 * that change a document live in `events/` and nowhere else.
 */
import {
  type Point,
  type Rect,
  rectCenter,
  rectEdgeToward,
  rectFromPoints,
  unionRects,
} from './geometry';
import {
  CANVAS_DOCUMENT_VERSION,
  type ArrowEnd,
  type ArrowObject,
  type CanvasDocument,
  type CanvasObject,
  type ObjectId,
  isPlaced,
} from './types';

export function createDocument(id: string, title = ''): CanvasDocument {
  return { version: CANVAS_DOCUMENT_VERSION, id, title, objects: {}, order: [], snapshots: {} };
}

export const isBoundEnd = (end: ArrowEnd): end is { object: ObjectId } => 'object' in end;

/** The two points an arrow is drawn between, or null when it cannot be drawn. */
export interface ArrowGeometry {
  from: Point;
  to: Point;
}

/** An arrow end's anchor: a bound object's rect, or the free point itself. */
function endRect(doc: CanvasDocument, end: ArrowEnd): Rect | Point | null {
  if (!isBoundEnd(end)) return end;
  const target = doc.objects[end.object];
  if (!target) return null;
  return objectBounds(doc, target.id);
}

const anchorCenter = (anchor: Rect | Point): Point => ('w' in anchor ? rectCenter(anchor) : anchor);

/**
 * Where an arrow runs. An end bound to an object starts on that object's
 * edge, facing the other end. An end bound to an object that no longer
 * exists makes the arrow undrawable (null): the planner frees such ends when
 * it deletes an object, so this only happens to a document someone else wrote.
 */
export function resolveArrow(doc: CanvasDocument, arrow: ArrowObject): ArrowGeometry | null {
  const a = endRect(doc, arrow.from);
  const b = endRect(doc, arrow.to);
  if (!a || !b) return null;
  const ca = anchorCenter(a);
  const cb = anchorCenter(b);
  return {
    from: 'w' in a ? rectEdgeToward(a, cb) : a,
    to: 'w' in b ? rectEdgeToward(b, ca) : b,
  };
}

/** Ids of the objects in a group, nested groups included, in no set order. */
export function groupMembers(doc: CanvasDocument, groupId: ObjectId): ObjectId[] {
  const out: ObjectId[] = [];
  const walk = (id: ObjectId, depth: number) => {
    if (depth > 32) return;
    for (const object of Object.values(doc.objects)) {
      if (object.group !== id) continue;
      out.push(object.id);
      if (object.type === 'group') walk(object.id, depth + 1);
    }
  };
  walk(groupId, 0);
  return out;
}

/**
 * The world rect an object covers, or null when it has none (an arrow with a
 * lost end, an empty group, an unknown id).
 */
export function objectBounds(doc: CanvasDocument, id: ObjectId): Rect | null {
  const object = doc.objects[id];
  if (!object) return null;
  if (isPlaced(object)) return { x: object.x, y: object.y, w: object.w, h: object.h };
  if (object.type === 'arrow') {
    const geometry = resolveArrow(doc, object);
    return geometry ? rectFromPoints(geometry.from, geometry.to) : null;
  }
  const rects: Rect[] = [];
  for (const member of groupMembers(doc, id)) {
    const child = doc.objects[member];
    if (!child || child.type === 'group') continue;
    const bounds = objectBounds(doc, member);
    if (bounds) rects.push(bounds);
  }
  return unionRects(rects);
}

/** The rect holding every given object that still has bounds, or null. */
export function boundsOf(doc: CanvasDocument, ids: Iterable<ObjectId>): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const bounds = objectBounds(doc, id);
    if (bounds) rects.push(bounds);
  }
  return unionRects(rects);
}

/** The outermost group an object sits in, or the object itself. */
export function outermostGroup(doc: CanvasDocument, id: ObjectId): ObjectId {
  let current = id;
  for (let depth = 0; depth < 32; depth++) {
    const parent = doc.objects[current]?.group;
    if (!parent || !doc.objects[parent]) return current;
    current = parent;
  }
  return current;
}

/**
 * What a click on one object selects: the object, or every drawable member
 * of the outermost group it belongs to. A group moves as one.
 */
export function selectionUnit(doc: CanvasDocument, id: ObjectId): ObjectId[] {
  const top = outermostGroup(doc, id);
  const object = doc.objects[top];
  if (!object) return [];
  if (object.type !== 'group') return [top];
  return groupMembers(doc, top).filter((member) => doc.objects[member]?.type !== 'group');
}

/** Arrows with an end bound to any of the given objects. */
export function arrowsBoundTo(doc: CanvasDocument, ids: ReadonlySet<ObjectId>): ArrowObject[] {
  const out: ArrowObject[] = [];
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'arrow') continue;
    if ((isBoundEnd(object.from) && ids.has(object.from.object)) || (isBoundEnd(object.to) && ids.has(object.to.object))) {
      out.push(object);
    }
  }
  return out;
}

/** Objects in drawing order, back to front. Ids `order` lost are skipped. */
export function objectsInOrder(doc: CanvasDocument): CanvasObject[] {
  const out: CanvasObject[] = [];
  for (const id of doc.order) {
    const object = doc.objects[id];
    if (object) out.push(object);
  }
  return out;
}
