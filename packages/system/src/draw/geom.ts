import type { Pt } from '../layout/types.ts';

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function roundedPath(pts: Pt[] | undefined, r = 7): string {
  if (!pts || pts.length < 2) return '';
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const l1 = Math.hypot(x - px, y - py);
    const l2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) {
      d += ` L${x},${y}`;
      continue;
    }
    const ax = x - ((x - px) / l1) * rr;
    const ay = y - ((y - py) / l1) * rr;
    const bx = x + ((nx - x) / l2) * rr;
    const by = y + ((ny - y) / l2) * rr;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  const l = pts[pts.length - 1]!;
  return d + ` L${l[0]},${l[1]}`;
}

export function arrowHead(pts: Pt[] | undefined, len = 9, wid = 3.6, atStart = false): string {
  if (!pts || pts.length < 2) return '';
  const [p, q] = atStart ? [pts[1]!, pts[0]!] : [pts[pts.length - 2]!, pts[pts.length - 1]!];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const bx = q[0] - ux * len;
  const by = q[1] - uy * len;
  return `M${q[0]},${q[1]} L${bx - uy * wid},${by + ux * wid} L${bx + uy * wid},${by - ux * wid} Z`;
}

export function trimEnd(pts: Pt[], d: number): Pt[] {
  if (!pts || pts.length < 2) return pts;
  const out = pts.map((p) => [p[0], p[1]] as Pt);
  const n = out.length - 1;
  const p = out[n - 1]!;
  const q = out[n]!;
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  out[n] = [q[0] - ((q[0] - p[0]) / L) * d, q[1] - ((q[1] - p[1]) / L) * d];
  return out;
}

export function midOf(pts: Pt[] | undefined): Pt {
  if (!pts || pts.length < 2) return [0, 0];
  let best = 0;
  let bi = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    if (L > best) {
      best = L;
      bi = i;
    }
  }
  return [(pts[bi]![0] + pts[bi + 1]![0]) / 2, (pts[bi]![1] + pts[bi + 1]![1]) / 2];
}
