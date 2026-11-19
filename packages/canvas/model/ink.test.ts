import { describe, expect, test } from 'bun:test';
import { LIMITS, checkObject } from './codec';
import { INK_MAX_POINTS, distanceToInk, inkPoints, simplifyLine, strokeFromPoints } from './ink';

/** A circle as a pointer gives it: a point every degree, with a little shake. */
const circle = (cx: number, cy: number, r: number) =>
  Array.from({ length: 361 }, (_, i) => {
    const a = (i / 180) * Math.PI;
    return { x: cx + Math.cos(a) * r + Math.sin(i * 7) * 0.3, y: cy + Math.sin(a) * r + Math.cos(i * 5) * 0.3 };
  });

const box = { id: 'i', type: 'ink', x: 0, y: 0, w: 100, h: 100 };

describe('a line drawn by hand, from what a pointer gave', () => {
  test('is kept as its box and the points across it, so the same drawing anywhere is the same points', () => {
    const here = strokeFromPoints(circle(400, 300, 100))!;
    const there = strokeFromPoints(circle(-9000, 7000, 100))!;
    expect(Math.round(here.x)).toBe(300);
    expect(Math.round(here.w)).toBe(200);
    expect(there.points).toEqual(here.points);
    expect(checkObject({ id: 'ring', type: 'ink', ...here }).ok).toBe(true);
  });

  test('keeps its shape with a fraction of the points, each of them one that was drawn', () => {
    const drawn = circle(0, 0, 100);
    const kept = simplifyLine(drawn, 1);
    expect(kept.length).toBeLessThan(drawn.length / 4);
    expect(kept[0]).toBe(drawn[0]);
    expect(kept[kept.length - 1]).toBe(drawn[drawn.length - 1]);
    for (const p of kept) expect(drawn.includes(p)).toBe(true);
  });

  test('comes back in board coordinates from wherever its box is now, and the pointer finds it there', () => {
    const stored = strokeFromPoints([{ x: 10, y: 10 }, { x: 110, y: 60 }])!;
    const moved = { ...stored, x: 500, y: 500, w: stored.w * 2, h: stored.h * 2 };
    expect(inkPoints(moved)).toEqual([{ x: 500, y: 500 }, { x: 700, y: 600 }]);
    expect(distanceToInk({ x: 600, y: 550 }, moved)).toBeLessThan(0.001);
    expect(distanceToInk({ x: 500, y: 600 }, moved)).toBeGreaterThan(40);
    // Past an end, the nearest place is the end.
    expect(distanceToInk({ x: 497, y: 496 }, moved)).toBe(5);
  });

  test('a tap is not a drawing, and a dead straight line still has a box', () => {
    expect(strokeFromPoints([])).toBeNull();
    expect(strokeFromPoints([{ x: 5, y: 5 }])).toBeNull();
    expect(strokeFromPoints([{ x: 5, y: 5 }, { x: 5.2, y: 5.1 }])).toBeNull();
    expect(strokeFromPoints([{ x: 0, y: 40 }, { x: 300, y: 40 }])).toEqual({ x: 0, y: 40, w: 300, h: 1, points: [0, 0, 1, 0] });
  });

  test('a line of any length is cut to what a document may hold, and what is not a point is left out', () => {
    // All corners: it cannot be simplified by shape, only thinned.
    const scribble = Array.from({ length: 200_000 }, (_, i) => ({ x: i % 977, y: (i % 2) * 50 + (i % 13) }));
    const stored = strokeFromPoints(scribble)!;
    expect(stored.points.length).toBeLessThanOrEqual(INK_MAX_POINTS * 2);
    expect(INK_MAX_POINTS).toBe(LIMITS.inkPoints);
    expect(checkObject({ id: 'long', type: 'ink', ...stored }).ok).toBe(true);

    const broken = [{ x: 0, y: 0 }, { x: Number.NaN, y: 3 }, { x: 4, y: Number.POSITIVE_INFINITY }, null, undefined, { x: '7', y: 7 }, {}, { x: 100, y: 50 }] as never;
    expect(strokeFromPoints(broken)).toEqual({ x: 0, y: 0, w: 100, h: 50, points: [0, 0, 1, 1] });
    expect(strokeFromPoints([{ x: 0, y: 0 }, { x: 100, y: 50 }], Number.NaN)).not.toBeNull();
    expect(strokeFromPoints([{ x: 0, y: 0 }, { x: 100, y: 50 }], -3)).not.toBeNull();
  });
});

