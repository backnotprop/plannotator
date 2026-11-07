// The run's scene, pure: where every span, message, mark and limit sits in two
// flat layouts of one run, by lane (time × lane) and by resource (time ×
// resource). Switching between them moves each span from its row in one to
// its row in the other, so regrouping is one motion, not a cut.
import type { ShapeRun, ShapeRunSpan, ShapeRunTone } from '@plannotator/core/shape-run';

export type RunMode = 'lanes' | 'res';
/** How far the picture is between the two layouts: lanes + res = 1. */
export interface Weights {
  lanes: number;
  res: number;
}
export const weightsOf = (mode: RunMode): Weights => ({ lanes: mode === 'lanes' ? 1 : 0, res: mode === 'res' ? 1 : 0 });
export const mixWeights = (a: Weights, b: Weights, k: number): Weights => ({ lanes: a.lanes + (b.lanes - a.lanes) * k, res: a.res + (b.res - a.res) * k });

export interface Pt {
  x: number;
  y: number;
}

/** A row of a layout: its label and its y (top row highest). */
export interface FlatRow {
  key: string;
  label: string;
  y: number;
  /** How many spans run side by side in it at most. */
  subs: number;
}

export interface SceneSpan {
  span: ShapeRunSpan;
  i: number;
  /** Its y by lane and by resource. */
  yL: number;
  yR: number;
  laneLabel?: string;
  resLabel?: string;
}

export interface Scene {
  run: ShapeRun;
  end: number;
  rowsL: FlatRow[];
  rowsR: FlatRow[];
  spans: SceneSpan[];
  /** The y extent of each layout, for the fit. */
  extentL: [number, number];
  extentR: [number, number];
}

export const SUB_STEP = 0.4;
const ROW_GAP = 0.62;
// Row keys that no lane or resource id can be: ids are letters, digits and _ . : - only, never "|".
export const HOME = '|home';
/** The key of a resource's own state row, in the by-lane layout. */
export const stateKey = (res: string) => `res|${res}`;
export const isStateKey = (key: string) => key.startsWith('res|');

/** Side-by-side spans of one row get their own sub-rows (greedy, by start). */
function subRows(spans: { from: number; to: number; i: number }[]): Map<number, number> {
  const ends: number[] = [];
  const out = new Map<number, number>();
  for (const s of [...spans].sort((a, b) => a.from - b.from || a.i - b.i)) {
    let k = ends.findIndex((e) => e <= s.from);
    if (k < 0) k = ends.push(s.to) - 1;
    else ends[k] = s.to;
    out.set(s.i, k);
  }
  return out;
}

function flatRows(groups: { key: string; label: string; spans: { from: number; to: number; i: number }[] }[]) {
  const rows: FlatRow[] = [];
  const at = new Map<number, number>();
  let y = 0;
  for (const g of groups) {
    const subs = subRows(g.spans);
    const n = Math.max(1, ...[...subs.values()].map((k) => k + 1));
    rows.push({ key: g.key, label: g.label, y, subs: n });
    for (const [i, k] of subs) at.set(i, y - k * SUB_STEP);
    y -= (n - 1) * SUB_STEP + ROW_GAP;
  }
  const lo = y + ROW_GAP;
  // Centre on 0.
  const mid = lo / 2;
  for (const r of rows) r.y -= mid;
  for (const [i, v] of at) at.set(i, v - mid);
  return { rows, at, extent: [lo - mid - 0.3, -mid + 0.3] as [number, number] };
}

export function buildScene(run: ShapeRun): Scene {
  const end = run.end ?? Math.max(1, ...run.spans.map((s) => s.to));
  const items = run.resources?.items ?? [];
  const resLabel = new Map(items.map((r) => [r.id, r.label]));
  const laneLabel = new Map(run.lanes.map((l) => [l.id, l.label]));
  const indexed = run.spans.map((s, i) => ({ s, i, from: s.from, to: s.to }));
  // By lane: one row per lane; a resource's own state (no lane) gets a row of its own below.
  const stateRes = [...new Set(run.spans.filter((s) => !s.lane && s.on).map((s) => s.on!))];
  const byLane = flatRows([
    ...run.lanes.map((l) => ({ key: l.id, label: l.label, spans: indexed.filter((x) => x.s.lane === l.id) })),
    ...stateRes.map((r) => ({ key: stateKey(r), label: resLabel.get(r) ?? r, spans: indexed.filter((x) => !x.s.lane && x.s.on === r) })),
  ]);
  // By resource: home (the lanes' own process), then each resource. A state of the resource shares its row (a band, drawn under).
  const byRes = flatRows(
    [{ id: HOME, label: run.resources?.home ?? 'own work' }, ...items]
      .map((d) => ({ key: d.id, label: d.label, spans: indexed.filter((x) => (x.s.on ?? HOME) === d.id && x.s.lane) }))
      .filter((g) => g.key !== HOME || g.spans.length),
  );
  const resRowY = new Map(byRes.rows.map((r) => [r.key, r.y]));
  const spans: SceneSpan[] = indexed.map(({ s, i }) => ({
    span: s,
    i,
    yL: byLane.at.get(i) ?? 0,
    yR: s.lane ? (byRes.at.get(i) ?? 0) : (resRowY.get(s.on!) ?? 0),
    laneLabel: s.lane ? laneLabel.get(s.lane) : undefined,
    resLabel: s.on ? resLabel.get(s.on) : run.resources?.home,
  }));
  return { run, end, rowsL: byLane.rows, rowsR: byRes.rows, spans, extentL: byLane.extent, extentR: byRes.extent };
}

