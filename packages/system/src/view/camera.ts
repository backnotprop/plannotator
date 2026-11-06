// The camera: where the sheet on screen sits on the glass, and how it moves.
// Ported from G (round 4, entry G, App.jsx and geom.js; NOTES.md steps 8f to
// 8k). No React and no DOM here except requestAnimationFrame and the reduced
// motion query, so the numbers can be tested on their own.
//
// A camera { cx, cy, k, sx, sy } puts the sheet's point (cx, cy) at the stage's
// point (sx, sy), at scale k. The sheet on screen is always at the world's
// origin; a dive re-roots the world on the sheet it enters, so scales never
// compound however deep the drawing goes.
//
// Every move is a critically damped spring launched by the input: its fastest
// frame is the first one, then it only slows, never overshoots and never stops
// hard (x = 1 - (1 + wt/2)e^(-wt) from rest). The state { x, v, to } is read
// every frame, so a second input retargets from where the camera is, with the
// speed it has. A move is named by its time to 90% of the way (about 3/w s).

export type Cam = { cx: number; cy: number; k: number; sx: number; sy: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Time to 90% of the way: a + or - step, a fit or refit, a dive into a window or out of it. */
export const STEP_MS = 250, CAM_MS = 375, DIVE_MS = 700;
/** The spring rests below a pixel (G step 8j: 0.003 left a 2 px snap at the end of a long move). */
export const SETTLE = 0.0005;
/** A dive lands (re-roots, names its sheet) this close to its end; the camera glides the rest. */
export const LAND = 0.03;
/** The wheel's zoom is owed and paid off about the pointer: a notch or a scroll, and a trackpad pinch. */
export const WHEEL_TAU = 80, WHEEL_TAU_PINCH = 45;
/** + and - step by this factor. */
export const ZOOM_STEP = 1.25;
/** The camera's scale stays between these (G's clamp: 15 to 800 percent). Crossing a door re-roots it, so it never stops a descent. */
export const K_MIN = 0.15, K_MAX = 8;
/** A drag let go while moving glides on and slows, per ms. */
export const GLIDE_DECAY = 0.0042;

// The Simple / Full move (G step 8g). Into Simple, what only Full draws fades
// out (SW_EXIT, ease-out) and the parts start SW_LEAD after the press, when the
// fade is 94% done. Into Full, the parts start at once; Full's own things come
// back SW_ENTER_AT into the move (the spring is 91% of the way), lines first,
// their words SW_STAGGER later, each over SW_IN, the words from 0.96 of their
// size. Reduced motion: the same fades, a cut, and the world fades up over SW_CALM.
export const SW_EXIT = 120, SW_LEAD = 60, SW_ENTER_AT = 400, SW_STAGGER = 50, SW_IN = 200, SW_CALM = 180;

/** The spring's rate for a move named by its time to 90% of the way. */
export const wOf = (ms90: number) => 3000 / ms90;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

/** One step of a critically damped spring toward `to`: x the position, v its speed per second, w the rate, dt seconds. */
export function springStep(x: number, v: number, to: number, w: number, dt: number): [number, number] {
  const d = x - to, c = v + w * d, e = Math.exp(-w * dt);
  const nd = (d + c * dt) * e;
  return [to + nd, (c - w * (d + c * dt)) * e];
}

export type SpringState = { x: number; v: number; to: number };

/**
 * Runs a spring on requestAnimationFrame. Its clock is the frame's own
 * timestamp (every callback of a frame shares it), and the first frame after
 * the input carries a whole frame of motion, so the first step is the largest
 * (G step 8j). Returns a stop function.
 */
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

/**
 * The camera between two cameras at e (0 is A, 1 is B): the scale moves in log
 * space, and the point that holds still on the glass between the two (their
 * fixed point) holds still all the way, so a zoom into a window looks like a
 * zoom, not a slide and a zoom.
 */
export function camAt(A: Cam, B: Cam, e: number): Cam {
  const k = Math.exp(lerp(Math.log(A.k), Math.log(B.k), e));
  const sx = lerp(A.sx, B.sx, e), sy = lerp(A.sy, B.sy, e);
  if (Math.abs(A.k - B.k) < 1e-4) return { cx: lerp(A.cx, B.cx, e), cy: lerp(A.cy, B.cy, e), k, sx, sy };
  const Fx = (A.cx * A.k - B.cx * B.k + B.sx - A.sx) / (A.k - B.k);
  const Fy = (A.cy * A.k - B.cy * B.k + B.sy - A.sy) / (A.k - B.k);
  const SFx = (Fx - A.cx) * A.k + A.sx, SFy = (Fy - A.cy) * A.k + A.sy;
  return { cx: Fx - (SFx - sx) / k, cy: Fy - (SFy - sy) / k, k, sx, sy };
}

/** The world's CSS transform for a camera (transform-origin 0 0). */
export const xf = (c: Cam) => `translate(${c.sx - c.cx * c.k}px, ${c.sy - c.cy * c.k}px) scale(${c.k})`;

/** A stage point in sheet units under a camera. */
export const toSheet = (c: Cam, px: number, py: number): [number, number] => [(px - (c.sx - c.cx * c.k)) / c.k, (py - (c.sy - c.cy * c.k)) / c.k];

/** The camera after a zoom by factor f about a stage point, the point holding still. */
export function zoomAbout(c: Cam, f: number, px: number, py: number): Cam {
  const [wx, wy] = toSheet(c, px, py);
  const k = clamp(c.k * f, K_MIN, K_MAX);
  return { ...c, k, cx: wx - (px - c.sx) / k, cy: wy - (py - c.sy) / k };
}

/** The stage room a view fits its sheet into: inside PAD on every side. */
export const PAD = 20;
export type Stage = { w: number; h: number; layout: 'pane' | 'window' };

/**
 * The camera that fits a rect at rest: the stage's width (a pane, which grows
 * down to the sheet) or the whole stage (a window), never past `kMax` (1:1 for
 * a sheet, so a sheet never rests past its own size). In a pane the rect hangs
 * from the top, so a sheet of another height lands at the same place.
 */
export function fitRect(r: Rect, st: Stage, kMax = 1): Cam {
  const aw = Math.max(1, st.w - PAD * 2), ah = Math.max(1, st.h - PAD * 2);
  const k = Math.max(1e-3, Math.min(kMax, aw / r.w, st.layout === 'window' ? ah / r.h : Infinity));
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, k, sx: st.w / 2, sy: st.layout === 'window' ? st.h / 2 : PAD + (r.h * k) / 2 };
}

/** The rest camera of a sheet of size w by h. */
export const restCam = (w: number, h: number, st: Stage) => fitRect({ x: 0, y: 0, w, h }, st);

/** The height a pane's stage takes for a sheet: the sheet at the width's scale, plus the room around it. */
export const paneH = (w: number, h: number, stageW: number) => {
  const k = Math.min(1, Math.max(1, stageW - PAD * 2) / w);
  return Math.ceil(h * k + PAD * 2);
};

/** Reduced motion, read when a move starts (so a change of the setting applies to the next move). */
export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
