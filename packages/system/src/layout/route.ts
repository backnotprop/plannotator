// Orthogonal line routing. The method is libavoid's in small: build an
// orthogonal visibility grid from the obstacle edges and the ports, search it
// with A* where a bend, a crossing and a shared run each cost extra, then
// nudge collinear runs apart onto tracks. Ported from entry G's route.js with
// its step 8b rules on (G's `?g=off` branches are not ported).
import type { Pt, Rect } from './types.ts';

const INFLATE = 12; // lines keep this far from a part
const STUB = 18; // a line leaves a part straight for at least this long
const BEND = 46, CROSS = 34, SHARE = 6; // costs (SHARE is per unit length)
// On a sheet that is not dense, a line takes at most two bends where any
// route allows it; each bend past the second costs THIRD.
const THIRD = 170;
const EDGE_NEAR = 7, EDGE_K = 2;
const PORT_GAP = 16;
// Gutter rules (all sheets): a segment outside the envelope of the bands and
// side columns pays OUT_K per pixel plus OUT_C, so a detour round the frame is
// a last resort. A horizontal run in the strip between a wrapped band's rows
// is closed to lines that do not have both ends in that band.
const OUT_K = 7, OUT_C = 400, ENV_PAD = 30;
// Dense sheets only: a horizontal run inside a band the line does not start
// or end in pays BAND_K per pixel; a run along a segment already used in the
// same direction costs BUNDLE per pixel, so lines gather into trunks.
const BAND_K = 2.5, BUNDLE = 0.3, OPPOSE = 24, TRACK = 8;
const STRIP_HOP = 300;

export type Side = 't' | 'b' | 'l' | 'r';
export type RouteRect = Rect & { band?: string; bubble?: boolean };
export type Bounds = { x0: number; y0: number; x1: number; y1: number };
export type BandBox = Bounds & { id: string };
export type Strip = Bounds & { band: string };
export type Riser = { x: number; band: string };
export type RouteCtx = {
  dense?: boolean;
  channels?: { gutters: number[]; lanes: number[] } | null;
  heads?: Rect[];
  env?: Bounds | null;
  bandBoxes?: BandBox[];
  strips?: Strip[];
  risers?: Riser[];
  only?: boolean;
};
export type RouteEdge = { id: string; from: string[]; to: string; both?: boolean };
export type Routed = { pts: Pt[]; paths?: Pt[][] };

const DIR: Record<Side, Pt> = { t: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] };
const vert = (s: Side) => s === 't' || s === 'b';

const gapX = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
const gapY = (a: Rect, b: Rect) => Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

// A side is blocked when another part sits right in front of it, too close
// for a line to leave straight.
function blocked(r: Rect, side: Side, all: Rect[]): boolean {
  const room = STUB + INFLATE + 4;
  return all.some((o) => {
    if (o === r) return false;
    if (vert(side)) {
      if (Math.min(o.x + o.w, r.x + r.w) - Math.max(o.x, r.x) < 20) return false;
      const d = side === 't' ? r.y - (o.y + o.h) : o.y - (r.y + r.h);
      return d >= -1 && d < room;
    }
    if (Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y) < 20) return false;
    const d = side === 'l' ? r.x - (o.x + o.w) : o.x - (r.x + r.w);
    return d >= -1 && d < room;
  });
}

/** Which sides a line between two parts leaves and enters by: facing sides on the axis with the wider gap, unless a neighbour blocks one of them. */
export function sidesFor(a: Rect, b: Rect, all: Rect[] = []): [Side, Side] {
  const gx = gapX(a, b), gy = gapY(a, b);
  const h: [Side, Side] = cx(b) > cx(a) ? ['r', 'l'] : ['l', 'r'];
  const v: [Side, Side] = cy(b) > cy(a) ? ['b', 't'] : ['t', 'b'];
  const ok = (p: [Side, Side]) => !blocked(a, p[0], all) && !blocked(b, p[1], all);
  const first = gx > gy ? h : v, second = gx > gy ? v : h;
  if (ok(first)) return first;
  // two parts side by side whose facing sides are blocked: the line leaves and
  // enters by the same outer side (one U, two bends), not by a top and a bottom
  const ovY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y), ovX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const same: [Side, Side][] = first === h && ovY > 0 ? [['b', 'b'], ['t', 't']] : first === v && ovX > 0 ? [['r', 'r'], ['l', 'l']] : [];
  for (const q of same) if (ok(q)) return q;
  if (!ok(second)) return first;
  return second;
}

function overlap(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
  return hi >= lo ? [lo, hi] : null;
}

// Desired port coordinate along a side: inside the overlap with the far part
// when there is one (so the line runs straight), else toward the far part.
function desired(r: Rect, side: Side, far: Rect): { v: number; straight: boolean } {
  const pad = 14;
  if (vert(side)) {
    const ov = overlap(r.x + pad, r.x + r.w - pad, far.x + pad, far.x + far.w - pad);
    if (ov) return { v: (ov[0] + ov[1]) / 2, straight: true };
    return { v: Math.min(Math.max(cx(far), r.x + pad), r.x + r.w - pad), straight: false };
  }
  const ov = overlap(r.y + pad, r.y + r.h - pad, far.y + pad, far.y + far.h - pad);
  if (ov) return { v: (ov[0] + ov[1]) / 2, straight: true };
  return { v: Math.min(Math.max(cy(far), r.y + pad), r.y + r.h - pad), straight: false };
}

function portPoint(r: Rect, side: Side, v: number): Pt {
  if (side === 't') return [v, r.y];
  if (side === 'b') return [v, r.y + r.h];
  if (side === 'l') return [r.x, v];
  return [r.x + r.w, v];
}

type Port = { part: string; side: Side; v: number; order: number; io: 'o' | 'i'; fixed?: boolean; bus?: boolean; alt?: boolean };