/** A point's y in each layout; at weights w it is `w.lanes * yL + w.res * yR`. */
export interface Anchor {
  t: number;
  yL: number;
  yR: number;
}

/** Each lane's spans, and each resource's own states, so finding the span under a point reads one row, not the run. */
const rowIndex = new WeakMap<Scene, Map<string, SceneSpan[]>>();
function spansOfRow(scene: Scene, key: string): SceneSpan[] {
  let index = rowIndex.get(scene);
  if (!index) {
    index = new Map();
    for (const s of scene.spans) {
      const k = s.span.lane ?? stateKey(s.span.on ?? '');
      const list = index.get(k);
      if (list) list.push(s);
      else index.set(k, [s]);
    }
    rowIndex.set(scene, index);
  }
  return index.get(key) ?? [];
}

/** Where a lane (and the resource it runs on at that moment) is, for a message's end or a mark, in both layouts. */
export function anchorYs(scene: Scene, at: { lane?: string; on?: string; t: number }, prefer: 'end' | 'start' = 'end'): Anchor {
  const { lane, on, t } = at;
  // The span this point is on: the lane's span at t (the one ending at t first, for a message out), or the resource's own state.
  const cands = spansOfRow(scene, lane ?? stateKey(on ?? '')).filter((s) => s.span.from <= t + 1e-6 && s.span.to >= t - 1e-6);
  const pick =
    (lane && on ? cands.find((s) => s.span.on === on) : undefined) ??
    (prefer === 'start' ? cands.find((s) => Math.abs(s.span.from - t) < 1e-6) : undefined) ??
    (prefer === 'end' ? cands.find((s) => Math.abs(s.span.to - t) < 1e-6 && s.span.end !== 'cancelled') : undefined) ??
    cands.find((s) => s.span.end !== 'cancelled' && s.span.end !== 'timeout') ??
    cands[0];
  const rowL = scene.rowsL.find((r) => r.key === (lane ?? stateKey(on ?? '')));
  const rowR = scene.rowsR.find((r) => r.key === (pick?.span.on ?? on ?? HOME));
  return { t, yL: pick?.yL ?? rowL?.y ?? 0, yR: pick?.yR ?? rowR?.y ?? 0 };
}

/** The same point at weights w, in scene units. */
export function anchorOf(scene: Scene, at: { lane?: string; on?: string; t: number }, w: Weights, prefer: 'end' | 'start' = 'end'): { t: number; y: number } {
  const a = anchorYs(scene, at, prefer);
  return { t: a.t, y: mixY(a, w) };
}
export const mixY = (a: { yL: number; yR: number }, w: Weights) => w.lanes * a.yL + w.res * a.yR;

/** What a frame needs that does not change while the run plays or regroups: worked out once per run. */
export interface SceneGeometry {
  msgs: { a0: Anchor; a1: Anchor; fromLabel: string; toLabel: string }[];
  marks: Anchor[];
  /** Has a mark at its start (which then says its words instead), by span index. */
  marked: boolean[];
}
export function sceneGeometry(scene: Scene): SceneGeometry {
  const run = scene.run;
  const name = new Map(run.lanes.map((l) => [l.id, l.label]));
  const marks = run.marks ?? [];
  const markAt = new Map<string, number[]>();
  for (const m of marks) if (m.lane) (markAt.get(m.lane) ?? markAt.set(m.lane, []).get(m.lane)!).push(m.at);
  return {
    msgs: (run.msgs ?? []).map((m) => ({
      a0: anchorYs(scene, { lane: m.from, t: m.at }, 'end'),
      a1: anchorYs(scene, { lane: m.to, t: m.arrive ?? m.at }, 'start'),
      fromLabel: name.get(m.from) ?? m.from,
      toLabel: name.get(m.to) ?? m.to,
    })),
    marks: marks.map((mk) => anchorYs(scene, { lane: mk.lane, on: mk.lane ? undefined : mk.on, t: mk.at }, 'start')),
    marked: scene.spans.map((s) => !!s.span.lane && (markAt.get(s.span.lane) ?? []).some((at) => Math.abs(at - s.span.from) <= scene.end * 0.03)),
  };
}

export const spanY = (s: SceneSpan, w: Weights) => w.lanes * s.yL + w.res * s.yR;

