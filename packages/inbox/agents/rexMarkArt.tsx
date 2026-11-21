/**
 * The drawing of a Rex status mark (the owner's "jelly" marks, approved 2026-11-17; the design is
 * the approved "Final: jelly"): a halo disc in the colour of the surface under it, then the state's shape,
 * then its glyph. Theme tokens only. Nothing else is drawn: no shine, no bubbles, no dots.
 *
 * Geometry, for a mark of diameter d: the halo has radius d/2; the shape radius d/2 - 1.25; rings (working's track,
 * idle, done) are 1.6 px at radius d/2 - 2.05; the glyph is drawn on a 14-unit grid in a box of d - 2.5 at inset
 * 1.25, its stroke 1.9 units (done 1.7), at most 2.6 px. Working is one tapered arc of 120 degrees on the ring, its
 * round head max(2.4 px, 0.2 d) wide, its tail 30% of that.
 */
import type { ReactElement } from 'react';
import type { InboxRexMark } from '@plannotator/core/inbox-types';

/** What a mark draws: a waiting kind, or a state. `blocked` is waiting with no kind said; `answered` the check a mark shows as it goes. */
export type RexMarkKey = 'question' | 'permission' | 'signin' | 'blocked' | 'working' | 'done' | 'idle' | 'error' | 'answered';

export function rexMarkKey(mark: InboxRexMark): Exclude<RexMarkKey, 'answered'> {
  if (mark.state !== 'blocked') return mark.state;
  return mark.kind === 'question' ? 'question' : mark.kind === 'permission' ? 'permission' : mark.kind === 'auth' ? 'signin' : 'blocked';
}

/** Waiting on the person: the marks that stay alive (and gather in a pile). */
export const rexMarkWaits = (key: RexMarkKey): boolean => key === 'question' || key === 'permission' || key === 'signin' || key === 'blocked';

/** The tile sizes a mark is drawn for (its icon's box: a bare 16, a 20 tile, a 24, a 30 tile). */
export type RexMarkSize = 16 | 20 | 24 | 30;

/** The mark's diameter: the waiting kinds and working are the bigger ones. */
export function rexMarkDiameter(size: RexMarkSize, key: RexMarkKey): number {
  const big = rexMarkWaits(key) || key === 'working' || key === 'answered';
  return size === 16 ? (big ? 12 : 10) : size === 20 ? (big ? 15 : 12) : size === 24 ? (big ? 16 : 13) : big ? 18 : 14;
}

/** Where it sits: over the tile's bottom-right corner (px past the tile's bottom and right edges). `side`: the sidebar's bare mark. */
export function rexMarkOffsets(size: RexMarkSize, side: boolean): { bottom: number; right: number } {
  return { bottom: size === 16 ? -5 : size === 20 ? -6 : -6.5, right: side ? -5 : -3 };
}

const AMBER = 'var(--warning)';
const KNOCK = 'var(--card)';
const HALO = 'var(--rx-halo, var(--card))';

/** The halo and the state's shape. */
export function RexMarkShape({ markKey, d }: { markKey: RexMarkKey; d: number }) {
  const r = d / 2;
  const inner = r - 1.25;
  const ring = (stroke: string) => <circle cx={r} cy={r} r={inner - 0.8} fill="none" stroke={stroke} strokeWidth={1.6} />;
  let shape = null;
  if (markKey === 'working') shape = ring('var(--ib-st-track)');
  else if (markKey === 'idle' || markKey === 'done') shape = ring('var(--ib-st-ring)');
  else if (markKey === 'error') shape = <circle cx={r} cy={r} r={inner} fill="var(--destructive)" />;
  else if (markKey === 'question') {
    const q = inner;
    // A speech bubble: the disc with a tail at its lower left.
    shape = <path fill={AMBER} d={`M${r} ${r - q}a${q} ${q} 0 1 1 ${-q * 0.62} ${q * 1.78}l${-q * 0.5} ${q * 0.22}l${q * 0.16} ${-q * 0.5}A${q} ${q} 0 0 1 ${r} ${r - q}Z`} />;
  } else shape = <circle cx={r} cy={r} r={inner} fill={AMBER} />;
  return (
    <svg className="ib-rxm-shape" width={d} height={d} viewBox={`0 0 ${d} ${d}`} aria-hidden="true">
      <circle cx={r} cy={r} r={r} fill={HALO} />
      {shape}
    </svg>
  );
}

const GLYPHS: Partial<Record<RexMarkKey, ReactElement>> = {
  question: (
    <>
      <path d="M5.1 5.3a1.95 1.95 0 1 1 2.8 1.75c-.55.28-.9.65-.9 1.2v.3" />
      <path d="M7 10.6h.01" />
    </>
  ),
  permission: (
    <>
      <circle cx="4.9" cy="7" r="1.9" />
      <path d="M6.8 7h4.4M9.9 7v1.9" />
    </>
  ),
  signin: (
    <>
      <path d="M8.6 3.6h1.9v6.8H8.6" />
      <path d="M3.3 7h5M6.4 5 8.3 7 6.4 9" />
    </>
  ),
  error: <path d="M7 3.8v3.9M7 10.3h.01" />,
  done: <path d="M3.6 7.3 6 9.6 10.5 4.6" />,
  answered: <path d="M3.6 7.3 6 9.6 10.5 4.6" />,
};

/** The glyph, in its box of d - 2.5 (null: the state has none). Knocked out of the shape, but done's check, which is quiet. */
export function RexMarkGlyph({ markKey, d }: { markKey: RexMarkKey; d: number }) {
  const glyph = GLYPHS[markKey];
  if (!glyph) return null;
  const box = d - 2.5;
  const filled = markKey !== 'done';
  const stroke = Math.min(((filled ? 1.9 : 1.7) * 14) / box, 2.6);
  return (
    <svg width={box} height={box} viewBox="0 0 14 14" fill="none" stroke={filled ? KNOCK : 'var(--ib-st-mut)'} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {glyph}
    </svg>
  );
}

/** Working's arc: a tapered 120 degrees ending in a round head at the top, turned by its wrapper. */
export function RexMarkArc({ d }: { d: number }) {
  const r = d / 2;
  const R = r - 1.25 - 0.8;
  const W = Math.max(2.4, d * 0.2);
  const N = 14;
  const SPAN = 120;
  const pt = (deg: number, rad: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(r + rad * Math.sin(a)).toFixed(2)} ${(r - rad * Math.cos(a)).toFixed(2)}`;
  };
  const outer: string[] = [];
  const inner: string[] = [];
  for (let j = 0; j <= N; j++) {
    const f = j / N;
    const deg = -SPAN * (1 - f);
    const w = (W * (0.3 + 0.7 * f)) / 2;
    outer.push(pt(deg, R + w));
    inner.push(pt(deg, R - w));
  }
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} aria-hidden="true">
      <path d={`M${outer.join('L')}L${inner.reverse().join('L')}Z`} fill="var(--primary)" />
      <circle cx={r} cy={(r - R).toFixed(2)} r={(W / 2).toFixed(2)} fill="var(--primary)" />
    </svg>
  );
}

/**
 * Each agent its own tempo (0.82 to 1.18) and phase (0 to 1) from its id, so a room of marks never moves in step.
 */
export function rexMarkSeed(id: string): { tempo: number; phase: number } {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const u = h >>> 0;
  return { tempo: 0.82 + 0.36 * ((u % 10007) / 10007), phase: (Math.floor(u / 10007) % 9973) / 9973 };
}
