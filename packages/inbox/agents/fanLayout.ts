export interface FanSpot {
  x: number;
  y: number;
}

export interface FanOptions {
  pitch: number;
  item: number;
  margin: number;
  inner: number;
  between: number;
  innerSpread: number;
}

export const FAN_OPTIONS: FanOptions = { pitch: 32, item: 28, margin: 8, inner: 48, between: 40, innerSpread: 124 };

const RAD = Math.PI / 180;

function openRuns(cx: number, cy: number, r: number, w: number, h: number, o: FanOptions): [number, number][] {
  const pad = o.margin + o.item / 2;
  const ok: boolean[] = [];
  for (let d = -180; d < 180; d++) {
    const x = cx + r * Math.cos(d * RAD);
    const y = cy + r * Math.sin(d * RAD);
    ok.push(x >= pad && x <= w - pad && y >= pad && y <= h - pad);
  }
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= ok.length; i++) {
    if (i < ok.length && ok[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start - 180, i - 1 - 180]);
      start = -1;
    }
  }
  if (runs.length > 1 && runs[0]![0] === -180 && runs[runs.length - 1]![1] === 179) {
    const last = runs.pop()!;
    runs[0] = [last[0], runs[0]![1] + 360];
  }
  return runs;
}

function pickRun(runs: [number, number][], toward: number): [number, number] | null {
  if (!runs.length) return null;
  return runs.find(([a, b]) => a <= toward && toward <= b) ?? runs.reduce((best, run) => (run[1] - run[0] > best[1] - best[0] ? run : best));
}

function spread(n: number, span: number, run: [number, number], toward: number): number[] {
  const half = span / 2;
  const lo = run[0] + half;
  const hi = run[1] - half;
  const centre = lo > hi ? (run[0] + run[1]) / 2 : Math.max(lo, Math.min(hi, toward));
  if (n === 1) return [centre];
  return Array.from({ length: n }, (_, i) => centre - half + (span * i) / (n - 1));
}

export function fanLayout(cx: number, cy: number, w: number, h: number, counts: readonly number[], options: Partial<FanOptions> = {}, toward = 0): FanSpot[][] {
  const o = { ...FAN_OPTIONS, ...options };
  const many = counts.length > 1;
  const radii: number[] = [];
  counts.forEach((n, ring) => {
    const floor = ring === 0 ? 0 : radii[ring - 1]! + o.between;
    radii.push(ring === 0 && many ? o.inner : Math.max(floor, o.inner, n > 1 ? o.pitch / (2 * Math.sin((90 / (n - 1)) * RAD)) : 0));
  });
  const out: FanSpot[][] = counts.map(() => []);
  let aim = toward;
  for (let ring = counts.length - 1; ring >= 0; ring--) {
    const n = counts[ring]!;
    if (n <= 0) continue;
    let r = radii[ring]!;
    const inner = many && ring === 0;
    const stepAt = (radius: number) => (2 * Math.asin(Math.min(1, o.pitch / (2 * radius)))) / RAD;
    const spanAt = (radius: number) => (n > 1 ? Math.max(stepAt(radius) * (n - 1), inner ? o.innerSpread : 0) : 0);
    let span = spanAt(r);
    let run = pickRun(openRuns(cx, cy, r, w, h, o), aim);
    // Too little room: a wider arc, until its choices fit the room left (a few tries, and never past 220 px).
    for (let tries = 0; !inner && run && run[1] - run[0] < span && tries < 6 && r < 220; tries++) {
      r = Math.min(220, (o.pitch * (n - 1)) / (Math.max(run[1] - run[0], 20) * RAD));
      span = spanAt(r);
      run = pickRun(openRuns(cx, cy, r, w, h, o), aim);
    }
    const angles = run ? spread(n, Math.min(span, run[1] - run[0]), run, aim) : spread(n, span, [aim - span / 2, aim + span / 2], aim);
    aim = (angles[0]! + angles[angles.length - 1]!) / 2;
    out[ring] = angles.map((d) => ({ x: +(r * Math.cos(d * RAD)).toFixed(2), y: +(r * Math.sin(d * RAD)).toFixed(2) }));
  }
  return out;
}