// Spread the ports that share a side so no two lines touch.
function spreadPorts(ports: Port[], rects: Record<string, RouteRect>, dense = false): void {
  const groups = new Map<string, Port[]>();
  for (const p of ports) {
    const k = p.part + ':' + p.side;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  for (const list of groups.values()) {
    const r = rects[list[0]!.part]!, side = list[0]!.side;
    let lo = (vert(side) ? r.x : r.y) + 12, hi = (vert(side) ? r.x + r.w : r.y + r.h) - 12;
    // a part with a sheet inside wears its cue: ports keep 30 px off that corner
    if (r.bubble && side === 't') hi = Math.max(lo, hi - 30);
    if (r.bubble && side === 'r') lo = Math.min(hi, lo + 30);
    if (r.bubble) for (const p of list) p.v = Math.min(Math.max(p.v, lo), hi);
    if (list.length < 2) continue;
    // dense sheets: the lines leaving one side share one port, and the lines
    // entering it share another, so they leave and arrive as one trunk
    if (dense && !list.some((p) => p.fixed)) {
      const med = (xs: Port[]) => {
        const s = xs.map((p) => p.v).sort((a, b) => a - b);
        return s[Math.floor((s.length - 1) / 2)]!;
      };
      const outs = list.filter((p) => p.io !== 'i'), ins = list.filter((p) => p.io === 'i');
      let vo = outs.length ? med(outs) : null, vi = ins.length ? med(ins) : null;
      if (vo !== null && vi !== null && Math.abs(vo - vi) < PORT_GAP * 2) {
        const m = (vo + vi) / 2, sgn = vo <= vi ? -1 : 1;
        vo = m + sgn * PORT_GAP;
        vi = m - sgn * PORT_GAP;
      }
      const cl = (v: number) => Math.min(Math.max(v, lo), hi);
      for (const p of outs) p.v = cl(vo!);
      for (const p of ins) p.v = cl(vi!);
      continue;
    }
    list.sort((a, b) => a.v - b.v || a.order - b.order);
    for (let i = 1; i < list.length; i++) if (list[i]!.v < list[i - 1]!.v + PORT_GAP) list[i]!.v = list[i - 1]!.v + PORT_GAP;
    const over = list[list.length - 1]!.v - hi;
    if (over > 0) for (const p of list) p.v -= over;
    for (let i = 0; i < list.length; i++) list[i]!.v = Math.max(list[i]!.v, lo + i * PORT_GAP);
  }
}

// ------------------------------------------------------------------ grid
type HeapItem = { s: number; f: number; c: number };
class Heap {
  a: HeapItem[] = [];
  push(x: HeapItem) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): HeapItem {
    const a = this.a, top = a[0]!, last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

type Grid = {
  X: number[]; Y: number[]; nx: number; ny: number;
  nodeFree: Uint8Array; hFree: Uint8Array; vFree: Uint8Array; hUsed: Uint16Array; vUsed: Uint16Array;
  hPos: Uint16Array; hNeg: Uint16Array; vPos: Uint16Array; vNeg: Uint16Array;
  hOut: Uint8Array; vOut: Uint8Array; hStrip: Uint8Array; hBand: Uint8Array; hEdge: Uint8Array; vEdge: Uint8Array;
  bandIndex: Record<string, number>; dense: boolean; only: boolean;
};

function buildGrid(obstacles: Rect[], extraX: number[], extraY: number[], bounds: Bounds, ctx: RouteCtx = {}): Grid {
  const xs = new Set<number>(ctx.only ? [] : [bounds.x0, bounds.x1]), ys = new Set<number>(ctx.only ? [] : [bounds.y0, bounds.y1]);
  const inf = obstacles.map((o) => ({ x0: o.x - INFLATE, y0: o.y - INFLATE, x1: o.x + o.w + INFLATE, y1: o.y + o.h + INFLATE }));
  if (!ctx.only) {
    for (const o of inf) {
      xs.add(o.x0); xs.add(o.x1); ys.add(o.y0); ys.add(o.y1);
    }
    // channel centres: midway between neighbouring obstacle edges
    const addMids = (set: Set<number>) => {
      const s = [...set].sort((a, b) => a - b);
      for (let i = 0; i < s.length - 1; i++) if (s[i + 1]! - s[i]! > 24) set.add(Math.round((s[i]! + s[i + 1]!) / 2));
    };
    addMids(xs);
    addMids(ys);
  }
  extraX.forEach((v) => xs.add(v));
  extraY.forEach((v) => ys.add(v));
  const X = [...xs].filter((v) => v >= bounds.x0 && v <= bounds.x1).sort((a, b) => a - b);
  const Y = [...ys].filter((v) => v >= bounds.y0 && v <= bounds.y1).sort((a, b) => a - b);
  const inside = (x: number, y: number) => inf.some((o) => x > o.x0 + 0.01 && x < o.x1 - 0.01 && y > o.y0 + 0.01 && y < o.y1 - 0.01);
  const nx = X.length, ny = Y.length;
  const nodeFree = new Uint8Array(nx * ny);
  const hFree = new Uint8Array(nx * ny), vFree = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      nodeFree[k] = inside(X[i]!, Y[j]!) ? 0 : 1;
      if (i < nx - 1) hFree[k] = inside((X[i]! + X[i + 1]!) / 2, Y[j]!) ? 0 : 1;
      if (j < ny - 1) vFree[k] = inside(X[i]!, (Y[j]! + Y[j + 1]!) / 2) ? 0 : 1;
    }
  // per segment: outside the envelope; in a wrapped band's row strip (band
  // index + 1); inside a band's box (band index + 1)
  const hOut = new Uint8Array(nx * ny), vOut = new Uint8Array(nx * ny);
  const hStrip = new Uint8Array(nx * ny), hBand = new Uint8Array(nx * ny);
  const env = ctx.env ? { x0: ctx.env.x0 - ENV_PAD, y0: ctx.env.y0 - ENV_PAD, x1: ctx.env.x1 + ENV_PAD, y1: ctx.env.y1 + ENV_PAD } : null;
  const outside = (x: number, y: number) => !!env && (x < env.x0 || x > env.x1 || y < env.y0 || y > env.y1);
  const boxes = ctx.bandBoxes ?? [];
  const bandIx = (x: number, y: number) => {
    for (let q = 0; q < boxes.length; q++) {
      const b = boxes[q]!;
      if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return q + 1;
    }
    return 0;
  };
  const bandIndex: Record<string, number> = Object.fromEntries(boxes.map((b, q) => [b.id, q + 1]));
  const strips = (ctx.strips ?? []).map((st) => ({ ...st, b: bandIndex[st.band] ?? 0 }));
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      if (i < nx - 1) {
        const mx = (X[i]! + X[i + 1]!) / 2;
        hOut[k] = outside(mx, Y[j]!) ? 1 : 0;
        const st = strips.find((q) => mx > q.x0 && mx < q.x1 && Y[j]! > q.y0 + 0.5 && Y[j]! < q.y1 - 0.5);
        hStrip[k] = st ? st.b : 0;
        hBand[k] = bandIx(mx, Y[j]!);
      }
      if (j < ny - 1) vOut[k] = outside(X[i]!, (Y[j]! + Y[j + 1]!) / 2) ? 1 : 0;
    }
  // a run that lies along a band's edge (within EDGE_NEAR) reads as the edge
  // itself; it pays EDGE_K per pixel, so the line keeps clear of it
  const hEdge = new Uint8Array(nx * ny), vEdge = new Uint8Array(nx * ny);
  if (!ctx.dense)
    for (const bb of boxes) {
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) {
          const k = i * ny + j;
          if (i < nx - 1) {
            const mx = (X[i]! + X[i + 1]!) / 2;
            if (mx > bb.x0 && mx < bb.x1 && (Math.abs(Y[j]! - bb.y0) < EDGE_NEAR || Math.abs(Y[j]! - bb.y1) < EDGE_NEAR)) hEdge[k] = 1;
          }
          if (j < ny - 1) {
            const my = (Y[j]! + Y[j + 1]!) / 2;
            if (my > bb.y0 && my < bb.y1 && (Math.abs(X[i]! - bb.x0) < EDGE_NEAR || Math.abs(X[i]! - bb.x1) < EDGE_NEAR)) vEdge[k] = 1;
          }
        }
    }
  // channel mode (dense sheets): inside a band a line runs across only on the
  // strip between its rows, and up or down only in that band's risers
  if (ctx.only) {
    const stripY = new Set(strips.map((q) => Math.round((q.y0 + q.y1) / 2)));
    const riserOf: Record<string, Set<number>> = {};
    for (const r of ctx.risers ?? []) (riserOf[r.band] ??= new Set()).add(r.x);
    const boxAt = (x: number, y: number) => boxes.find((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const k = i * ny + j;
        if (i < nx - 1 && hFree[k]) {
          const b = boxAt((X[i]! + X[i + 1]!) / 2, Y[j]!);
          if (b && !stripY.has(Y[j]!)) hFree[k] = 0;
        }
        if (j < ny - 1 && vFree[k]) {
          const b = boxAt(X[i]!, (Y[j]! + Y[j + 1]!) / 2);
          if (b && !riserOf[b.id]?.has(X[i]!)) vFree[k] = 0;
        }
      }
  }
  const n = nx * ny;
  return {
    X, Y, nx, ny, nodeFree, hFree, vFree, hUsed: new Uint16Array(n), vUsed: new Uint16Array(n),
    hPos: new Uint16Array(n), hNeg: new Uint16Array(n), vPos: new Uint16Array(n), vNeg: new Uint16Array(n),
    hOut, vOut, hStrip, hBand, hEdge, vEdge, bandIndex, dense: !!ctx.dense, only: !!ctx.only,
  };
}

