import { expect, test } from 'bun:test';
import { camAt, CAM_MS, diveInk, diveReading, turnLeg, DIVE_MS, doorOf, doorT, fitRect, LAND, PAD, springStep, STEP_MS, toSheet, wOf, zoomAbout, type Cam } from '../src/view/camera.ts';

function run(ms90: number, frames: number, kick = true) {
  const w = wOf(ms90);
  let x = 0, v = kick ? w / 2 : 0;
  const xs = [0];
  for (let i = 0; i < frames; i++) { [x, v] = springStep(x, v, 1, w, 1 / 60); xs.push(x); }
  return xs;
}

test('a launched move takes its largest step first, then only slows, never overshoots', () => {
  for (const ms of [STEP_MS, CAM_MS, DIVE_MS]) {
    const xs = run(ms, 120);
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(steps[0]).toBe(Math.max(...steps));
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]! + 1e-12);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
  }
});

test('a move is about 90% of the way at its named time', () => {
  for (const ms of [STEP_MS, CAM_MS, DIVE_MS]) {
    const n = Math.round(ms / (1000 / 60));
    const at = run(ms, n).at(-1)!;
    expect(at).toBeGreaterThan(0.85);
    expect(at).toBeLessThan(0.93);
  }
});

test('a second input retargets from where the spring is, with the speed it has (no jump)', () => {
  const w = wOf(DIVE_MS);
  let x = 0, v = w / 2;
  for (let i = 0; i < 15; i++) [x, v] = springStep(x, v, 1, w, 1 / 60);
  let [y, u] = springStep(x, v, 0, w, 1 / 60);
  expect(Math.abs(y - x)).toBeLessThan(Math.abs(v) / 60 + 1e-9);
  for (let i = 0; i < 200; i++) [y, u] = springStep(y, u, 0, w, 1 / 60);
  expect(Math.abs(y)).toBeLessThan(1e-3);
});

test('between two cameras the fixed point holds still and the scale moves evenly in log space', () => {
  const A: Cam = { cx: 500, cy: 300, k: 0.8, sx: 800, sy: 450 };
  const B: Cam = { cx: 900, cy: 520, k: 3.2, sx: 800, sy: 450 };
  const Fx = (A.cx * A.k - B.cx * B.k + B.sx - A.sx) / (A.k - B.k), Fy = (A.cy * A.k - B.cy * B.k + B.sy - A.sy) / (A.k - B.k);
  const at = (c: Cam): [number, number] => [(Fx - c.cx) * c.k + c.sx, (Fy - c.cy) * c.k + c.sy];
  const s0 = at(A);
  for (const e of [0, 0.25, 0.5, 0.75, 1]) {
    const c = camAt(A, B, e);
    const s = at(c);
    expect(Math.hypot(s[0] - s0[0], s[1] - s0[1])).toBeLessThan(1e-6);
    expect(Math.log(c.k)).toBeCloseTo(Math.log(A.k) + (Math.log(B.k) - Math.log(A.k)) * e, 9);
  }
  expect(camAt(A, B, 1).cx).toBeCloseTo(B.cx, 6);
});

test('a zoom about a point keeps that point under the pointer', () => {
  const c: Cam = { cx: 400, cy: 300, k: 1, sx: 800, sy: 450 };
  const before = toSheet(c, 1200, 200);
  const z = zoomAbout(c, 1.25, 1200, 200);
  const after = toSheet(z, 1200, 200);
  expect(z.k).toBeCloseTo(1.25, 9);
  expect(after[0]).toBeCloseTo(before[0], 9);
  expect(after[1]).toBeCloseTo(before[1], 9);
});

test('a sheet rests no larger than 1:1, inside the padding, and in a pane hangs from the top', () => {
  const small = fitRect({ x: 0, y: 0, w: 400, h: 300 }, { w: 1600, h: 900, layout: 'window' });
  expect(small.k).toBe(1);
  const big = fitRect({ x: 0, y: 0, w: 3000, h: 1000 }, { w: 1600, h: 900, layout: 'window' });
  expect(big.k).toBeCloseTo((1600 - 2 * PAD) / 3000, 9);
  const pane = fitRect({ x: 0, y: 0, w: 1200, h: 2000 }, { w: 600, h: 400, layout: 'pane' });
  expect(pane.sy - (pane.cy - 0) * pane.k).toBeCloseTo(PAD, 9);
});

