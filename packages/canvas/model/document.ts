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
import { compareOrder, keyBetween } from './order-key';
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

/** Every object id, back to front: sorted by order key, then id. */
export function orderOf(objects: Readonly<Record<ObjectId, CanvasObject>>): ObjectId[] {
  return Object.values(objects)
    .sort(compareOrder)
    .map((object) => object.id);
}

/**
 * The same objects, each with an order key. An object that has none is
 * given one, on top of those that do, in the sequence `fallback` lists
 * them. Objects that already have keys are not touched.
 */
export function withOrderKeys(objects: Readonly<Record<ObjectId, CanvasObject>>, fallback: readonly ObjectId[]): Record<ObjectId, CanvasObject> {
  let top: string | null = null;
  let missing = false;
  for (const object of Object.values(objects)) {
    if (object.z === undefined) missing = true;
    else if (top === null || object.z > top) top = object.z;
  }
  if (!missing) return objects as Record<ObjectId, CanvasObject>;
  const out = idMap(objects);
  for (const id of fallback) {
    const object = out[id];
    if (!object || object.z !== undefined) continue;
    top = keyBetween(top, null);
    out[id] = { ...object, z: top };
  }
  return out;
}

/**
 * A document made safe to hold: maps with no prototype, every object with
 * an order key, `order` worked out from the keys. A document that is
 * already so comes back as it was. A store does this to whatever it is given.
 */
export function withIdMaps(doc: CanvasDocument): CanvasDocument {
  const plain = Object.getPrototypeOf(doc.objects) !== null || Object.getPrototypeOf(doc.snapshots) !== null;
  const keyed = withOrderKeys(doc.objects, doc.order.length ? doc.order : Object.keys(doc.objects));
  if (!plain && keyed === doc.objects) return doc;
  const objects = keyed === doc.objects ? idMap(doc.objects) : keyed;
  return { ...doc, objects, order: orderOf(objects), snapshots: idMap(doc.snapshots) };
}

export function createDocument(id: string, title = ''): CanvasDocument {
  return { version: CANVAS_DOCUMENT_VERSION, id, title, objects: idMap(), order: [], snapshots: idMap() };
}

export const isBoundEnd = (end: ArrowEnd): end is { object: ObjectId } => 'object' in end;

/** The two points an arrow is drawn between, or null when it cannot be drawn. */
export interface ArrowGeometry {
  from: Point;
  to: Point;
  /** Corners between the two, for an arrow from an object back to itself: a loop round one of its corners. */
  via?: Point[];
}

/** How far a loop stands off the object it leaves and comes back to. */
export const LOOP_REACH = 26;

/** The loop an arrow makes from an object back to itself: out of its right side, round the corner, in at the top. */
export function selfLoop(r: Rect): ArrowGeometry {
  const from = { x: r.x + r.w, y: r.y + Math.min(r.h * 0.35, 40) };
  const to = { x: r.x + r.w - Math.min(r.w * 0.25, 48), y: r.y };
  const out = r.x + r.w + LOOP_REACH;
  const up = r.y - LOOP_REACH;
  return { from, to, via: [{ x: out, y: from.y }, { x: out, y: up }, { x: to.x, y: up }] };
}

/** Every point of an arrow's line, end to end. */
export const arrowPoints = (g: ArrowGeometry): Point[] => [g.from, ...(g.via ?? []), g.to];

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

/** How far a curved connector bows off the straight line between its ends: a share of that line's length, and the most, in world units. */
export const CURVE_BOW = 0.16;
export const CURVE_BOW_MAX = 90;

/**
 * The one point that shapes a curved connector (`routing: 'curve'`): the
 * control point of the quadratic curve between its ends. The curve bows to
 * the left of the way it runs, so it is the same every time, and two
 * connectors between one pair, one each way, part instead of lying on each
 * other. Null when the ends are in one place: there is no way it runs.
 */
export function curveControl(from: Point, to: Point): Point | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!(length >= 1)) return null;
  // The control point of a quadratic curve stands twice as far off the line as the curve's own middle does.
  const off = 2 * Math.min(CURVE_BOW_MAX, length * CURVE_BOW);
  return { x: (from.x + to.x) / 2 + (dy / length) * off, y: (from.y + to.y) / 2 - (dx / length) * off };
}

/** A point of the quadratic curve from `a` to `b` shaped by `c`, at `t` from 0 to 1. */
export function curvePoint(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** The rect that holds the whole of that curve: its ends, and where it turns back along each axis. */
function curveBounds(a: Point, c: Point, b: Point): Rect {
  const xs = [a.x, b.x];
  const ys = [a.y, b.y];
  const tx = (a.x - c.x) / (a.x - 2 * c.x + b.x);
  const ty = (a.y - c.y) / (a.y - 2 * c.y + b.y);
  if (tx > 0 && tx < 1) xs.push(curvePoint(a, c, b, tx).x);
  if (ty > 0 && ty < 1) ys.push(curvePoint(a, c, b, ty).y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
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
  if (isBoundEnd(arrow.from) && isBoundEnd(arrow.to) && arrow.from.object === arrow.to.object && 'w' in a) return selfLoop(a);
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
    if (!geometry) return null;
    if (!geometry.via) {
      // A curve's box holds its bow, so it is mounted, captured and found by the pointer wherever it runs.
      const control = object.routing === 'curve' ? curveControl(geometry.from, geometry.to) : null;
      return control ? curveBounds(geometry.from, control, geometry.to) : rectFromPoints(geometry.from, geometry.to);
    }
    const points = arrowPoints(geometry);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
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