const DIRS: Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

type Start = { i: number; j: number; dir: number; c: number; port?: Pt };
type Goal = { i: number; j: number; extra: number; dir: number; port: Pt; ent?: Entry };
type Rc = { ends: Set<number>; members: Set<number> };

// A* over (node, heading). Several start nodes and several goal nodes are
// allowed: a line may leave or enter anywhere along a side, paying a little
// for each pixel it moves away from its preferred port.
function astar(g: Grid, starts: Start[], goals: Map<number, Goal>, rc?: Rc): Pt[] | null {
  const ends = rc?.ends ?? new Set<number>(), members = rc?.members ?? new Set<number>();
  const { nx, ny, X, Y } = g;
  // a state is (node, heading, bends so far capped at 3); the bend count only
  // matters where THIRD is on
  const NB = THIRD && !g.dense ? 4 : 1;
  const N = nx * ny * 4 * NB;
  const best = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const gl = [...goals.values()];
  const h = (i: number, j: number) => Math.min(...gl.map((q) => Math.abs(X[i]! - X[q.i]!) + Math.abs(Y[j]! - Y[q.j]!)));
  const heap = new Heap();
  for (const s of starts) {
    const s0 = ((s.i * ny + s.j) * 4 + s.dir) * NB;
    if (s.c < best[s0]!) {
      best[s0] = s.c;
      heap.push({ s: s0, f: s.c + h(s.i, s.j), c: s.c });
    }
  }
  let found: { s: number; total: number } | null = null;
  while (heap.size) {
    const cur = heap.pop();
    if (cur.c > best[cur.s]!) continue;
    if (found && cur.f >= found.total) break;
    const nb = cur.s % NB, ds = (cur.s - nb) / NB;
    const d = ds & 3, k = ds >> 2, i = Math.floor(k / ny), j = k % ny;
    const goal = goals.get(k);
    if (goal) {
      const fin = d === goal.dir ? 0 : 2;
      const total = cur.c + goal.extra + fin * BEND + (NB > 1 ? Math.max(0, nb + fin - 2) * THIRD : 0);
      if (!found || total < found.total) found = { s: cur.s, total };
    }
    for (let nd = 0; nd < 4; nd++) {
      const [di, dj] = DIRS[nd]!;
      if (nd === (d ^ 1)) continue; // no reversing
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = ni * ny + nj;
      if (!g.nodeFree[nk] && !goals.has(nk)) continue;
      let segFree: number, used: number, len: number, kk: number, same = 0, opp = 0;
      if (dj === 0) {
        kk = Math.min(i, ni) * ny + j;
        segFree = g.hFree[kk]!;
        used = g.hUsed[kk]!;
        len = Math.abs(X[ni]! - X[i]!);
      } else {
        kk = i * ny + Math.min(j, nj);
        segFree = g.vFree[kk]!;
        used = g.vUsed[kk]!;
        len = Math.abs(Y[nj]! - Y[j]!);
      }
      if (!segFree) continue;
      // the strip between a wrapped band's rows: closed to other lines, except
      // on channels, where a line may hop across it from one riser to the next
      // when the two rows' risers do not line up (a last resort)
      let hop = 0;
      if (dj === 0 && g.hStrip[kk] && !members.has(g.hStrip[kk]!)) {
        if (!g.only) continue;
        hop = STRIP_HOP + len * 4;
      }
      const nb2 = Math.min(NB - 1, nb + (nd !== d ? 1 : 0));
      let c = cur.c + (nd !== d ? BEND + (NB > 1 && nb >= 2 ? THIRD : 0) : 0) + hop;
      if (g.dense) {
        if (dj === 0) {
          same = di > 0 ? g.hPos[kk]! : g.hNeg[kk]!;
          opp = di > 0 ? g.hNeg[kk]! : g.hPos[kk]!;
        } else {
          same = dj > 0 ? g.vPos[kk]! : g.vNeg[kk]!;
          opp = dj > 0 ? g.vNeg[kk]! : g.vPos[kk]!;
        }
        c += same ? len * BUNDLE : len + (opp ? OPPOSE : 0);
        // inside a band: closed-ish to lines that do not end there; lines that do
        // end there still prefer the gutter over the band's label strip
        if (dj === 0 && g.hBand[kk] && !members.has(g.hBand[kk]!)) c += len * (ends.has(g.hBand[kk]!) ? 1 : BAND_K);
      } else c += len + used * (SHARE * len + 30);
      if (dj === 0 ? g.hOut[kk] : g.vOut[kk]) c += len * OUT_K + OUT_C;
      if (dj === 0 ? g.hEdge[kk] : g.vEdge[kk]) c += len * EDGE_K;
      if (dj === 0 ? g.vUsed[nk] || (nj > 0 && g.vUsed[ni * ny + nj - 1]) : g.hUsed[nk] || (ni > 0 && g.hUsed[(ni - 1) * ny + nj])) c += CROSS;
      const ns = (nk * 4 + nd) * NB + nb2;
      if (c < best[ns]!) {
        best[ns] = c;
        prev[ns] = cur.s;
        heap.push({ s: ns, f: c + h(ni, nj), c });
      }
    }
  }
  if (!found) return null;
  const out: Pt[] = [];
  let s = found.s;
  while (s >= 0) {
    const kk = Math.floor(s / NB) >> 2;
    out.push([X[Math.floor(kk / ny)]!, Y[kk % ny]!]);
    s = prev[s]!;
  }
  return out.reverse();
}

