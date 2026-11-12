export type Cam = { cx: number; cy: number; k: number; sx: number; sy: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const STEP_MS = 250, CAM_MS = 375, DIVE_MS = 700;
export const SETTLE = 0.0005;
export const LAND = 0.03;
export const WHEEL_TAU = 80, WHEEL_TAU_PINCH = 45;
export const ZOOM_STEP = 1.25;
export const K_MIN = 0.15, K_MAX = 8;
export const GLIDE_DECAY = 0.0042;

export const SW_EXIT = 120, SW_LEAD = 60, SW_ENTER_AT = 400, SW_STAGGER = 50, SW_IN = 200, SW_CALM = 180;

export const wOf = (ms90: number) => 3000 / ms90;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

export function springStep(x: number, v: number, to: number, w: number, dt: number): [number, number] {
  const d = x - to, c = v + w * d, e = Math.exp(-w * dt);
  const nd = (d + c * dt) * e;
  return [to + nd, (c - w * (d + c * dt)) * e];
}

export type SpringState = { x: number; v: number; to: number };

export function spring(S: SpringState, w: number, onUpdate: (x: number) => void, onDone?: () => void): () => void {
  let raf = 0, dead = false, last: number | null = null;
  const f = (ts: number) => {
    if (dead) return;
    const now = ts ?? performance.now();
    const dt = last == null ? 1 / 60 : clamp((now - last) / 1000, 1 / 240, 0.05);
    last = now;
    [S.x, S.v] = springStep(S.x, S.v, S.to, w, dt);
    if (Math.abs(S.x - S.to) < SETTLE && Math.abs(S.v) < SETTLE * w) {
      S.x = S.to;
      S.v = 0;
      onUpdate(S.x);
      onDone?.();
      return;
    }
    onUpdate(S.x);
    raf = requestAnimationFrame(f);
  };
  raf = requestAnimationFrame(f);
  return () => {
    dead = true;
    cancelAnimationFrame(raf);
  };
}

export function camAt(A: Cam, B: Cam, e: number): Cam {
  const k = Math.exp(lerp(Math.log(A.k), Math.log(B.k), e));
  const sx = lerp(A.sx, B.sx, e), sy = lerp(A.sy, B.sy, e);
  if (Math.abs(A.k - B.k) < 1e-4) return { cx: lerp(A.cx, B.cx, e), cy: lerp(A.cy, B.cy, e), k, sx, sy };
  const Fx = (A.cx * A.k - B.cx * B.k + B.sx - A.sx) / (A.k - B.k);
  const Fy = (A.cy * A.k - B.cy * B.k + B.sy - A.sy) / (A.k - B.k);
  const SFx = (Fx - A.cx) * A.k + A.sx, SFy = (Fy - A.cy) * A.k + A.sy;
  return { cx: Fx - (SFx - sx) / k, cy: Fy - (SFy - sy) / k, k, sx, sy };
}

export const xf = (c: Cam) => `translate(${c.sx - c.cx * c.k}px, ${c.sy - c.cy * c.k}px) scale(${c.k})`;

export const toSheet = (c: Cam, px: number, py: number): [number, number] => [(px - (c.sx - c.cx * c.k)) / c.k, (py - (c.sy - c.cy * c.k)) / c.k];

export function zoomAbout(c: Cam, f: number, px: number, py: number): Cam {
  const [wx, wy] = toSheet(c, px, py);
  const k = clamp(c.k * f, K_MIN, K_MAX);
  return { ...c, k, cx: wx - (px - c.sx) / k, cy: wy - (py - c.sy) / k };
}

export const PAD = 20;
export type Stage = { w: number; h: number; layout: 'pane' | 'window' };

export function fitRect(r: Rect, st: Stage, kMax = 1): Cam {
  const aw = Math.max(1, st.w - PAD * 2), ah = Math.max(1, st.h - PAD * 2);
  const k = Math.max(1e-3, Math.min(kMax, aw / r.w, st.layout === 'window' ? ah / r.h : Infinity));
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, k, sx: st.w / 2, sy: st.layout === 'window' ? st.h / 2 : PAD + (r.h * k) / 2 };
}

export const restCam = (w: number, h: number, st: Stage) => fitRect({ x: 0, y: 0, w, h }, st);

export const paneH = (w: number, h: number, stageW: number) => {
  const k = Math.min(1, Math.max(1, stageW - PAD * 2) / w);
  return Math.ceil(h * k + PAD * 2);
};

export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export type DoorWindow = { ratio: number; lo: number; hi: number; at: number };

export const doorOf = (r0: number) => {
  const lo = Math.max(0.5, r0 * 1.04), hi = Math.max(0.8, lo + 0.12);
  return { lo, hi, at: Math.max(1, hi + 0.08) };
};
export const doorT = (d: DoorWindow, r0: number) => {
  const t = 0.1 + (0.5 * (d.ratio - d.lo)) / (d.hi - d.lo);
  return clamp(d.ratio < d.lo ? Math.min(t, 0.1 * clamp((d.ratio - r0) / (d.lo - r0), 0, 1)) : t, 0, 1);
};
export type ReadingLeg = { x0: number; w0: number; to: 0 | 1 };
export const readingWeight = (x: number, leg: ReadingLeg) => {
  const x1 = leg.to === 1 ? 1 - LAND : LAND, d = x1 - leg.x0;
  return clamp(Math.abs(d) < 1e-6 ? leg.to : leg.w0 + ((leg.to - leg.w0) * (x - leg.x0)) / d, 0, 1);
};
export const turnLeg = (leg: ReadingLeg, x: number, to: 0 | 1): ReadingLeg => (leg.to === to ? leg : { x0: x, w0: readingWeight(x, leg), to });
export const diveReading = (k: number, s: number, x: number, leg: ReadingLeg, inside = false) => k * Math.pow(s, inside ? 1 : readingWeight(x, leg));
export const diveInk = (t: number) => ({
  around: 1 - smooth(0.1, 0.6, t),
  box: 1 - smooth(0, 0.24, t),
  ink: smooth(0.02, 0.22, t) * lerp(0.5, 1, smooth(0.05, 0.6, t)),
  paper: smooth(0.2, 0.6, t),
  unroll: smooth(0.1, 0.6, t),
});
