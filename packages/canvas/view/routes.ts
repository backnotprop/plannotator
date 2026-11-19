/**
 * Every connector's route, kept current as the board changes.
 *
 * A route depends on its two ends, on which side of each it leaves, on
 * where along that side its port sits (ports on one side are spread out in
 * the order of where their lines go), and on what stands in between. So one
 * object moving can change more than the lines stuck to it. `Router` keeps
 * each route with what it was worked out from, and when the document
 * changes marks stale only:
 *   - the connectors stuck to what changed,
 *   - the connectors stuck to their other ends (their ports share sides),
 *   - the connectors whose line passes where the object was or now is.
 * Everything else is reused as it stands. A drag re-routes a handful of
 * lines a frame, however many the board holds.
 *
 * Stale routes are worked out when asked for, within a time budget per
 * frame; a route still waiting keeps its last shape (moved along with its
 * ends) and is finished in the next frame, so a burst of changes never
 * blocks one.
 */
import type { CanvasStore } from '../events/store';
import type { CanvasEvent } from '../events/types';
import { arrowPoints, isBoundEnd, selfLoop } from '../model/document';
import { type Point, type Rect, rectsIntersect } from '../model/geometry';
import { type ArrowEnd, type ArrowObject, type CanvasDocument, type CanvasObject, type ObjectId, type Side, isPlaced } from '../model/types';
import type { DocumentIndex } from './document-index';
import { indexFor } from './document-index';
import { type Anchor, CLEARANCE, STUB, routeOrthogonal } from './route';

export interface Route {
  /** The line's points, end to end. */
  points: Point[];
  /** The rectangle that holds the line. */
  bounds: Rect;
  fromSide: Side | null;
  toSide: Side | null;
}

/** How many obstacles near a connector are looked at; beyond that the nearest are kept. */
const MAX_OBSTACLES = 28;
/** How far round the two ends obstacles are looked for. */
const REACH = 160;
/** How much of a side ports are spread over. */
const SPREAD = 0.64;
/** Milliseconds of routing done in one go before the rest waits for the next frame. */
export const ROUTE_BUDGET_MS = 5;

const SIDES: Side[] = ['n', 'e', 's', 'w'];