function markUsed(g: Grid, pts: Pt[]): void {
  for (let p = 0; p < pts.length - 1; p++) {
    const [x0, y0] = pts[p]!, [x1, y1] = pts[p + 1]!;
    if (y0 === y1) {
      const j = g.Y.indexOf(y0);
      let a = g.X.indexOf(Math.min(x0, x1));
      const b = g.X.indexOf(Math.max(x0, x1));
      if (j < 0 || a < 0 || b < 0) continue;
      const dir = x1 > x0 ? g.hPos : g.hNeg;
      for (; a < b; a++) {
        g.hUsed[a * g.ny + j]!++;
        dir[a * g.ny + j]!++;
      }
    } else {
      const i = g.X.indexOf(x0);
      let a = g.Y.indexOf(Math.min(y0, y1));
      const b = g.Y.indexOf(Math.max(y0, y1));
      if (i < 0 || a < 0 || b < 0) continue;
      const dir = y1 > y0 ? g.vPos : g.vNeg;
      for (; a < b; a++) {
        g.vUsed[i * g.ny + a]!++;
        dir[i * g.ny + a]!++;
      }
    }
  }
}

/** Drops repeated points and the middle of any three collinear points. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && l[0] === p[0] && l[1] === p[1]) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3) as [Pt, Pt, Pt];
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

const dirIndex = (side: Side) => ({ r: 0, l: 1, b: 2, t: 3 })[side];
const inward = (side: Side) => ({ r: 1, l: 0, b: 3, t: 2 })[side]; // direction of travel when entering by that side

type Plan =
  | { e: RouteEdge; kind: 'one'; pa: Port; pb: Port; multi: boolean }
  | { e: RouteEdge; kind: 'bus'; sp: Port[]; pb: Port; fs: Side; box: Bounds };

// ------------------------------------------------------------------ main
/** Routes every line. Returns a map from line id to its polyline (`pts`) and, for a bus, its extra runs (`paths`). */
export function routeAll(
  edges: RouteEdge[],
  rects: Record<string, RouteRect>,
  obstacles: Rect[],
  bounds: Bounds,
  containerOf: Record<string, Rect | undefined> = {},
  ctx: RouteCtx = {},
): Record<string, Routed> {
  if (ctx.dense && ctx.channels) {
    const { out, failed } = routeChannels(edges, rects, obstacles, bounds, ctx);
    if (failed.length) {
      // a line the channels cannot carry falls back to the open grid, source by source
      const again = [...new Set(failed.map((f) => f.e))].map((e) => ({ ...e, from: failed.filter((f) => f.e === e).map((f) => f.a) }));
      const rest = routeAll(again, rects, obstacles, bounds, containerOf, { ...ctx, channels: null });
      for (const [id, r] of Object.entries(rest)) {
        const have = out[id];
        if (!have) out[id] = r;
        else (have.paths ??= []).push(r.pts, ...(r.paths ?? []));
      }
    }
    return out;
  }
  const dense = !!ctx.dense;
  const heads = ctx.heads ?? [];
  const out: Record<string, Routed> = {};
  const all = Object.values(rects);
  const ports: Port[] = [];
  const plans: Plan[] = [];
  let order = 0;

  for (const e of edges) {
    const tR = rects[e.to];
    const srcs = e.from.filter((s) => rects[s]);
    if (!tR || !srcs.length) continue;
    // on a dense sheet a many-to-one line is routed source by source; the
    // shared entry port and the bundling make its trunk, through the gutters
    if (srcs.length === 1 || dense) {
      for (const src of srcs) {
        const sR = rects[src]!;
        const [fs, ts] = sidesFor(sR, tR, all);
        const a = desired(sR, fs, tR), b = desired(tR, ts, sR);
        const pa: Port = { part: src, side: fs, v: a.v, order: order++, io: 'o' };
        const pb: Port = { part: e.to, side: ts, v: b.v, order: order++, io: e.both ? 'o' : 'i' };
        if (a.straight && b.straight) pb.v = pa.v;
        ports.push(pa, pb);
        plans.push({ e, kind: 'one', pa, pb, multi: srcs.length > 1 });
      }
    } else {
      // a bus: the sources share a trunk on their side, one drop reaches the target
      const box = srcs
        .map((s) => rects[s]!)
        .reduce((m, r) => ({ x0: Math.min(m.x0, r.x), y0: Math.min(m.y0, r.y), x1: Math.max(m.x1, r.x + r.w), y1: Math.max(m.y1, r.y + r.h) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
      const bR = { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
      const [fs, ts] = sidesFor(bR, tR, all.filter((r) => !srcs.some((x) => rects[x] === r)));
      // a source's stub to the trunk keeps off band and split labels on its way
      const sp: Port[] = srcs.map((s) => ({ part: s, side: fs, v: clearOfHeads(rects[s]!, fs, vert(fs) ? cx(rects[s]!) : cy(rects[s]!), heads), order: order++, io: 'o', fixed: true }));
      // the drop leaves the trunk at the source closest to the target's middle, if it lines up
      const pad = 14;
      const lo = vert(ts) ? tR.x + pad : tR.y + pad, hi = vert(ts) ? tR.x + tR.w - pad : tR.y + tR.h - pad;
      const mid = (lo + hi) / 2;
      const inRange = sp.filter((p) => p.v >= lo && p.v <= hi).sort((a, b) => Math.abs(a.v - mid) - Math.abs(b.v - mid));
      const pb: Port = {
        part: e.to, side: ts, order: order++, bus: true, io: 'i',
        v: inRange.length ? inRange[0]!.v : Math.min(Math.max(sp.reduce((s, p) => s + p.v, 0) / sp.length, lo), hi),
      };
      ports.push(...sp, pb);
      plans.push({ e, kind: 'bus', sp, pb, fs, box });
    }
  }
  spreadPorts(ports, rects, dense);

  // routing grid: obstacle edges plus every port and stub coordinate
  const ex: number[] = [], ey: number[] = [];
  const stubOf = (p: Port) => {
    const pt = portPoint(rects[p.part]!, p.side, p.v);
    const [dx, dy] = DIR[p.side];
    return { pt, stub: [pt[0] + dx * STUB, pt[1] + dy * STUB] as Pt };
  };
  for (const p of ports) {
    const { pt, stub } = stubOf(p);
    ex.push(pt[0], stub[0]);
    ey.push(pt[1], stub[1]);
  }
  const trunks = new Map<Plan, number>();
  for (const pl of plans)
    if (pl.kind === 'bus') {
      const { fs, box } = pl;
      let t = fs === 'b' ? box.y1 + STUB : fs === 't' ? box.y0 - STUB : fs === 'r' ? box.x1 + STUB : box.x0 - STUB;
      // when every source sits in one band or column, the trunk runs just outside
      // it, in the gutter, not through the band's label strip
      const cs = pl.sp.map((p) => containerOf[p.part]);
      const c = cs[0];
      if (c && cs.every((x) => x === c)) {
        if (fs === 't') t = Math.min(t, c.y - 14);
        else if (fs === 'b') t = Math.max(t, c.y + c.h + 14);
        else if (fs === 'l') t = Math.min(t, c.x - 14);
        else t = Math.max(t, c.x + c.w + 14);
      }
      trunks.set(pl, t);
      if (vert(fs)) ey.push(t);
      else ex.push(t);
    }
  for (const x of ctx.risers ?? []) ex.push(x.x);
  const g = buildGrid(obstacles, ex, ey, bounds, ctx);
  // which bands a line may run along inside: the bands of its ends; the strip
  // between a wrapped band's rows only when both ends are in that band
  const bandOfPart = (id: string) => g.bandIndex[rects[id]?.band ?? ''] ?? 0;
  const rcOf = (aId: string, bId: string): Rc => {
    const a = bandOfPart(aId), b = bandOfPart(bId);
    return { ends: new Set([a, b].filter(Boolean)), members: new Set(a && a === b ? [a] : []) };
  };
  const idx = (v: number, arr: number[]) => {
    let b = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i]! - v) < Math.abs(arr[b]! - v)) b = i;
    return b;
  };

  // the stub line of a side: every grid node along it, inside the side's span
  // (8 px from the corners, so a line can still reach the strip of a side that
  // a shorter neighbour leaves open, with two bends instead of three)
  const SIDE_PAD = 8;
  const sideNodes = (p: Port) => {
    const r = rects[p.part]!, [dx, dy] = DIR[p.side];
    const out: { i: number; j: number; along: number; port: Pt }[] = [];
    if (vert(p.side)) {
      const y = (p.side === 't' ? r.y : r.y + r.h) + dy * STUB, j = idx(y, g.Y);
      g.X.forEach((x, i) => {
        if (x >= r.x + SIDE_PAD && x <= r.x + r.w - SIDE_PAD) out.push({ i, j, along: x, port: [x, p.side === 't' ? r.y : r.y + r.h] });
      });
    } else {
      const x = (p.side === 'l' ? r.x : r.x + r.w) + dx * STUB, i = idx(x, g.X);
      g.Y.forEach((y, j) => {
        if (y >= r.y + SIDE_PAD && y <= r.y + r.h - SIDE_PAD) out.push({ i, j, along: y, port: [p.side === 'l' ? r.x : r.x + r.w, y] });
      });
    }
    return out;
  };
  const DRIFT = 0.6; // cost per pixel away from the preferred port
  const goalsFor = (p: Port) => {
    const m = new Map<number, Goal>();
    for (const n of sideNodes(p)) m.set(n.i * g.ny + n.j, { i: n.i, j: n.j, extra: Math.abs(n.along - p.v) * DRIFT, dir: inward(p.side), port: n.port });
    return m;
  };
  const finish = (pts: Pt[], goals: Map<number, Goal>): Pt[] => {
    const last = pts[pts.length - 1]!;
    const q = goals.get(idx(last[0], g.X) * g.ny + idx(last[1], g.Y));
    return q ? [...pts, q.port] : pts;
  };
  const routeBetween = (from: Pt, fromSide: Side, toPort: Port, rc: Rc): Pt[] => {
    const goals = goalsFor(toPort);
    const si = idx(from[0], g.X), sj = idx(from[1], g.Y);
    const r = astar(g, [{ i: si, j: sj, dir: dirIndex(fromSide), c: 0 }], goals, rc);
    const t = stubOf(toPort);
    if (!r) return [from, [t.stub[0], from[1]], t.stub, t.pt];
    return finish(r, goals);
  };
  // the facing side is preferred; the two sides beside it are allowed at a cost,
  // so a line can step around a crowded band instead of threading it
  const SIDE_COST = 90;
  // two lines never leave or enter a part at one point (they would run
  // together and their words would sit across each other); an end within
  // PORT_GAP of a taken one pays TAKEN
  const TAKEN = 400;
  const ends: { part: string; pt: Pt }[] = [];
  const takenCost = (part: string, pt: Pt) =>
    dense ? 0 : ends.some((q) => q.part === part && Math.abs(q.pt[0] - pt[0]) + Math.abs(q.pt[1] - pt[1]) < PORT_GAP) ? TAKEN : 0;
  const PERP: Record<Side, Side[]> = { t: ['l', 'r'], b: ['l', 'r'], l: ['t', 'b'], r: ['t', 'b'] };
  const altPorts = (p: Port, far: string): Port[] => [
    p,
    ...PERP[p.side].filter((sd) => !blocked(rects[p.part]!, sd, all)).map((sd) => ({ ...p, side: sd, v: desired(rects[p.part]!, sd, rects[far]!).v, alt: true })),
  ];
  const routeSides = (pa: Port, pb: Port): Pt[] | null => {
    const starts: Start[] = [];
    for (const q of altPorts(pa, pb.part)) {
      for (const n of sideNodes(q))
        starts.push({ i: n.i, j: n.j, dir: dirIndex(q.side), c: Math.abs(n.along - q.v) * DRIFT + (q.alt ? SIDE_COST : 0) + takenCost(pa.part, n.port), port: n.port });
    }
    const goals = new Map<number, Goal>();
    for (const q of altPorts(pb, pa.part)) {
      for (const [k, gq] of goalsFor(q)) {
        gq.extra += (q.alt ? SIDE_COST : 0) + takenCost(pb.part, gq.port);
        if (!goals.has(k) || goals.get(k)!.extra > gq.extra) goals.set(k, gq);
      }
    }
    const r = astar(g, starts, goals, rcOf(pa.part, pb.part));
    if (!r) return null;
    const first = r[0]!;
    const st = starts.filter((s0) => g.X[s0.i] === first[0] && g.Y[s0.j] === first[1]).sort((a, b) => a.c - b.c)[0];
    return finish([st?.port ?? first, ...r], goals);
  };

  // shortest first, so the long lines bend around the settled short ones; a
  // bus's trunk is fixed, so it is laid first and the other lines keep off it
  const len = (pl: Plan) => {
    if (pl.kind === 'bus') return dense ? 1e6 : -1;
    const a = portPoint(rects[pl.pa.part]!, pl.pa.side, pl.pa.v), b = portPoint(rects[pl.pb.part]!, pl.pb.side, pl.pb.v);
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  };
  plans.sort((a, b) => len(a) - len(b));

  for (const pl of plans) {
    if (pl.kind === 'one') {
      const s = stubOf(pl.pa);
      const pts = simplify(routeSides(pl.pa, pl.pb) ?? [s.pt, ...routeBetween(s.stub, pl.pa.side, pl.pb, rcOf(pl.pa.part, pl.pb.part))]);
      markUsed(g, pts.slice(1, -1));
      ends.push({ part: pl.pa.part, pt: pts[0]! }, { part: pl.pb.part, pt: pts[pts.length - 1]! });
      const have = out[pl.e.id];
      if (pl.multi && have) (have.paths ??= []).push(pts);
      else out[pl.e.id] = { pts };
    } else {
      const t = trunks.get(pl)!, fs = pl.fs;
      const stubs: Pt[][] = pl.sp.map((p) => {
        const pt = portPoint(rects[p.part]!, p.side, p.v);
        return [pt, vert(fs) ? [pt[0], t] : [t, pt[1]]];
      });
      const along = stubs.map((s) => (vert(fs) ? s[1]![0] : s[1]![1]));
      const dropV = pl.pb.v;
      const lo = Math.min(...along, dropV), hi = Math.max(...along, dropV);
      const trunk: Pt[] = vert(fs) ? [[lo, t], [hi, t]] : [[t, lo], [t, hi]];
      const tp = portPoint(rects[pl.pb.part]!, pl.pb.side, pl.pb.v);
      const start: Pt = vert(fs) ? [dropV, t] : [t, dropV];
      const straight = vert(fs) ? vert(pl.pb.side) : !vert(pl.pb.side);
      const drop = straight ? [start, tp] : simplify([start, ...routeBetween(start, fs, pl.pb, rcOf(pl.sp[0]!.part, pl.pb.part))]);
      const paths = [...stubs, trunk];
      pl.sp.forEach((p, i) => ends.push({ part: p.part, pt: stubs[i]![0]! }));
      ends.push({ part: pl.pb.part, pt: drop[drop.length - 1]! });
      for (const p of paths) markUsed(g, p);
      markUsed(g, drop);
      out[pl.e.id] = { paths, pts: drop };
    }
  }
  if (dense) nudgeBundles(out);
  else nudge(out);
  return out;
}

// A bus source's port along its side, moved off any band or split label that
// sits between the side and the gutter the stub runs to.
function clearOfHeads(r: Rect, side: Side, v: number, heads: Rect[]): number {
  if (!vert(side)) return v;
  const reach = 70;
  const ivs = heads
    .filter((h) => (side === 't' ? h.y + h.h > r.y - reach && h.y < r.y : h.y < r.y + r.h + reach && h.y + h.h > r.y + r.h))
    .map((h): [number, number] => [h.x - 10, h.x + h.w + 10])
    .filter(([a, b]) => b > r.x && a < r.x + r.w);
  const lo = r.x + 12, hi = r.x + r.w - 12;
  const bad = (x: number) => ivs.some(([a, b]) => x > a && x < b);
  if (!bad(v)) return v;
  const cands = [lo, hi, ...ivs.flatMap(([a, b]) => [a, b])].filter((x) => x >= lo && x <= hi && !bad(x));
  return cands.length ? cands.sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0]! : v;
}

