// The Pebble: Shape's mark (the owner's pick: "six uneven lumps; the bottom
// rests on the table"). Lifted unchanged from the approved Shape prototype,
// so the outline is the approved one.
//
// While Shape mode is on it breathes: the six rim lumps drift and swell in
// turn, one slow cycle every 7 s, small enough to read as alive, not busy.
// While the board is being redrawn (`reshaping`) the same cycle runs at 1.6 s.
// Reduced motion: no morph at all; state shows as fill and colour only.
import { useEffect, useRef } from 'react';

const RIM: [number, number, number][] = [[-112, 0.42, 0.44], [-48, 0.47, 0.37], [12, 0.45, 0.4], [80, 0.36, 0.42], [150, 0.44, 0.4], [204, 0.47, 0.38]];
const BODY = 0.7, K = 19, FLAT = 0.86;
let FIT: [number, number, number] | null = null;

function pts(t: number, amp: number): [number, number][] {
  const N = 72, w = Math.PI * 2 * t, cx = 12, cy = 12.2, R = 8;
  const rim = RIM.map(([deg, d, r], j) => {
    const a = (deg * Math.PI) / 180 + 0.16 * amp * Math.sin(w + j * 1.9);
    const rr = r * (1 + 0.12 * amp * Math.sin(w + j * 2.4));
    return [Math.cos(a) * d, Math.sin(a) * d, rr] as const;
  });
  const circles = [[0, 0, BODY] as const, ...rim];
  const out: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2, ux = Math.cos(th), uy = Math.sin(th);
    let acc = 0;
    for (const [x, y, r] of circles) {
      const b = x * ux + y * uy, c = x * x + y * y - r * r, disc = b * b - c;
      if (disc > 0) acc += Math.exp(K * (b + Math.sqrt(disc)));
    }
    const rad = Math.log(acc) / K;
    const px = cx + ux * R * rad;
    let py = cy + uy * R * rad;
    const yb = cy + R * FLAT;
    if (py > yb) py = yb + (py - yb) * 0.25;
    out.push([px, py]);
  }
  if (!FIT) {
    const xs = out.map((p) => p[0]), ys = out.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    FIT = [Math.min(1, 18.5 / span), (Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
  }
  const [k, mx, my] = FIT;
  return out.map(([x, y]) => [12 + (x - mx) * k, 12.4 + (y - my) * k]);
}

function curve(p: [number, number][]): string {
  const n = p.length, f = (v: number) => v.toFixed(2);
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

pts(0, 0); // measure the fit once, at rest, so the morph never pumps
export const PEBBLE_REST = curve(pts(0, 0));

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The mark. `alive`: Shape mode is on (slow breathing). `reshaping`: the
 * board is being redrawn (faster, fuller). Both off: the resting outline.
 */
export function Pebble({ alive, reshaping, size = 20, className = '' }: { alive: boolean; reshaping?: boolean; size?: number; className?: string }) {
  const ref = useRef<SVGPathElement>(null);
  const state = useRef({ alive, reshaping: !!reshaping });
  state.current = { alive, reshaping: !!reshaping };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) { el.setAttribute('d', PEBBLE_REST); return; }
    let raf = 0, last = performance.now(), phase = 0, amp = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(el);
    const step = (now: number) => {
      const dt = Math.min(64, now - last); last = now;
      const { alive: on, reshaping: busy } = state.current;
      const period = busy ? 1600 : 7000;
      const targetAmp = busy ? 1 : on ? 0.55 : 0;
      amp += (targetAmp - amp) * Math.min(1, dt / 420); // ease between states, never jump
      if (amp > 0.002) phase = (phase + dt / period) % 1;
      if (visible && (amp > 0.002 || targetAmp > 0)) el.setAttribute('d', curve(pts(phase, amp)));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, []);

  return (
    <svg className={`shp-pebble ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-on={alive || undefined} data-busy={reshaping || undefined}>
      <path ref={ref} d={PEBBLE_REST} />
    </svg>
  );
}