describe('a drawn line that someone else wrote', () => {
  const refused = (points: unknown) => expect(checkObject({ ...box, points }).ok).toBe(false);

  test('needs two points or more, as x then y, each a number from 0 to 1', () => {
    expect(checkObject({ ...box, points: [0, 0, 1, 1] }).ok).toBe(true);
    refused(undefined);
    refused([]);
    refused([0, 0]);
    refused([0, 0, 1]);
    refused([0, 0, 1.0001, 1]);
    refused([0, 0, -0.0001, 1]);
    refused([0, 0, Number.NaN, 1]);
    refused([0, 0, Number.POSITIVE_INFINITY, 1]);
    refused([0, 0, '1', 1]);
    refused([0, 0, null, 1]);
    refused([0, 0, [1], 1]);
    refused([0, 0, { valueOf: () => 1 }, 1]);
    refused([0, 0, true, 1]);
  });

  test('is refused when it is not a plain list: a string, a typed array, something that only looks like one, a list with holes', () => {
    refused('M0 0L1 1');
    refused(new Float32Array([0, 0, 1, 1]));
    refused({ length: 4, 0: 0, 1: 0, 2: 1, 3: 1 });
    refused(Object.create(Array.prototype, { length: { value: 4 } }));
    const holes = [0, 0, 1, 1];
    delete holes[2];
    refused(holes);
    // A hole must not be filled in from the prototype of every list.
    const proto = Array.prototype as unknown as Record<number, number>;
    proto[2] = 0.5;
    try {
      const checked = checkObject({ ...box, points: holes });
      // Whatever a reader with a poisoned prototype makes of it, what comes out is plain numbers of its own.
      if (checked.ok && checked.value.type === 'ink') expect(Object.keys(checked.value.points)).toEqual(['0', '1', '2', '3']);
    } finally {
      delete proto[2];
    }
  });

  test('is refused by its length before anything in it is looked at', () => {
    refused(new Array((LIMITS.inkPoints + 1) * 2).fill(0.5));
    expect(checkObject({ ...box, points: new Array(LIMITS.inkPoints * 2).fill(0.5) }).ok).toBe(true);
    // Ten million empty slots: a list this long is turned away without a walk along it.
    let looked = 0;
    const vast = new Proxy(new Array(10_000_000), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) looked += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    refused(vast);
    expect(looked).toBe(0);
  });

  test('is copied, so it does not change when what was handed in does, and minus nothing is nothing', () => {
    const given = [0, 0, 1, 1];
    const checked = checkObject({ ...box, points: given });
    given[2] = 0.25;
    expect(checked.ok && checked.value.type === 'ink' && checked.value.points).toEqual([0, 0, 1, 1]);
    const zero = checkObject({ ...box, points: [-0, 0, 1, 1] });
    expect(zero.ok && zero.value.type === 'ink' && Object.is(zero.value.points[0], 0)).toBe(true);
  });

  test('its pen is one of three, the usual one is no field, and a name every object has is not a pen', () => {
    expect(checkObject({ ...box, points: [0, 0, 1, 1], pen: 'highlighter' }).ok).toBe(true);
    const marker = checkObject({ ...box, points: [0, 0, 1, 1], pen: 'marker' });
    expect(marker.ok && 'pen' in marker.value).toBe(false);
    for (const pen of ['spray', '', 'constructor', '__proto__', 'toString', 0, null, ['fine'], {}]) {
      expect(checkObject({ ...box, points: [0, 0, 1, 1], pen }).ok).toBe(false);
    }
  });

  test('has no words, no shape and no ends: fields of other kinds are dropped, and its points are on nothing else', () => {
    const checked = checkObject({ ...box, points: [0, 0, 1, 1], text: 'x', html: '<b>x</b>', src: 'asset:x', from: { x: 0, y: 0 } });
    expect(checked.ok && Object.keys(checked.value).sort()).toEqual(['h', 'id', 'points', 'type', 'w', 'x', 'y']);
    const note = checkObject({ id: 'n', type: 'note', x: 0, y: 0, w: 10, h: 10, text: 'n', points: [0, 0, 1, 1], pen: 'fine' });
    expect(note.ok && Object.keys(note.value).sort()).toEqual(['h', 'id', 'text', 'type', 'w', 'x', 'y']);
    expect(checkObject({ ...box, points: [0, 0, 1, 1], shape: 'cloud' }).ok).toBe(false);
  });
});