type Seg = { id: string; i: number; p: Pt[]; horiz?: boolean; dir?: number; lo?: number; hi?: number; track?: number };
const shift = (s: Seg, horiz: boolean, off: number) => {
  const a = s.p[s.i]!, b = s.p[s.i + 1]!;
  if (horiz) {
    s.p[s.i] = [a[0], a[1] + off];
    s.p[s.i + 1] = [b[0], b[1] + off];
  } else {
    s.p[s.i] = [a[0] + off, a[1]];
    s.p[s.i + 1] = [b[0] + off, b[1]];
  }
};

// Dense sheets: runs of different lines along one gutter line that travel the
// same way merge into one trunk (they share a track); trunks that overlap get
// tracks TRACK apart by interval colouring, ordered by direction so the two
// ways never swap sides along a gutter.
function nudgeBundles(routes: Record<string, Routed>): void {
  const segs: Seg[] = [];
  for (const [id, r] of Object.entries(routes)) {
    for (const p of [r.pts, ...(r.paths ?? [])]) for (let i = 1; i < p.length - 2; i++) segs.push({ id, i, p });
  }
  const groups = new Map<string, Seg[]>();
  for (const s of segs) {
    const a = s.p[s.i]!, b = s.p[s.i + 1]!;
    const k = a[1] === b[1] ? 'h' + a[1] : a[0] === b[0] ? 'v' + a[0] : null;
    if (!k) continue;
    s.horiz = k[0] === 'h';
    s.dir = s.horiz ? Math.sign(b[0] - a[0]) : Math.sign(b[1] - a[1]);
    s.lo = s.horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
    s.hi = s.horiz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  type Bundle = { dir: number; lo: number; hi: number; segs: Seg[]; track?: number };
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // trunks: same direction, overlapping or touching
    const bundles: Bundle[] = [];
    for (const dir of [-1, 1]) {
      const own = list.filter((s) => s.dir === dir).sort((a, b) => a.lo! - b.lo!);
      let cur: Bundle | null = null;
      for (const s of own) {
        if (cur && s.lo! <= cur.hi + 1) {
          cur.segs.push(s);
          cur.hi = Math.max(cur.hi, s.hi!);
        } else {
          cur = { dir, lo: s.lo!, hi: s.hi!, segs: [s] };
          bundles.push(cur);
        }
      }
    }
    if (bundles.length < 2) continue;
    bundles.sort((a, b) => a.dir - b.dir || a.lo - b.lo);
    const tracks: { hi: number; dir: number }[] = [];
    for (const bu of bundles) {
      let t = tracks.findIndex((end) => end.hi < bu.lo - 2 && end.dir === bu.dir);
      if (t < 0) t = tracks.findIndex((end) => end.hi < bu.lo - 2);
      if (t < 0) {
        t = tracks.length;
        tracks.push({ hi: bu.hi, dir: bu.dir });
      } else tracks[t] = { hi: bu.hi, dir: bu.dir };
      bu.track = t;
    }
    if (tracks.length < 2) continue;
    // a riser is narrower than a gutter: its tracks squeeze to stay inside it
    const horiz = !!list[0]!.horiz;
    const room = horiz ? 26 : 11;
    const step = Math.min(TRACK, (2 * room) / (tracks.length - 1));
    for (const bu of bundles) {
      const off = (bu.track! - (tracks.length - 1) / 2) * step;
      for (const s of bu.segs) shift(s, horiz, off);
    }
  }
}