/** Scene (time, y) to the stage's pixels: time left to right past the label gutter, rows top to bottom. */
export function fitProjector(scene: Scene, w: Weights, W: number, H: number, pad: { l: number; r: number; t: number; b: number }) {
  const lo = w.lanes * scene.extentL[0] + w.res * scene.extentR[0];
  const hi = w.lanes * scene.extentL[1] + w.res * scene.extentR[1];
  const aw = Math.max(1, W - pad.l - pad.r), ah = Math.max(1, H - pad.t - pad.b);
  const ky = ah / Math.max(1e-6, hi - lo);
  return {
    x: (t: number) => pad.l + (t / scene.end) * aw,
    y: (y: number) => pad.t + (hi - y) * ky,
    /** The y range drawn, top and bottom, in pixels. */
    top: pad.t,
    bottom: pad.t + ah,
  };
}
export type Projector = ReturnType<typeof fitProjector>;

export const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Round steps for the time axis: 1, 2 or 5 times a power of ten, about n of them. */
export function niceStep(end: number, n = 7) {
  const raw = end / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

// ── What the run says at a moment (the caption and the screen reader's line) ──

export function inFlight(run: ShapeRun, t: number) {
  return run.spans.filter((s) => s.lane && s.on && s.from <= t && t < s.to);
}

/** A time for people: one decimal at most, in the run's unit. */
export const fmtTime = (n: number, unit: string) => `${Math.round(n * 10) / 10} ${unit}`;

export function momentText(run: ShapeRun, t: number, unit = run.unit ?? 'ms'): string {
  const lane = new Map(run.lanes.map((l) => [l.id, l.label]));
  const res = new Map((run.resources?.items ?? []).map((r) => [r.id, r.label]));
  const past = (run.marks ?? []).filter((m) => m.at <= t + 1e-6);
  const lastAt = past.length ? Math.max(...past.map((m) => m.at)) : undefined;
  const now = lastAt !== undefined && t - lastAt < (run.end ?? 100) * 0.12 ? past.filter((m) => m.at === lastAt) : [];
  const flying = inFlight(run, t);
  const where = (s: ShapeRunSpan) => `${lane.get(s.lane!) ?? s.lane} on ${res.get(s.on!) ?? s.on}`;
  const parts = [fmtTime(t, unit)];
  for (const m of now) parts.push(`${m.label}${m.lane ? ` (${lane.get(m.lane)})` : ''}`);
  // Calls on a resource (a lane working or waiting on a pod, a lock, a channel).
  if (flying.length) parts.push(`${flying.length} in flight: ${flying.map(where).join(', ')}`);
  // A lane's own spans: who is working and who is waiting.
  const end = run.end ?? Math.max(...run.spans.map((s) => s.to));
  const open = (s: ShapeRunSpan) => !s.end || s.end === 'open';
  // At the very end only what is marked open (blocked forever) still counts; a wait that ends with the run is over.
  const live = run.spans.filter((s) => s.lane && !s.on && s.from <= t && (t < s.to || (t >= end && s.to >= end && s.end === 'open')));
  const working = live.filter((s) => !open(s)).map((s) => `${lane.get(s.lane!) ?? s.lane}${s.label ? ` (${s.label})` : ''}`);
  // A call still open when the run ends is blocked forever on its resource (a send no one takes: a leak).
  const stuck = t >= end ? run.spans.filter((s) => s.lane && s.on && s.end === 'open' && s.to >= end).map(where) : [];
  const waiting = [...new Set([...live.filter(open).map((s) => lane.get(s.lane!) ?? s.lane!), ...stuck])];
  if (working.length) parts.push(`working: ${working.join(', ')}`);
  if (waiting.length) parts.push(`blocked: ${waiting.join(', ')}`);
  if (!flying.length && !working.length && !waiting.length) parts.push(run.resources?.items.length ? 'nothing in flight' : 'nothing running');
  return parts.join(' · ');
}

export const toneVar = (tone: ShapeRunTone | 'blue' | undefined): string =>
  ({
    ink: 'var(--ink, currentColor)',
    mark: 'var(--mark, #5b5bd6)',
    alert: 'var(--alert, #d33)',
    green: 'var(--green, #2b8a57)',
    amber: 'var(--amber, #b87a12)',
    grey: 'var(--grey, #888)',
    blue: 'var(--blue, #2f6fb0)',
  })[tone ?? 'ink'];

/** The colour of a span's body. A failure is the work it was until it failed: the end alone is red (`endTone`). */
export function spanTone(s: ShapeRunSpan): string {
  if (s.tone) return toneVar(s.tone);
  switch (s.end) {
    case 'won':
      return toneVar('green');
    case 'open':
      return toneVar('alert');
    case 'ok':
    case 'error':
    case 'timeout':
      return toneVar('blue');
    default:
      return toneVar('grey');
  }
}

/** A short red last stretch for a span that failed or timed out, unless the agent chose its colour. */
export const failsAtEnd = (s: ShapeRunSpan) => !s.tone && !!s.lane && (s.end === 'error' || s.end === 'timeout');
