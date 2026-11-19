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

/**
 * A map keyed by id with no prototype, so an id such as `constructor` or
 * `__proto__` is just an id: `map[id]` is the stored value or undefined,
 * never something inherited from `Object.prototype`. Every `objects` and
 * `snapshots` map in a document is one of these (made here, in the reducer,
 * in the codec and when a store takes a document), which is what makes a
 * plain `doc.objects[id]` safe everywhere.
 */
export function idMap<T>(from?: Readonly<Record<string, T>>): Record<string, T> {
  const map = Object.create(null) as Record<string, T>;
  if (from) for (const key of Object.keys(from)) map[key] = from[key];
  return map;
}

/** The same document with its maps made prototype-free. A document that already is comes back as it was. */
export function withIdMaps(doc: CanvasDocument): CanvasDocument {
  if (Object.getPrototypeOf(doc.objects) === null && Object.getPrototypeOf(doc.snapshots) === null) return doc;
  return { ...doc, objects: idMap(doc.objects), snapshots: idMap(doc.snapshots) };
}

export function createDocument(id: string, title = ''): CanvasDocument {
  return { version: CANVAS_DOCUMENT_VERSION, id, title, objects: idMap(), order: [], snapshots: idMap() };
}

export const isBoundEnd = (end: ArrowEnd): end is { object: ObjectId } => 'object' in end;

/** The two points an arrow is drawn between, or null when it cannot be drawn. */
export interface ArrowGeometry {
  from: Point;
  to: Point;
}

/** The rect of a group's placed members, nested groups included. Arrows are not asked. */
function placedBounds(doc: CanvasDocument, groupId: ObjectId): Rect | null {
  const rects: Rect[] = [];
  for (const member of groupMembers(doc, groupId)) {
    const child = doc.objects[member];
    if (child && isPlaced(child)) rects.push(child);
  }
  return unionRects(rects);
}

/**
 * An arrow end's anchor: the free point, or the rect of what it is stuck to.
 * An end may be stuck to a placed object or to a group; a group is measured
 * by its placed members only. So working out an arrow never asks about
 * another arrow, and no chain of arrows and groups can go round in a circle,
 * whatever a document holds. An end stuck to an arrow has no anchor.
 */
function endRect(doc: CanvasDocument, end: ArrowEnd): Rect | Point | null {
  if (!isBoundEnd(end)) return end;
  const target = doc.objects[end.object];
  if (!target) return null;
  if (isPlaced(target)) return target;
  return target.type === 'group' ? placedBounds(doc, target.id) : null;
}

/**
 * Why an arrow may not be stuck to `targetId`, or null when it may. The one
 * rule for every door (the planner, a loaded file, a peer's event): an end
 * sticks to a placed object, or to a group the arrow is not inside.
 */
/** Finds an object by id: a document's map, or a map with changes laid over it. */
export type ObjectLookup = (id: ObjectId) => CanvasObject | undefined;

export function bindingFault(lookup: ObjectLookup, arrow: { id: ObjectId; group?: ObjectId }, targetId: ObjectId): string | null {
  const target = lookup(targetId);
  if (!target) return `there is no object ${targetId} to attach to`;
  if (target.type === 'arrow') return `${targetId} is an arrow; an arrow attaches to an object or a group`;
  if (target.type !== 'group') return null;
  let group = arrow.group;
  for (let depth = 0; group && depth < 64; depth++) {
    if (group === targetId) return `it is inside the group ${targetId} it would attach to`;
    group = lookup(group)?.group;
  }
  return null;
}

/** Whether following `group` upward from `id` comes back round, or never ends. */
export function groupCycle(lookup: ObjectLookup, id: ObjectId): boolean {
  let group = lookup(id)?.group;
  for (let depth = 0; group; depth++) {
    if (group === id || depth > 64) return true;
    group = lookup(group)?.group;
  }
  return false;
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
  // Each group is walked once, so a document whose groups hold each other still ends.
  const walked = new Set<ObjectId>([groupId]);
  const walk = (id: ObjectId) => {
    for (const object of Object.values(doc.objects)) {
      if (object.group !== id || object.id === groupId) continue;
      out.push(object.id);
      if (object.type === 'group' && !walked.has(object.id)) {
        walked.add(object.id);
        walk(object.id);
      }
    }
  };
  walk(groupId);
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