// Spread collinear runs of different lines that overlap onto 8 px tracks.
function nudge(routes: Record<string, Routed>): void {
  const segs: Seg[] = [];
  for (const [id, r] of Object.entries(routes)) {
    const p = r.pts;
    for (let i = 1; i < p.length - 2; i++) segs.push({ id, i, p });
  }
  const key = (s: Seg) => {
    const a = s.p[s.i]!, b = s.p[s.i + 1]!;
    return a[1] === b[1] ? 'h' + a[1] : a[0] === b[0] ? 'v' + a[0] : null;
  };
  const groups = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = key(s);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const horiz = k[0] === 'h';
    const span = (s: Seg): [number, number] => {
      const a = s.p[s.i]!, b = s.p[s.i + 1]!;
      return horiz ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    };
    // interval colouring: overlapping runs take successive tracks
    list.sort((a, b) => span(a)[0] - span(b)[0]);
    const tracks: number[] = [];
    for (const s of list) {
      const [lo, hi] = span(s);
      let t = tracks.findIndex((end) => end < lo - 2);
      if (t < 0) {
        t = tracks.length;
        tracks.push(hi);
      } else tracks[t] = hi;
      s.track = t;
    }
    if (tracks.length < 2) continue;
    for (const s of list) shift(s, horiz, (s.track! - (tracks.length - 1) / 2) * 8);
  }
}