test("a window's door lowers the sheet around before it crosses, and the dive hides the sheet around only once the inside has ink", () => {
  for (const r0 of [0.1, 0.3, 0.6, 0.9]) {
    const d = doorOf(r0);
    expect(d.lo).toBeGreaterThan(r0);
    expect(d.hi).toBeGreaterThan(d.lo);
    expect(d.at).toBeGreaterThanOrEqual(1);
    expect(d.at).toBeGreaterThan(d.hi);
    expect(doorT({ ratio: r0, ...d }, r0)).toBeCloseTo(0, 9);
    expect(doorT({ ratio: d.lo, ...d }, r0)).toBeCloseTo(0.1, 9);
    expect(doorT({ ratio: d.hi, ...d }, r0)).toBeCloseTo(0.6, 9);
  }
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const k = diveInk(t);
    expect(k.around + k.ink).toBeGreaterThan(0.6);
  }
  expect(diveInk(0)).toEqual({ around: 1, box: 1, ink: 0, paper: 0, unroll: 0 });
  expect(diveInk(1)).toEqual({ around: 0, box: 0, ink: 1, paper: 1, unroll: 1 });
});

test('the zoom readout of a dive or a climb never jumps: it reads the sheet around at one landing, the inside at the other, and goes one way between', () => {
  const st = { w: 1440, h: 860, layout: 'window' as const };
  const A = fitRect({ x: 0, y: 0, w: 1800, h: 1000 }, st);
  const r = { x: 600, y: 400, w: 300, h: 140 };
  const s = r.w / 2000;
  const B = fitRect({ x: r.x, y: r.y, w: r.w, h: 1100 * s }, st, 1 / s);
  for (const from of [0, 1] as const) {
    const leg = from === 0 ? { x0: 0, w0: 0, to: 1 as const } : { x0: 1, w0: 1, to: 0 as const };
    const at = (x: number) => diveReading(camAt(A, B, x).k, s, x, leg);
    if (from === 0) {
      expect(at(0)).toBeCloseTo(A.k, 9);
      expect(at(1 - LAND)).toBeCloseTo(camAt(A, B, 1 - LAND).k * s, 9);
    } else {
      expect(at(1)).toBeCloseTo(B.k * s, 9);
      expect(at(LAND)).toBeCloseTo(camAt(A, B, LAND).k, 9);
    }
    let prev = at(from === 0 ? 0 : 1), dir = 0;
    for (let i = 1; i <= 100; i++) {
      const x = from === 0 ? (i / 100) * (1 - LAND) : 1 - (i / 100) * (1 - LAND);
      const v = at(x);
      expect(Math.abs(Math.log(v / prev))).toBeLessThan(0.05);
      const d = Math.sign(v - prev);
      if (d && dir) expect(d).toBe(dir);
      if (d) dir = d;
      prev = v;
    }
  }
  expect(diveReading(2, s, 0.3, { x0: 0, w0: 0, to: 1 }, true)).toBeCloseTo(2 * s, 9);

  const dive = { x0: 0, w0: 0, to: 1 as const };
  for (const xt of [0.2, 0.5, 0.9]) {
    const back = turnLeg(dive, xt, 0);
    const read = (x: number, leg: typeof dive | typeof back) => diveReading(camAt(A, B, x).k, s, x, leg);
    expect(read(xt, back)).toBeCloseTo(read(xt, dive), 9);
    expect(read(LAND, back)).toBeCloseTo(camAt(A, B, LAND).k, 9);
    const xt2 = (xt + LAND) / 2, again = turnLeg(back, xt2, 1);
    expect(read(xt2, again)).toBeCloseTo(read(xt2, back), 9);
    expect(read(1 - LAND, again)).toBeCloseTo(camAt(A, B, 1 - LAND).k * s, 9);
  }
  expect(turnLeg(dive, 0.4, 1)).toBe(dive);
});
