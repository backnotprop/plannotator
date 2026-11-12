import { balance, FONTS, lh as scaleH, type Wrapped } from './measure.ts';
import type { LabelBox, Pt, Rect } from './types.ts';

const PAD = 3, OFF = 7, LETTER = 24;

const hit = (a: Rect, b: Rect, m = 0) => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

type Seg = { id: string; ab: [Pt, Pt] };

function segHits(box: Rect, segs: Seg[], own: string, m = 0): number {
  let n = 0;
  for (const s of segs) {
    if (s.id === own) continue;
    const [a, b] = s.ab;
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    if (x1 >= box.x - m && x0 <= box.x + box.w + m && y1 >= box.y - m && y0 <= box.y + box.h + m) n++;
  }
  return n;
}

function shared(a: Pt, b: Pt, segs: Seg[], own: string): boolean {
  for (const s of segs) {
    if (s.id === own) continue;
    const [p, q] = s.ab;
    if (a[0] === b[0] && p[0] === q[0] && p[0] === a[0]) {
      if (Math.min(Math.max(p[1], q[1]), Math.max(a[1], b[1])) - Math.max(Math.min(p[1], q[1]), Math.min(a[1], b[1])) > 4) return true;
    }
    if (a[1] === b[1] && p[1] === q[1] && p[1] === a[1]) {
      if (Math.min(Math.max(p[0], q[0]), Math.max(a[0], b[0])) - Math.max(Math.min(p[0], q[0]), Math.min(a[0], b[0])) > 4) return true;
    }
  }
  return false;
}

const DENSE_ROOM = 14;

const CLEAR = 5;
const straddles = (box: Rect, z: Rect, m = 2) =>
  hit(box, z, m) && !(box.x >= z.x + m && box.y >= z.y + m && box.x + box.w <= z.x + z.w - m && box.y + box.h <= z.y + z.h - m);

