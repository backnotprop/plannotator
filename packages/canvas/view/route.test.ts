import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import type { Point, Rect } from '../model/geometry';
import type { CanvasObject } from '../model/types';
import { type Anchor, CLEARANCE, routeEnters, routeOrthogonal } from './route';
import { findHops, pointAlong, routePath } from './route-path';
import { facingSide, portPoint, routesFor } from './routes';

const rect = (x: number, y: number, w = 100, h = 60): Rect => ({ x, y, w, h });
const anchor = (r: Rect, side: 'n' | 'e' | 's' | 'w', along = 0.5): Anchor => ({ rect: r, side, point: portPoint(r, side, along) });
const orthogonal = (points: Point[]) => points.every((p, i) => i === 0 || Math.abs(p.x - points[i - 1].x) < 0.01 || Math.abs(p.y - points[i - 1].y) < 0.01);
const shrink = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 });
const bends = (points: Point[]) => points.length - 2;

describe('one orthogonal route', () => {
  test('two boxes side by side are joined by one straight line', () => {
    const a = rect(0, 0);
    const b = rect(300, 0);
    const route = routeOrthogonal(anchor(a, 'e'), anchor(b, 'w'), []);
    expect(route).toEqual([{ x: 100, y: 30 }, { x: 300, y: 30 }]);
  });

  test('it runs at right angles, starts and ends on the ports, and goes round what is in the way', () => {
    const a = rect(0, 0);
    const b = rect(600, 0);
    const wall = rect(300, -200, 60, 400);
    const route = routeOrthogonal(anchor(a, 'e'), anchor(b, 'w'), [wall]);
    expect(route[0]).toEqual({ x: 100, y: 30 });
    expect(route[route.length - 1]).toEqual({ x: 600, y: 30 });
    expect(orthogonal(route)).toBe(true);
    expect(routeEnters(route, wall)).toBe(false);
    // It keeps its distance, not just misses.
    expect(routeEnters(route, { x: wall.x - CLEARANCE + 1, y: wall.y - CLEARANCE + 1, w: wall.w + CLEARANCE * 2 - 2, h: wall.h + CLEARANCE * 2 - 2 })).toBe(false);
    expect(bends(route)).toBe(4);
  });

  test('it never passes through either of the boxes it joins', () => {
    const a = rect(0, 0);
    const b = rect(40, 300);
    // Leaving by the far side and arriving by the far side: the line has to go round both.
    const route = routeOrthogonal(anchor(a, 'n'), anchor(b, 's'), []);
    expect(orthogonal(route)).toBe(true);
    expect(routeEnters(route, shrink(a, 1))).toBe(false);
    expect(routeEnters(route, shrink(b, 1))).toBe(false);
  });

  test('across a field of boxes it finds a way through that touches none of them', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
    for (let round = 0; round < 40; round++) {
      const a = rect(0, 400 * random());
      const b = rect(1400, 400 * random());
      const field: Rect[] = [];
      for (let i = 0; i < 18; i++) field.push(rect(180 + random() * 1000, -200 + random() * 800, 60 + random() * 120, 40 + random() * 120));
      const route = routeOrthogonal(anchor(a, 'e'), anchor(b, 'w'), field);
      expect(orthogonal(route)).toBe(true);
      for (const box of field) expect(routeEnters(route, shrink(box, 1))).toBe(false);
      // The same input gives the same line, point for point.
      expect(routeOrthogonal(anchor(a, 'e'), anchor(b, 'w'), field)).toEqual(route);
    }
  });

  test('a free point can be an end, and an end that is boxed in still gets a line', () => {
    const b = rect(300, 200);
    const free: Anchor = { rect: null, side: null, point: { x: 0, y: 0 } };
    const route = routeOrthogonal(free, anchor(b, 'w'), []);
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(orthogonal(route)).toBe(true);
    // Walled in on every side: there is no way round, and the plain line is drawn rather than none.
    const a = rect(0, 0);
    const cage = [rect(-60, -80, 220, 30), rect(-60, 110, 220, 30), rect(-60, -80, 30, 220), rect(130, -80, 30, 220)];
    const stuck = routeOrthogonal(anchor(a, 'e'), anchor(rect(600, 0), 'w'), cage);
    expect(stuck.length).toBeGreaterThanOrEqual(2);
    expect(orthogonal(stuck)).toBe(true);
  });

  test('the side that faces the other end is chosen, and does not flip for a small move', () => {
    const a = rect(0, 0, 100, 100);
    expect(facingSide(a, { x: 400, y: 60 })).toBe('e');
    expect(facingSide(a, { x: 60, y: -300 })).toBe('n');
    // Nearly on the diagonal: whichever side was used before is kept.
    expect(facingSide(a, { x: 300, y: 290 }, 's')).toBe('s');
    expect(facingSide(a, { x: 300, y: 290 }, 'e')).toBe('e');
    expect(facingSide(a, { x: 300, y: 60 }, 's')).toBe('e');
  });
});

