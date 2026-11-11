// The player measures the drawing (where each piece, path and target is) and hands it in as `Geo`;
// this file never touches the DOM, so it is tested on its own.
import type { ShapeScene, ShapeSceneColor, ShapeSceneKey } from '@plannotator/core/shape-scene';

export interface Pt {
  x: number;
  y: number;
}

/** What the player measured in the drawing, in the scene SVG's own coordinates. */
export interface Geo {
  home(id: string): Pt | null;
  along(id: string, p: number): Pt | null;
}

export interface PieceLook {
  at?: Pt;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  opacity?: number;
  color?: { from: ShapeSceneColor; to: ShapeSceneColor; k: number };
  text?: string;
  draw?: number;
  lit?: boolean;
}

type Ease = NonNullable<ShapeSceneKey['ease']>;

export function eased(ease: Ease | undefined, k: number): number {
  const u = Math.max(0, Math.min(1, k));
  if (ease === 'linear') return u;
  if (ease === 'jump') return u >= 1 ? 1 : 0;
  // smooth: ease in and out (cubic), so a piece starts and stops softly.
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function around<K extends ShapeSceneKey>(keys: K[], t: number): { a: K; b: K; k: number } | null {
  if (!keys.length) return null;
  if (t <= keys[0]!.at) return { a: keys[0]!, b: keys[0]!, k: 0 };
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (t < b.at) {
      const a = keys[i - 1]!;
      const span = b.at - a.at;
      return { a, b, k: span > 0 ? eased(b.ease, (t - a.at) / span) : 1 };
    }
  }
  const last = keys[keys.length - 1]!;
  return { a: last, b: last, k: 0 };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type NumProp = 'scale' | 'scaleX' | 'scaleY' | 'rotate' | 'opacity' | 'draw';
const NUM_PROPS: NumProp[] = ['scale', 'scaleX', 'scaleY', 'rotate', 'opacity', 'draw'];

interface Place {
  key: ShapeSceneKey;
  pt: Pt;
  path?: string;
  p?: number;
}

export function places(id: string, keys: ShapeSceneKey[], geo: Geo): Place[] {
  const home = geo.home(id);
  let last: Pt | null = home;
  const out: Place[] = [];
  for (const key of keys) {
    let pt: Pt | null = null;
    let path: string | undefined;
    if (key.x !== undefined || key.y !== undefined) pt = { x: key.x ?? last?.x ?? 0, y: key.y ?? last?.y ?? 0 };
    else if (key.to) pt = geo.home(key.to);
    else if (key.along && key.p !== undefined) {
      pt = geo.along(key.along, key.p);
      path = key.along;
    } else continue;
    if (!pt) continue;
    out.push({ key, pt, ...(path ? { path, p: key.p } : {}) });
    last = pt;
  }
  return out;
}

export function lookAt(keys: ShapeSceneKey[], placed: Place[], t: number, geo: Geo): PieceLook {
  const look: PieceLook = {};
  const pl = around(placed.map((p) => Object.assign({}, p.key, { _p: p })), t) as { a: ShapeSceneKey & { _p: Place }; b: ShapeSceneKey & { _p: Place }; k: number } | null;
  if (pl) {
    const A = pl.a._p, B = pl.b._p;
    if (A === B || pl.k <= 0) look.at = A.pt;
    else if (pl.k >= 1) look.at = B.pt;
    else if (A.path && A.path === B.path && A.p !== undefined && B.p !== undefined) look.at = geo.along(A.path, lerp(A.p, B.p, pl.k)) ?? B.pt;
    else look.at = { x: lerp(A.pt.x, B.pt.x, pl.k), y: lerp(A.pt.y, B.pt.y, pl.k) };
  }
  for (const prop of NUM_PROPS) {
    const r = around(keys.filter((k) => k[prop] !== undefined), t);
    if (r) look[prop] = lerp(r.a[prop]!, r.b[prop]!, r.k);
  }
  const c = around(keys.filter((k) => k.color !== undefined), t);
  if (c) look.color = { from: c.a.color!, to: c.b.color!, k: c.k };
  // Words and lit switch at their key (they do not tween).
  const atOrBefore = <P extends 'text' | 'lit'>(prop: P): ShapeSceneKey[P] | undefined => {
    const ks = keys.filter((k) => k[prop] !== undefined);
    if (!ks.length) return undefined;
    let v = ks[0]![prop];
    for (const k of ks) if (k.at <= t) v = k[prop];
    return v;
  };
  const text = atOrBefore('text');
  if (text !== undefined) look.text = text;
  const lit = atOrBefore('lit');
  if (lit !== undefined) look.lit = lit;
  return look;
}

/** The beat showing at `t`: the last one at or before it (the first, before any). */
export function beatAt(scene: ShapeScene, t: number): number {
  let i = 0;
  scene.beats.forEach((b, j) => {
    if (b.at <= t + 1e-9) i = j;
  });
  return i;
}

/** Reduced motion: the moment a drag lands on. */
export function reducedTime(scene: ShapeScene, t: number): number {
  return scene.beats[beatAt(scene, t)]!.at;
}

/** Reduced motion: what Play shows next, the first beat after `t`; null at the last beat (Play stops). */
export function nextBeatTime(scene: ShapeScene, t: number): number | null {
  const next = scene.beats.find((b) => b.at > t + 1e-9);
  return next ? next.at : null;
}

/** How long the whole scene plays at 1×, in ms. */
export function playMs(scene: ShapeScene): number {
  const s = scene.seconds ?? ((scene.unit ?? 'step') === 'step' ? scene.end * 1.2 : 10);
  return Math.max(2, Math.min(120, s)) * 1000;
}

/** The player's one count: the beat the caption shows, as "10 of 15". */
export function beatCount(scene: ShapeScene, t: number): string {
  return `${beatAt(scene, t) + 1} of ${scene.beats.length}`;
}

/** A board colour, or a mix on the way between two, as CSS. */
export function colourCss(c: NonNullable<PieceLook['color']>): string {
  if (c.k <= 0 || c.from === c.to) return `var(--${c.from})`;
  if (c.k >= 1) return `var(--${c.to})`;
  return `color-mix(in oklab, var(--${c.from}) ${((1 - c.k) * 100).toFixed(1)}%, var(--${c.to}))`;
}