function boundsOfPoints(points: readonly Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The rectangle an end is stuck to, or null for a free point or something that is not there. */
function rectOf(doc: CanvasDocument, end: ArrowEnd): Rect | null {
  if (!isBoundEnd(end)) return null;
  const target = doc.objects[end.object];
  return target && isPlaced(target) ? target : null;
}

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** The side of `a` that faces `towards`. `keep` is the side chosen before: it stays unless another is clearly better. */
export function facingSide(a: Rect, towards: Point, keep?: Side | null): Side {
  const c = centre(a);
  // Compared by how far past each edge the other end lies, so a wide box and a tall one are treated alike.
  const dx = Math.abs(towards.x - c.x) - a.w / 2;
  const dy = Math.abs(towards.y - c.y) - a.h / 2;
  const horizontal: Side = towards.x >= c.x ? 'e' : 'w';
  const vertical: Side = towards.y >= c.y ? 's' : 'n';
  const best = dx >= dy ? horizontal : vertical;
  if (keep && keep !== best && (keep === horizontal || keep === vertical) && Math.abs(dx - dy) < 28) return keep;
  return best;
}

export function portPoint(r: Rect, side: Side, along = 0.5): Point {
  switch (side) {
    case 'n':
      return { x: r.x + r.w * along, y: r.y };
    case 's':
      return { x: r.x + r.w * along, y: r.y + r.h };
    case 'w':
      return { x: r.x, y: r.y + r.h * along };
    case 'e':
      return { x: r.x + r.w, y: r.y + r.h * along };
  }
}

export class Router {
  private readonly routes = new Map<ObjectId, Route>();
  private readonly stale = new Set<ObjectId>();
  /** The connectors stuck to each object. */
  private readonly attached = new Map<ObjectId, Set<ObjectId>>();
  /** What each connector is stuck to, as last seen (so a removed or re-stuck one can be let go of). */
  private readonly ends = new Map<ObjectId, ObjectId[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private pending = 0;
  /** Routes asked for that could not be done in their frame. */
  private readonly wanted = new Set<ObjectId>();
  private told = 0;

  constructor(
    private doc: CanvasDocument,
    private readonly index: DocumentIndex,
  ) {
    for (const object of Object.values(doc.objects)) if (object.type === 'arrow') this.attach(object);
  }

  /** Called when routes that were waiting have been finished and a view should draw again. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** How many routes are worked out and how many wait: for tests and the benchmark. */
  get counts(): { routed: number; stale: number } {
    return { routed: this.routes.size, stale: this.stale.size };
  }

  private attach(arrow: ArrowObject): void {
    const ids: ObjectId[] = [];
    for (const end of [arrow.from, arrow.to]) {
      if (!isBoundEnd(end)) continue;
      ids.push(end.object);
      let set = this.attached.get(end.object);
      if (!set) this.attached.set(end.object, (set = new Set()));
      set.add(arrow.id);
    }
    this.ends.set(arrow.id, ids);
    this.stale.add(arrow.id);
  }

  private detach(id: ObjectId): void {
    for (const end of this.ends.get(id) ?? []) {
      const set = this.attached.get(end);
      set?.delete(id);
      if (set && set.size === 0) this.attached.delete(end);
    }
    this.ends.delete(id);
  }

  /** Mark stale the connectors stuck to this object, and those stuck to their other ends: ports on a shared side move together. */
  private touch(id: ObjectId): void {
    for (const arrow of this.attached.get(id) ?? []) {
      this.stale.add(arrow);
      for (const other of this.ends.get(arrow) ?? []) {
        if (other !== id) for (const sibling of this.attached.get(other) ?? []) this.stale.add(sibling);
      }
    }
  }

  /** Mark stale every connector whose line runs through any of these places: where things were, and where they are now. */
  private sweep(rects: Rect[]): void {
    if (rects.length === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    const all = { x: x0 - CLEARANCE, y: y0 - CLEARANCE, w: x1 - x0 + CLEARANCE * 2, h: y1 - y0 + CLEARANCE * 2 };
    // Many things moved at once: every line in the area they cover is looked at again, without asking which.
    const coarse = rects.length > 24;
    for (const [arrow, route] of this.routes) {
      if (this.stale.has(arrow) || !rectsIntersect(all, route.bounds)) continue;
      if (coarse) {
        this.stale.add(arrow);
        continue;
      }
      const near = { x: route.bounds.x - CLEARANCE, y: route.bounds.y - CLEARANCE, w: route.bounds.w + CLEARANCE * 2, h: route.bounds.h + CLEARANCE * 2 };
      if (rects.some((r) => rectsIntersect(near, r))) this.stale.add(arrow);
    }
  }

  /** Bring the routes up to `doc` after `events` were applied to reach it from `before`. */
  apply(doc: CanvasDocument, before: CanvasDocument, events: readonly CanvasEvent[]): void {
    this.doc = doc;
    const moved: Rect[] = [];
    // What only changed place, and by how much: a connector whose two ends went the same way goes with them.
    const shifts = new Map<ObjectId, Point>();
    for (const event of events) {
      const id = event.type === 'object-added' ? event.object.id : event.type === 'object-set' || event.type === 'object-removed' ? event.id : null;
      if (!id) continue;
      const was = before.objects[id];
      const now = doc.objects[id];
      if (was?.type === 'arrow' || now?.type === 'arrow') {
        this.detach(id);
        this.routes.delete(id);
        this.stale.delete(id);
        if (now?.type === 'arrow') this.attach(now);
        // Its siblings on the sides it used, or uses now, are spread again.
        for (const arrow of [was, now]) {
          if (arrow?.type !== 'arrow') continue;
          for (const end of [arrow.from, arrow.to]) if (isBoundEnd(end)) for (const sibling of this.attached.get(end.object) ?? []) this.stale.add(sibling);
        }
        continue;
      }
      // Only where something is, or how big, matters to a route. A new colour or new words do not.
      if (event.type === 'object-set' && !('x' in event.set) && !('y' in event.set) && !('w' in event.set) && !('h' in event.set) && !('shape' in event.set)) continue;
      if (was && isPlaced(was)) moved.push(was);
      if (now && isPlaced(now)) moved.push(now);
      if (event.type === 'object-set' && was && now && isPlaced(was) && isPlaced(now) && !('w' in event.set) && !('h' in event.set) && !('shape' in event.set)) {
        shifts.set(id, { x: now.x - was.x, y: now.y - was.y });
      }
      this.touch(id);
    }
    this.sweep(moved);
    // A connector both of whose ends moved by the same amount keeps its shape, moved along with them, instead
    // of being worked out again: dragging a group does not re-route the lines inside it. (What now stands in
    // its way is looked at the next time something near it changes.)
    if (shifts.size > 1) {
      for (const [arrow, route] of this.routes) {
        if (!this.stale.has(arrow)) continue;
        const ends = this.ends.get(arrow);
        const object = doc.objects[arrow];
        if (!ends || ends.length !== 2 || object?.type !== 'arrow') continue;
        const a = shifts.get(ends[0]);
        const b = shifts.get(ends[1]);
        if (!a || !b || a.x !== b.x || a.y !== b.y) continue;
        this.routes.set(arrow, {
          ...route,
          points: route.points.map((p) => ({ x: p.x + a.x, y: p.y + a.y })),
          bounds: { x: route.bounds.x + a.x, y: route.bounds.y + a.y, w: route.bounds.w, h: route.bounds.h },
        });
        this.stale.delete(arrow);
      }
    }
    this.version += 1;
  }

  rebuild(doc: CanvasDocument): void {
    this.doc = doc;
    this.routes.clear();
    this.stale.clear();
    this.attached.clear();
    this.ends.clear();
    for (const object of Object.values(doc.objects)) if (object.type === 'arrow') this.attach(object);
    this.version += 1;
  }

  /** The sides a connector leaves and arrives by: its own, when it names them, else the ones that face each other. */
  private sidesOf(arrow: ArrowObject, from: Rect | null, to: Rect | null): { from: Side | null; to: Side | null } {
    const previous = this.routes.get(arrow.id);
    const fromPoint = from ? centre(from) : (arrow.from as Point);
    const toPoint = to ? centre(to) : (arrow.to as Point);
    return {
      from: from ? (arrow.style?.fromSide ?? facingSide(from, toPoint, previous?.fromSide)) : null,
      to: to ? (arrow.style?.toSide ?? facingSide(to, fromPoint, previous?.toSide)) : null,
    };
  }

  /** Where along a side this connector's port sits: connectors on one side are spread in the order their lines go. */
  private along(objectId: ObjectId, rect: Rect, side: Side, arrowId: ObjectId): number {
    const doc = this.doc;
    const horizontal = side === 'n' || side === 's';
    const sharing: { id: ObjectId; at: number }[] = [];
    for (const id of this.attached.get(objectId) ?? []) {
      const arrow = doc.objects[id];
      if (arrow?.type !== 'arrow' || (arrow.routing ?? 'elbow') !== 'elbow') continue;
      for (const [end, other] of [
        [arrow.from, arrow.to],
        [arrow.to, arrow.from],
      ] as [ArrowEnd, ArrowEnd][]) {
        if (!isBoundEnd(end) || end.object !== objectId) continue;
        const otherRect = rectOf(doc, other);
        const otherPoint = otherRect ? centre(otherRect) : isBoundEnd(other) ? null : other;
        if (!otherPoint) continue;
        const mine = end === arrow.from ? arrow.style?.fromSide : arrow.style?.toSide;
        const used = mine ?? facingSide(rect, otherPoint, end === arrow.from ? this.routes.get(id)?.fromSide : this.routes.get(id)?.toSide);
        if (used === side) sharing.push({ id, at: horizontal ? otherPoint.x : otherPoint.y });
      }
    }
    if (sharing.length <= 1) return 0.5;
    sharing.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const place = sharing.findIndex((entry) => entry.id === arrowId);
    if (place === -1) return 0.5;
    return 0.5 - SPREAD / 2 + (SPREAD * (place + 0.5)) / sharing.length;
  }

  private compute(arrow: ArrowObject): Route | null {
    const doc = this.doc;
    const fromRect = rectOf(doc, arrow.from);
    const toRect = rectOf(doc, arrow.to);
    if (isBoundEnd(arrow.from) && !fromRect) return null;
    if (isBoundEnd(arrow.to) && !toRect) return null;
    if (fromRect && isBoundEnd(arrow.from) && isBoundEnd(arrow.to) && arrow.from.object === arrow.to.object) {
      // From an object back to itself: a loop round its corner, not a route.
      const points = arrowPoints(selfLoop(fromRect));
      return { points, bounds: boundsOfPoints(points), fromSide: 'e', toSide: 'n' };
    }
    const sides = this.sidesOf(arrow, fromRect, toRect);
    const from: Anchor = fromRect
      ? { rect: fromRect, side: sides.from, point: portPoint(fromRect, sides.from!, this.along((arrow.from as { object: ObjectId }).object, fromRect, sides.from!, arrow.id)) }
      : { rect: null, side: null, point: arrow.from as Point };
    const to: Anchor = toRect
      ? { rect: toRect, side: sides.to, point: portPoint(toRect, sides.to!, this.along((arrow.to as { object: ObjectId }).object, toRect, sides.to!, arrow.id)) }
      : { rect: null, side: null, point: arrow.to as Point };

    // What stands near the two ends. Frames and containers hold things, they are not in the way; the two
    // ends are kept clear of by the route itself.
    const x0 = Math.min(from.point.x, to.point.x) - REACH;
    const y0 = Math.min(from.point.y, to.point.y) - REACH;
    const area = { x: x0, y: y0, w: Math.max(from.point.x, to.point.x) + REACH - x0, h: Math.max(from.point.y, to.point.y) + REACH - y0 };
    const skip = new Set<ObjectId>();
    for (const end of [arrow.from, arrow.to]) if (isBoundEnd(end)) skip.add(end.object);
    let obstacles: (Rect & { far: number })[] = [];
    const mid = { x: (from.point.x + to.point.x) / 2, y: (from.point.y + to.point.y) / 2 };
    for (const id of this.index.spatial.query(area)) {
      if (skip.has(id)) continue;
      const object: CanvasObject | undefined = doc.objects[id];
      if (!object || !isPlaced(object) || object.type === 'frame' || (object.type === 'box' && object.shape === 'container')) continue;
      obstacles.push({ x: object.x, y: object.y, w: object.w, h: object.h, far: Math.abs(object.x + object.w / 2 - mid.x) + Math.abs(object.y + object.h / 2 - mid.y) });
    }
    if (obstacles.length > MAX_OBSTACLES) obstacles = obstacles.sort((a, b) => a.far - b.far).slice(0, MAX_OBSTACLES);
    const found = routeOrthogonal(from, to, obstacles);
    // A line always has two ends, even when they are the same place (an arrow of no length).
    const points = found.length >= 2 ? found : [from.point, to.point];
    return { points, bounds: boundsOfPoints(points), fromSide: sides.from, toSide: sides.to };
  }

  /**
   * The route of one connector. Worked out now if it is stale and there is
   * time; otherwise its last shape comes back and it is finished later
   * (`subscribe` says when). Null: it cannot be drawn (an end is missing).
   * `deadline` is a `performance.now()` time after which no more is worked
   * out (a connector with no route yet then also gives null, for now);
   * absent, this one always is.
   */
  get(arrowId: ObjectId, deadline?: number): Route | null {
    const known = this.routes.get(arrowId);
    if (known && !this.stale.has(arrowId)) return known;
    const arrow = this.doc.objects[arrowId];
    if (arrow?.type !== 'arrow') return null;
    if (deadline !== undefined && performance.now() > deadline) {
      // Out of time for this frame. It keeps its last shape, or is a straight line if it has never had one
      // (null: the caller draws the plain line), and is worked out between frames.
      this.wanted.add(arrowId);
      this.later();
      return known ?? null;
    }
    const route = this.compute(arrow);
    this.stale.delete(arrowId);
    if (route) this.routes.set(arrowId, route);
    else this.routes.delete(arrowId);
    return route;
  }

  /**
   * Work through the routes that were asked for and could not be done in time, a few milliseconds a frame,
   * between frames. Views are told to draw again when all of them are done, or every so often while a great
   * many are still to do: drawing again is itself work, and doing it every frame for a few more lines each
   * time would cost more than the routing.
   */
  private later(): void {
    if (this.pending || typeof requestAnimationFrame === 'undefined') return;
    const step = () => {
      this.pending = 0;
      const until = performance.now() + ROUTE_BUDGET_MS;
      for (const id of this.wanted) {
        if (performance.now() > until) break;
        this.wanted.delete(id);
        if (this.stale.has(id)) this.get(id);
      }
      const now = performance.now();
      if (this.wanted.size === 0 || now - this.told > TELL_EVERY_MS) {
        this.told = now;
        this.version += 1;
        for (const listener of [...this.listeners]) listener();
      }
      if (this.wanted.size) this.pending = requestAnimationFrame(step);
    };
    this.pending = requestAnimationFrame(step);
  }
}

/** While many routes are still being worked out, views are told to draw again this often. */
const TELL_EVERY_MS = 120;

const ROUTERS = new WeakMap<CanvasStore, Router>();

/** The one router of a store, made on first use and kept current from the store's own event stream. */
export function routesFor(store: CanvasStore): Router {
  let router = ROUTERS.get(store);
  if (!router) {
    const made = new Router(store.getDocument(), indexFor(store));
    store.onCommit((envelope, doc, before) => (envelope.rebased ? made.rebuild(doc) : made.apply(doc, before, envelope.events)));
    ROUTERS.set(store, made);
    router = made;
  }
  return router;
}

export { SIDES, STUB };