// ------------------------------------------------------------------ channels
// Dense sheets route the way a person lays out a big block diagram: on
// channels only (the gutter between two bands, the strip between a wrapped
// band's rows, the risers between columns, the lane beside a side column).
// Every part side has two fixed slots, one for lines leaving and one for lines
// arriving, so a box has at most four connection points and the lines into a
// side meet there as one trunk with one arrowhead. After the search each
// channel carries two lanes, one per direction (rightward above leftward,
// downward left of upward), and every run in a lane shares it. Corners are
// rebuilt from the lanes, so a run meets a bend in one right angle.
const SLOT = 8, LANE = 7, NEWSLOT = 40, SLOTS_MAX = 4, SIDE_COST_C = 90;

function slotCoord(r: Rect, side: Side, io: 'i' | 'o'): number {
  const cy0 = r.y + Math.min(r.h / 2, 27);
  // rightward travel uses the upper slot, leftward the lower; downward travel
  // the left slot, upward the right: a straight line between neighbours stays straight
  if (side === 'b') return Math.round(cx(r) + (io === 'o' ? -SLOT : SLOT));
  if (side === 't') return Math.round(cx(r) + (io === 'i' ? -SLOT : SLOT));
  if (side === 'r') return Math.round(cy0 + (io === 'o' ? -SLOT : SLOT));
  return Math.round(cy0 + (io === 'i' ? -SLOT : SLOT));
}

type Entry = { i: number; j: number; k: number; port: Pt; side: Side; io: 'i' | 'o'; id: string };
type End = { p: Pt[]; a: string; sa: Side; b: string; sb: Side; ib: 'i' | 'o' };

function routeChannels(edges: RouteEdge[], rects: Record<string, RouteRect>, obstacles: Rect[], bounds: Bounds, ctx: RouteCtx) {
  const ch = ctx.channels!;
  const stripYs = (ctx.strips ?? []).map((q) => Math.round((q.y0 + q.y1) / 2));
  const Ych = [...new Set([...ch.gutters, ...stripYs])].sort((a, b) => a - b);
  const Xch = [...new Set([...(ctx.risers ?? []).map((r) => r.x), ...ch.lanes])].sort((a, b) => a - b);
  const all = Object.values(rects);
  const jobs: { e: RouteEdge; a: string; b: string; multi: boolean }[] = [];
  for (const e of edges) {
    const srcs = e.from.filter((s) => rects[s]);
    if (!rects[e.to]) continue;
    for (const a of srcs) jobs.push({ e, a, b: e.to, multi: srcs.length > 1 });
  }
  const ex = [...Xch], ey = [...Ych];
  for (const id of new Set(jobs.flatMap((j) => [j.a, j.b]))) {
    const r = rects[id]!;
    for (const io of ['i', 'o'] as const) {
      ex.push(slotCoord(r, 't', io), slotCoord(r, 'b', io));
      ey.push(slotCoord(r, 'l', io), slotCoord(r, 'r', io));
    }
  }
  const g = buildGrid(obstacles, ex, ey, bounds, { ...ctx, only: true });
  const bandOf = (id: string) => g.bandIndex[rects[id]?.band ?? ''] ?? 0;
  const rcOf = (a: string, b: string): Rc => {
    const x = bandOf(a), y = bandOf(b);
    return { ends: new Set([x, y].filter(Boolean)), members: new Set(x && x === y ? [x] : []) };
  };
  const same = (o: Rect, r: Rect) => o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h;
  const clear = (p0: Pt, p1: Pt, r: Rect) => {
    const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]), y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
    return !obstacles.some((o) => !same(o, r) && x1 > o.x - 3 && x0 < o.x + o.w + 3 && y1 > o.y - 3 && y0 < o.y + o.h + 3);
  };
  // where a slot meets its channel: the nearest channel line in front of the side
  const entry = (id: string, side: Side, io: 'i' | 'o'): Entry | null => {
    const r = rects[id]!, v = slotCoord(r, side, io);
    let node: Pt, port: Pt;
    if (vert(side)) {
      const ys = side === 't' ? Ych.filter((y) => y < r.y - 6) : Ych.filter((y) => y > r.y + r.h + 6);
      if (!ys.length) return null;
      node = [v, side === 't' ? Math.max(...ys) : Math.min(...ys)];
      port = [v, side === 't' ? r.y : r.y + r.h];
    } else {
      const xs = side === 'l' ? Xch.filter((x) => x < r.x - 6) : Xch.filter((x) => x > r.x + r.w + 6);
      if (!xs.length) return null;
      node = [side === 'l' ? Math.max(...xs) : Math.min(...xs), v];
      port = [side === 'l' ? r.x : r.x + r.w, v];
    }
    // a slot only reaches the next channel, never past another part
    if (Math.abs(vert(side) ? node[1] - port[1] : node[0] - port[0]) > 80) return null;
    const i = g.X.indexOf(node[0]), j = g.Y.indexOf(node[1]);
    if (i < 0 || j < 0 || !g.nodeFree[i * g.ny + j] || !clear(port, node, r)) return null;
    return { i, j, k: i * g.ny + j, port, side, io, id };
  };
  const used: Record<string, Set<string>> = {};
  const slotCost = (id: string, side: Side, io: 'i' | 'o') => {
    const u = (used[id] ??= new Set());
    if (u.has(side + io)) return 0;
    return u.size >= SLOTS_MAX ? 1e5 : NEWSLOT;
  };
  const sideCost = (fac: Side, side: Side) => (side === fac ? 0 : vert(side) === vert(fac) ? SIDE_COST_C * 2 : SIDE_COST_C);
  const out: Record<string, Routed> = {};
  const failed: { e: RouteEdge; a: string }[] = [];
  const ends: End[] = [];
  const len = (j: { a: string; b: string }) => Math.abs(cx(rects[j.a]!) - cx(rects[j.b]!)) + Math.abs(cy(rects[j.a]!) - cy(rects[j.b]!));
  jobs.sort((p, q) => len(p) - len(q));
  for (const job of jobs) {
    const [fs, ts] = sidesFor(rects[job.a]!, rects[job.b]!, all);
    const starts: Start[] = [], goals = new Map<number, Goal>(), sm = new Map<string, Entry>();
    const tio = job.e.both ? 'o' : 'i';
    for (const side of ['t', 'b', 'l', 'r'] as const) {
      const s0 = entry(job.a, side, 'o');
      if (s0) {
        starts.push({ i: s0.i, j: s0.j, dir: dirIndex(side), c: sideCost(fs, side) + slotCost(job.a, side, 'o') });
        sm.set(s0.k + ':' + dirIndex(side), s0);
      }
      const t0 = entry(job.b, side, tio);
      if (t0) {
        const extra = sideCost(ts, side) + slotCost(job.b, side, tio);
        if (!goals.has(t0.k) || goals.get(t0.k)!.extra > extra) goals.set(t0.k, { i: t0.i, j: t0.j, extra, dir: inward(side), port: t0.port, ent: t0 });
      }
    }
    const path = starts.length && goals.size ? astar(g, starts, goals, rcOf(job.a, job.b)) : null;
    if (!path) {
      failed.push({ e: job.e, a: job.a });
      continue;
    }
    const first = path[0]!, last = path[path.length - 1]!;
    const s0 = [...sm.values()].filter((q) => g.X[q.i] === first[0] && g.Y[q.j] === first[1]).sort((p, q) => sideCost(fs, p.side) - sideCost(fs, q.side))[0]!;
    const t0 = goals.get(g.X.indexOf(last[0]) * g.ny + g.Y.indexOf(last[1]))!.ent!;
    used[job.a]!.add(s0.side + 'o');
    (used[job.b] ??= new Set()).add(t0.side + t0.io);
    const pts = simplify([s0.port, ...path, t0.port]);
    ends.push({ p: pts, a: job.a, sa: s0.side, b: job.b, sb: t0.side, ib: t0.io });
    markUsed(g, path);
    const have = out[job.e.id];
    if (job.multi && have) (have.paths ??= []).push(pts);
    else out[job.e.id] = { pts };
  }
  slotOrder(ends);
  laneOffsets(out, new Set(Xch), new Set(Ych));
  return { out, failed };
}