export type LabelEdge = { id: string; says: string; quiet: boolean; letter: string | null; pts?: Pt[]; paths?: Pt[][] };
export type LabelInput = {
  edges: LabelEdge[];
  parts: Rect[];
  blocks: Rect[];
  soft: Rect[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  dense?: boolean;
  zones?: Rect[];
  strict?: boolean;
  lines?: [Pt, Pt][];
};

type Cand = { x: number; y: number; s: number; side: string };

export function placeLabels({ edges, parts, blocks, soft, bounds, dense = false, zones = [], strict = false, lines = [] }: LabelInput): Record<string, LabelBox> {
  const segs: Seg[] = [];
  for (const e of edges) {
    const all = [e.pts, ...(e.paths ?? [])].filter((p): p is Pt[] => !!p);
    for (const p of all) for (let i = 0; i < p.length - 1; i++) segs.push({ id: e.id, ab: [p[i]!, p[i + 1]!] });
  }
  for (const [i, ab] of lines.entries()) segs.push({ id: '_line' + i, ab });
  const placed: Rect[] = [];
  const order = edges
    .filter((e) => e.says)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.quiet ? 1 : 0) - (b.e.quiet ? 1 : 0) || a.i - b.i);
  const result: Record<string, LabelBox> = {};
  const lineH = scaleH(16);
  for (const { e } of order) {
    const wraps: Wrapped[] = [balance(e.says, FONTS.label, scaleH(250), 2)];
    const two = balance(e.says, FONTS.label, scaleH(120), 2);
    if (two.lines.length <= 2 && two.width < wraps[0]!.width - 10) wraps.push(two);
    let best: (Cand & { s: number }) | null = null;
    let chosen: { t: Wrapped; lw: number; lh: number } | null = null;
    let loose: (Cand & { t: Wrapped; lw: number; lh: number }) | null = null;
    for (const [wi, t] of wraps.entries()) {
      const lw = t.width + PAD * 2 + (e.letter ? LETTER : 0), lh = t.lines.length * lineH + 2;
      const cands: Cand[] = [];
      const path = e.pts ?? [];
      const segList: { a: Pt; b: Pt; main: boolean }[] = [];
      for (let i = 0; i < path.length - 1; i++) segList.push({ a: path[i]!, b: path[i + 1]!, main: true });
      for (const p of e.paths ?? []) for (let i = 0; i < p.length - 1; i++) segList.push({ a: p[i]!, b: p[i + 1]!, main: false });
      const allPts = [path, ...(e.paths ?? [])].flat();
      const mcx = allPts.length ? allPts.reduce((a, q) => a + q[0], 0) / allPts.length : 0;
      const mcy = allPts.length ? allPts.reduce((a, q) => a + q[1], 0) / allPts.length : 0;
      segList.forEach((s, si) => {
        const [ax, ay] = s.a, [bx, by] = s.b;
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 10) return;
        if (dense && (L < 60 || shared(s.a, s.b, segs, e.id))) return;
        const pref = (s.main ? 0 : 40) + si * 2 - Math.min(L, 200) * 0.08;
        for (const [f, fp] of [[0.5, 0], [0.32, 6], [0.68, 6], [0.18, 14], [0.82, 14]] as const) {
          if (ax === bx) {
            const y = ay + (by - ay) * f;
            const lean = strict ? (mcx < ax - 1 ? -1 : 0) : 0;
            cands.push({ x: ax + OFF, y: y - lh / 2, s: pref + fp + (lean < 0 ? 6 : 0), side: 'r' });
            cands.push({ x: ax - OFF - lw, y: y - lh / 2, s: pref + fp + (lean < 0 ? 0 : 3), side: 'l' });
          } else {
            const x = ax + (bx - ax) * f;
            const lean = strict ? (mcy > ay + 1 ? 1 : mcy < ay - 1 ? -1 : 0) : 0;
            cands.push({ x: x - lw / 2, y: ay - OFF - lh + 2, s: pref + fp + (lean > 0 ? 6 : 0), side: 'a' });
            cands.push({ x: x - lw / 2, y: ay + OFF, s: pref + fp + (lean > 0 ? 0 : 3), side: 'b' });
            cands.push({ x: Math.min(ax, bx) + 10, y: ay - OFF - lh + 2, s: pref + fp + 8, side: 'a' });
          }
        }
      });
      for (const c of cands) {
        c.s += wi * 60;
        const box = { x: c.x, y: c.y, w: lw, h: lh };
        if (box.x < bounds.x0 || box.y < bounds.y0 || box.x + box.w > bounds.x1 || box.y + box.h > bounds.y1) continue;
        if (parts.some((r) => hit(box, r, 2))) continue;
        if (blocks.some((r) => hit(box, r, 2))) continue;
        // the slot a hover shows when no free slot is left: off every part, so
        // the label never covers the name of the part being looked at
        if (!loose || c.s < loose.s) loose = { ...c, t, lw, lh };
        if (placed.some((r) => hit(box, r, dense ? DENSE_ROOM : 4))) continue;
        const crossed = segHits(box, segs, e.id, CLEAR);
        if ((dense || strict) && crossed) continue;
        if (zones.length && zones.some((z) => straddles(box, z))) continue;
        let s = c.s + crossed * 120;
        for (const r of soft) s += area(box, r) * 0.6;
        if (!best || s < best.s) {
          best = { ...c, s };
          chosen = { t, lw, lh };
        }
      }
    }
    const path = e.pts ?? [];
    if (best && chosen) {
      const box = { x: best.x, y: best.y, w: chosen.lw, h: chosen.lh };
      placed.push(box);
      result[e.id] = { ...box, lines: chosen.t.lines, side: best.side };
    } else if (loose) {
      result[e.id] = { x: loose.x, y: loose.y, w: loose.lw, h: loose.lh, lines: loose.t.lines, side: loose.side, hidden: true };
    } else {
      const t = wraps[0]!;
      const lw = t.width + PAD * 2 + (e.letter ? LETTER : 0), lh = t.lines.length * lineH + 2;
      const m = path[Math.floor(path.length / 2)] ?? [0, 0];
      result[e.id] = { x: m[0] + OFF, y: m[1] - lh / 2, w: lw, h: lh, lines: t.lines, hidden: true };
    }
  }
  return result;
}

/**
 * A letter keeps off every part's name: the name sits in the top left of a box, so that strip
 * counts as taken.
 */
export function placeLetters(notes: { l: string; on: string }[], rects: Record<string, Rect | undefined>, taken: Rect[]) {
  const out: { l: string; x: number; y: number; on: string }[] = [];
  const names = Object.values(rects)
    .filter((r): r is Rect => !!r && !!r.w)
    .map((r) => ({ x: r.x + 4, y: r.y + 2, w: Math.min(r.w - 8, 170), h: 24 }));
  for (const n of notes) {
    const r = rects[n.on];
    if (!r) continue;
    const spots: Pt[] = [
      [r.x + r.w, r.y + r.h / 2], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2],
      [r.x + r.w * 0.75, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w, r.y],
    ];
    let pick = spots[0]!;
    for (const c of spots) {
      const box = { x: c[0] - 11, y: c[1] - 11, w: 22, h: 22 };
      if (!taken.some((t) => hit(box, t, 1)) && !names.some((t) => hit(box, t, 0))) {
        pick = c;
        break;
      }
    }
    taken.push({ x: pick[0] - 11, y: pick[1] - 11, w: 22, h: 22 });
    out.push({ l: n.l, x: pick[0], y: pick[1], on: n.on });
  }
  return out;
}