describe('routes kept current', () => {
  const box = (id: string, x: number, y: number): CanvasObject => ({ id, type: 'box', x, y, w: 100, h: 60, text: id });
  const arrow = (id: string, from: string, to: string): CanvasObject => ({ id, type: 'arrow', from: { object: from }, to: { object: to } });

  function board(): CanvasStore {
    const store = new CanvasStore(createDocument('board'));
    const objects: CanvasObject[] = [];
    // A grid of 400 boxes, each joined to the next in its row.
    for (let i = 0; i < 400; i++) objects.push(box(`b${i}`, (i % 20) * 260, Math.floor(i / 20) * 200));
    for (let i = 0; i < 400; i++) if (i % 20 !== 19) objects.push(arrow(`a${i}`, `b${i}`, `b${i + 1}`));
    store.dispatch({ type: 'add', objects });
    return store;
  }

  test('moving one object re-routes its own connectors and their neighbours, not the board', () => {
    const store = board();
    const routes = routesFor(store);
    const ids = Object.values(store.getDocument().objects).filter((object) => object.type === 'arrow').map((object) => object.id);
    for (const id of ids) routes.get(id);
    expect(routes.counts).toEqual({ routed: 380, stale: 0 });
    const far = routes.get('a300');
    store.dispatch({ type: 'move', ids: ['b45'], dx: 30, dy: 12 });
    // Its two connectors, and the next one along on each side (they share a side of the boxes it is joined to).
    expect(routes.counts.stale).toBeLessThanOrEqual(6);
    expect(routes.counts.stale).toBeGreaterThanOrEqual(2);
    // A route that had nothing to do with it is the very same route.
    expect(routes.get('a300')).toBe(far);
    // A change that moves nothing re-routes nothing.
    store.dispatch({ type: 'recolor', ids: ['b46'], color: 'red' });
    store.dispatch({ type: 'edit', id: 'b46', patch: { text: 'renamed' } });
    expect(routes.counts.stale).toBeLessThanOrEqual(6);
  });

  test('an object dropped onto a line makes that line go round it, and taking it away lets it straighten', () => {
    const store = board();
    const routes = routesFor(store);
    const straight = routes.get('a0')!;
    expect(straight.points).toHaveLength(2);
    store.dispatch({ type: 'add', objects: [{ id: 'block', type: 'note', x: 150, y: -40, w: 60, h: 140, text: '' }] });
    const round = routes.get('a0')!;
    expect(round.points.length).toBeGreaterThan(2);
    expect(routeEnters(round.points, { x: 151, y: -39, w: 58, h: 138 })).toBe(false);
    store.undo();
    expect(routes.get('a0')!.points).toHaveLength(2);
  });

  test('connectors leaving one side of a box are spread along it, in the order their lines go', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({
      type: 'add',
      objects: [box('hub', 0, 0), box('top', 400, -300), box('mid', 400, 0), box('low', 400, 300), arrow('to-low', 'hub', 'low'), arrow('to-top', 'hub', 'top'), arrow('to-mid', 'hub', 'mid')],
    });
    store.dispatch({ type: 'edit', id: 'to-low', patch: { style: { fromSide: 'e' } } });
    store.dispatch({ type: 'edit', id: 'to-top', patch: { style: { fromSide: 'e' } } });
    const routes = routesFor(store);
    const startY = (id: string) => routes.get(id)!.points[0].y;
    expect(startY('to-top')).toBeLessThan(startY('to-mid'));
    expect(startY('to-mid')).toBeLessThan(startY('to-low'));
    expect(new Set(['to-top', 'to-mid', 'to-low'].map((id) => routes.get(id)!.points[0].x))).toEqual(new Set([100]));
  });

  test('a connector with a missing end has no route, and gets one when the end comes back', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [box('a', 0, 0), box('b', 400, 0), arrow('ab', 'a', 'b')] });
    const routes = routesFor(store);
    expect(routes.get('ab')).not.toBeNull();
    // Deleting an end frees the arrow's end where it was: still drawn, to a point.
    store.dispatch({ type: 'delete', ids: ['b'] });
    expect(routes.get('ab')!.points[routes.get('ab')!.points.length - 1]).toEqual({ x: 400, y: 30 });
    store.undo();
    expect(routes.get('ab')!.points).toEqual([{ x: 100, y: 30 }, { x: 400, y: 30 }]);
  });
});

describe('drawing a route', () => {
  test('a later line hops over an earlier one where they cross, and nowhere else', () => {
    const vertical = [{ x: 100, y: -100 }, { x: 100, y: 100 }];
    const horizontal = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    const hops = findHops([vertical, horizontal]);
    expect([...hops[0]]).toEqual([]);
    expect([...hops[1]]).toEqual([[1, [100]]]);
    expect(routePath(horizontal, hops[1])).toContain('A4.5 4.5');
    // Given the other way round, the vertical one was drawn later and the horizontal one runs straight.
    expect([...findHops([horizontal, vertical])[0]]).toEqual([]);
    // Meeting at an end is not a crossing.
    expect([...findHops([[{ x: 100, y: 0 }, { x: 100, y: 100 }], horizontal])[1]]).toEqual([]);
  });

  test('elbows are rounded, and a label sits where it is asked to along the line', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(routePath(points)).toBe('M0 0L94 0Q100 0 100 6L100 100');
    expect(pointAlong(points, 0.25)).toEqual({ x: 50, y: 0, horizontal: true });
    expect(pointAlong(points, 0.75)).toEqual({ x: 100, y: 50, horizontal: false });
  });
});