// A side's two slots swap when the lines leaving one slot and the lines
// arriving at the other would run on the same lane between them, which reads
// as a loop back into the part. A side with a straight line to a neighbour
// keeps its order, so that line stays straight.
function slotOrder(ends: End[]): void {
  type Use = { io: 'i' | 'o'; e: End; atStart: boolean };
  const sides = new Map<string, { side: Side; list: Use[] }>();
  const add = (part: string, side: Side, io: 'i' | 'o', e: End, atStart: boolean) => {
    const k = part + ':' + side;
    if (!sides.has(k)) sides.set(k, { side, list: [] });
    sides.get(k)!.list.push({ io, e, atStart });
  };
  for (const e of ends) {
    add(e.a, e.sa, 'o', e, true);
    add(e.b, e.sb, e.ib, e, false);
  }
  for (const { side, list } of sides.values()) {
    if (list.some((q) => q.e.p.length < 4)) continue;
    const outs = list.filter((q) => q.io === 'o'), ins = list.filter((q) => q.io === 'i');
    if (!outs.length || !ins.length) continue;
    const a = vert(side) ? 0 : 1; // the coordinate along the side
    // the travel direction along the lane next to the stub
    const dirOf = (q: Use) => {
      const p = q.e.p;
      const [u, w] = q.atStart ? [p[1]!, p[2]!] : [p[p.length - 3]!, p[p.length - 2]!];
      return Math.sign(w[a] - u[a]);
    };
    const endOf = (q: Use) => (q.atStart ? q.e.p[0]![a] : q.e.p[q.e.p.length - 1]![a]);
    const vo = endOf(outs[0]!), vi = endOf(ins[0]!);
    const clash = (o: number, i: number) => {
      let n = 0;
      for (const x of outs)
        for (const y of ins) {
          const d = dirOf(x);
          if (d && d === dirOf(y) && d * (i - o) > 0) n++;
        }
      return n;
    };
    if (clash(vi, vo) >= clash(vo, vi)) continue;
    for (const q of list) {
      const p = q.e.p, v = q.io === 'o' ? vi : vo;
      if (q.atStart) {
        p[0]![a] = v;
        p[1]![a] = v;
      } else {
        p[p.length - 1]![a] = v;
        p[p.length - 2]![a] = v;
      }
    }
  }
}

// Move every run on a channel onto its direction's lane and rebuild the
// corners from the lanes; the stubs at both ends stay on their slots.
function laneOffsets(routes: Record<string, Routed>, XS: Set<number>, YS: Set<number>): void {
  for (const r of Object.values(routes))
    for (const p of [r.pts, ...(r.paths ?? [])]) {
      const n = p.length;
      if (n < 4) continue;
      const off: number[] = [];
      for (let i = 0; i < n - 1; i++) {
        const a = p[i]!, b = p[i + 1]!;
        if (i === 0 || i === n - 2) off.push(0);
        else if (a[1] === b[1] && YS.has(a[1])) off.push(b[0] > a[0] ? -LANE : LANE);
        else if (a[0] === b[0] && XS.has(a[0])) off.push(b[1] > a[1] ? -LANE : LANE);
        else off.push(0);
      }
      const q = p.map((pt) => [pt[0], pt[1]] as Pt);
      for (let k = 1; k < n - 1; k++)
        for (const s of [k - 1, k]) {
          const a = p[s]!, b = p[s + 1]!;
          if (a[1] === b[1]) q[k]![1] = a[1] + off[s]!;
          else q[k]![0] = a[0] + off[s]!;
        }
      for (let k = 0; k < n; k++) p[k] = q[k]!;
    }
}
