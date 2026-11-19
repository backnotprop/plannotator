/**
 * A chart, drawn by our own code: a table and an encoding in, a short list of shapes out. No library.
 *
 * `chartShapes` is the one drawing. The board turns its shapes into SVG elements (`react/objects.tsx`),
 * the still picture of a snapshot turns the same shapes into SVG text (`chartToSvg`), so a chart is the
 * same on the board, in a plan's figure and in a file. A shape names a ROLE for its paint (`ink`,
 * `accent`...), never a colour: the board answers with its theme's variables, a file with plain colours.
 *
 * The look is fixed here, so nobody styles a chart to get a good one: a small caps title, the latest
 * value large on a line or an area, hairline rules with their values sitting on them, flat marks, and one
 * colour that means "this one" (the object's own colour, on the first series). Every other series is a
 * quieter step of ink or of that colour. A person changes the mark, the colour and which field goes
 * where; nothing else.
 *
 * It trusts its input: `checkChart` (`model/chart.ts`) has already refused a table it could not draw.
 * It is still total: any table that passed draws without throwing, at any size.
 */
import type { ChartCell, ChartObject } from '../model/types';

/** What a shape is painted with. The renderer decides the colour. */
export type ChartRole = 'ink' | 'muted' | 'rule' | 'accent';

export type ChartShape =
  | { kind: 'path'; d: string; fill?: ChartRole; stroke?: ChartRole; width?: number; opacity?: number; dash?: boolean }
  | { kind: 'text'; x: number; y: number; text: string; size: number; fill: ChartRole; anchor?: 'middle' | 'end'; face: 'mono' | 'sans'; weight?: number };

export interface ChartDrawOptions {
  w?: number;
  h?: number;
  /** `marks`: no words at all, for a chart too small on screen to read (a crowded board, far out). */
  detail?: 'full' | 'marks';
}

/** How each series is painted, in order. The first is the object's colour at full strength. */
const SERIES: readonly { role: ChartRole; opacity: number }[] = [
  { role: 'accent', opacity: 1 },
  { role: 'ink', opacity: 0.55 },
  { role: 'ink', opacity: 0.3 },
  { role: 'accent', opacity: 0.5 },
  { role: 'ink', opacity: 0.8 },
  { role: 'accent', opacity: 0.28 },
  { role: 'ink', opacity: 0.16 },
  { role: 'accent', opacity: 0.75 },
];
const paintOf = (series: number) => SERIES[series % SERIES.length];

/** How strong a cell is drawn, in five steps: few enough that every cell of a step is one path. */
const CELL_STEPS = [0.1, 0.3, 0.52, 0.76, 1] as const;

const MONO_W = 0.61;
const n = (value: number): string => String(Math.round(value * 100) / 100);
const rect = (x: number, y: number, w: number, h: number): string => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
const dot = (x: number, y: number, r: number): string => `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0z`;
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

/** A round step for an axis: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, steps: number): number {
  const raw = span / Math.max(1, steps);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/** A number as a person would write it on an axis. */
export function shortNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${n(value / 1e9)}B`;
  if (abs >= 1e6) return `${n(value / 1e6)}M`;
  if (abs >= 1e4) return `${n(value / 1e3)}k`;
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return abs < 1 ? String(Math.round(value * 1000) / 1000) : String(Math.round(value * 10) / 10);
}

interface Scale {
  lo: number;
  hi: number;
  step: number;
}

/** A scale that holds `lo` to `hi` and ends on round numbers. */
function scaleFor(lo: number, hi: number, steps: number): Scale {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) lo = hi = 0;
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const step = niceStep(hi - lo, steps);
  const from = Math.floor(lo / step) * step;
  const to = Math.max(from + step, Math.ceil(hi / step) * step);
  return { lo: from, hi: to, step };
}

const ticksOf = (scale: Scale): number[] => {
  const out: number[] = [];
  // Counted, not added up, so no rounding error grows along the axis; and never more than a chart can hold.
  const count = Math.min(40, Math.round((scale.hi - scale.lo) / scale.step));
  for (let i = 0; i <= count; i++) out.push(scale.lo + i * scale.step);
  return out;
};

/** The different values of a column, as text, in the order they first appear. */
function namesOf(values: readonly ChartCell[]): string[] {
  const seen = new Set<string>();
  for (const value of values) seen.add(String(value));
  return [...seen];
}

interface Area {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface Point {
  s: number;
  x: ChartCell;
  y: number;
  size: number;
}

/** A chart's rows as points, split into the small charts a `facet` asks for, with the series named. */
function pointsOf(object: ChartObject): { series: string[]; facets: { name: string; points: Point[] }[] } {
  const { encode, fields, rows } = object;
  const ys = Array.isArray(encode.y) ? encode.y : [encode.y];
  const xi = fields.indexOf(encode.x);
  const yi = ys.map((y) => fields.indexOf(y));
  const si = encode.series ? fields.indexOf(encode.series) : -1;
  const zi = encode.size ? fields.indexOf(encode.size) : -1;
  const fi = encode.facet ? fields.indexOf(encode.facet) : -1;
  const series = si !== -1 ? namesOf(rows.map((row) => row[si])) : ys;
  const facets = new Map<string, Point[]>();
  for (const row of rows) {
    const key = fi === -1 ? '' : String(row[fi]);
    let points = facets.get(key);
    if (!points) facets.set(key, (points = []));
    const size = zi === -1 ? 0 : Math.max(0, Number(row[zi]) || 0);
    if (si !== -1) points.push({ s: series.indexOf(String(row[si])), x: row[xi], y: Number(row[yi[0]]) || 0, size });
    else yi.forEach((column, s) => points!.push({ s, x: row[xi], y: Number(row[column]) || 0, size }));
  }
  return { series, facets: [...facets].map(([name, points]) => ({ name, points })) };
}

/** Names along an axis: as many as fit, always the first and the last. */
function thinned(count: number, at: (index: number) => number, widest: number): number[] {
  if (count === 0) return [];
  const room = Math.abs(at(count - 1) - at(0)) || 1;
  const every = Math.max(1, Math.ceil((widest * count) / (room + widest)));
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += every) if (Math.abs(at(count - 1) - at(i)) >= widest) out.push(i);
  out.push(count - 1);
  return out;
}

/** The shapes of one chart, in a box `w` by `h` with its corner at 0,0, back to front. */
export function chartShapes(object: ChartObject, options: ChartDrawOptions = {}): ChartShape[] {
  const w = options.w ?? object.w;
  const h = options.h ?? object.h;
  const words = options.detail !== 'marks';
  const tiny = w < 90 || h < 60;
  const small = tiny || w < 200 || h < 130;
  const pad = tiny ? 3 : small ? 8 : 14;
  const out: ChartShape[] = [];
  const text = (x: number, y: number, value: string, size: number, fill: ChartRole, extra: Partial<Extract<ChartShape, { kind: 'text' }>> = {}) => {
    if (words && value) out.push({ kind: 'text', x, y, text: value, size, fill, face: 'mono', ...extra });
  };
  const mono = (value: string, size: number) => value.length * size * MONO_W;
  const fits = (value: string, size: number, room: number) => cut(value, Math.max(1, Math.floor(room / (size * MONO_W))));
  const { mark, encode, fields, rows } = object;
  const unit = object.unit ?? '';

  // ── The head: the title, the latest value, which series is which ──────────
  const xy = mark === 'bar' || mark === 'line' || mark === 'area' || mark === 'dot';
  const { series, facets } = xy ? pointsOf(object) : { series: [] as string[], facets: [] as { name: string; points: Point[] }[] };
  const kinds = !xy && encode.series ? namesOf(rows.map((row) => row[fields.indexOf(encode.series!)])) : [];
  const legend = xy ? (series.length > 1 ? series : []) : kinds;
  const faceted = xy && facets.length > 1;
  const flipped = mark === 'bar' && !!object.flip && !faceted;
  const stacked = !!object.stack && (mark === 'bar' || mark === 'area') && series.length > 1;
  let y = pad;
  if (!tiny && object.title && (h >= 80 || !small)) {
    text(pad, y + 8, fits(object.title.toUpperCase(), 10, w - pad * 2), 10, 'muted', { weight: 500 });
    y += 20;
  }
  if (!small && !faceted && (mark === 'line' || mark === 'area') && facets[0]) {
    // The latest value of the first series, large: on a line that is the number the chart is for.
    const first = facets[0].points.filter((point) => point.s === 0);
    const latest = first[first.length - 1];
    if (latest) {
      const value = shortNumber(latest.y);
      text(pad, y + 26, value, 28, 'ink', { face: 'sans', weight: 650 });
      text(pad + value.length * 16.4 + 5, y + 26, unit, 12, 'muted');
      y += 38;
    }
  }
  if (!small && legend.length) {
    // Said once, in the order drawn. What does not fit is counted, not dropped in silence.
    const totals = stacked ? legend.map((_name, s) => facets.reduce((sum, facet) => sum + facet.points.reduce((part, point) => part + (point.s === s ? point.y : 0), 0), 0)) : null;
    let at = pad;
    for (let s = 0; s < legend.length; s++) {
      const label = `${cut(legend[s], 24)}${totals ? ` ${shortNumber(totals[s])}` : ''}`;
      const width = 14 + mono(label, 10) + 12;
      if (at + width > w - pad - (s < legend.length - 1 ? 22 : 0) && s > 0) {
        text(at, y + 9, `+${legend.length - s}`, 10, 'muted');
        break;
      }
      const paint = paintOf(s);
      out.push({ kind: 'path', d: rect(at, y + 2, 9, mark === 'line' ? 2 : 8), fill: paint.role, opacity: paint.opacity });
      text(at + 14, y + 9, label, 10, s === 0 ? 'ink' : 'muted');
      at += width;
    }
    y += 18;
  }

  const hair = (d: string, role: ChartRole = 'rule') => out.push({ kind: 'path', d, stroke: role, width: 1 });
  /** The object's rules that cross a value axis, and those that stand on the x axis. */
  const across = (object.rules ?? []).filter((rule) => !rule.on && typeof rule.at === 'number') as { at: number; label?: string }[];
  const upright = (object.rules ?? []).filter((rule) => rule.on === 'x');

  // ── Cells: a grid of names by names ───────────────────────────────────────
  if (mark === 'cell') {
    const xi = fields.indexOf(encode.x);
    const yi = fields.indexOf(Array.isArray(encode.y) ? encode.y[0] : encode.y);
    const vi = encode.value ? fields.indexOf(encode.value) : -1;
    const ki = encode.series ? fields.indexOf(encode.series) : -1;
    const columns = namesOf(rows.map((row) => row[xi]));
    const lanes = namesOf(rows.map((row) => row[yi]));
    const gutter = small ? 0 : Math.min(w * 0.34, Math.max(...lanes.map((lane) => mono(lane, 9.5))) + 8);
    const area: Area = { l: pad + gutter, t: y + (small ? 0 : 2), r: w - pad, b: h - pad - (small ? 0 : 14) };
    const cw = Math.max(0.5, (area.r - area.l) / columns.length);
    const ch = Math.max(0.5, (area.b - area.t) / lanes.length);
    const gap = Math.min(1.5, cw * 0.12, ch * 0.12);
    let lo = Infinity;
    let hi = -Infinity;
    if (vi !== -1) for (const row of rows) {
      lo = Math.min(lo, Number(row[vi]));
      hi = Math.max(hi, Number(row[vi]));
    }
    // One path for each strength or kind, however many cells there are.
    const groups = new Map<number, string[]>();
    const column = new Map(columns.map((name, index) => [name, index]));
    const lane = new Map(lanes.map((name, index) => [name, index]));
    for (const row of rows) {
      const cx = area.l + column.get(String(row[xi]))! * cw;
      const cy = area.t + lane.get(String(row[yi]))! * ch;
      const group = ki !== -1 ? kinds.indexOf(String(row[ki])) : hi === lo ? CELL_STEPS.length - 1 : Math.min(CELL_STEPS.length - 1, Math.floor(((Number(row[vi]) - lo) / (hi - lo)) * CELL_STEPS.length));
      let parts = groups.get(group);
      if (!parts) groups.set(group, (parts = []));
      parts.push(rect(cx + gap / 2, cy + gap / 2, Math.max(0.5, cw - gap), Math.max(0.5, ch - gap)));
    }
    for (const [group, parts] of [...groups].sort((a, b) => a[0] - b[0])) {
      const paint = ki !== -1 ? paintOf(group) : { role: 'accent' as const, opacity: CELL_STEPS[group] };
      out.push({ kind: 'path', d: parts.join(''), fill: paint.role, opacity: paint.opacity });
    }
    if (!small) {
      const rowEvery = Math.max(1, Math.ceil(11 / ch));
      lanes.forEach((name, index) => {
        if (index % rowEvery === 0) text(pad, area.t + (index + 0.5) * ch + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
      });
      const at = (index: number) => area.l + (index + 0.5) * cw;
      const widest = Math.max(...columns.map((name) => mono(cut(name, 12), 9.5))) + 8;
      for (const index of thinned(columns.length, at, widest)) text(at(index), h - pad - 1, cut(columns[index], 12), 9.5, 'muted', { anchor: 'middle' });
      if (vi !== -1 && hi > lo && !object.title) text(w - pad, pad + 8, `${shortNumber(lo)} to ${shortNumber(hi)}${unit ? ` ${unit}` : ''}`, 9.5, 'muted', { anchor: 'end' });
    }
    return out;
  }

  // ── Spans: lanes down the side, a bar from where each starts to where it ends ──
  if (mark === 'span') {
    const xi = fields.indexOf(encode.x);
    const x2i = fields.indexOf(encode.x2 ?? encode.x);
    const yi = fields.indexOf(Array.isArray(encode.y) ? encode.y[0] : encode.y);
    const ki = encode.series ? fields.indexOf(encode.series) : -1;
    const lanes = namesOf(rows.map((row) => row[yi]));
    const gutter = small ? 0 : Math.min(w * 0.34, Math.max(...lanes.map((lane) => mono(lane, 9.5))) + 10);
    const area: Area = { l: pad + gutter, t: y + (small ? 0 : upright.some((rule) => rule.label) ? 14 : 4), r: w - pad, b: h - pad - (small ? 0 : 14) };
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of rows) {
      lo = Math.min(lo, Number(row[xi]), Number(row[x2i]));
      hi = Math.max(hi, Number(row[xi]), Number(row[x2i]));
    }
    for (const rule of upright) if (typeof rule.at === 'number') {
      lo = Math.min(lo, rule.at);
      hi = Math.max(hi, rule.at);
    }
    const scale = scaleFor(lo, hi, Math.max(2, Math.min(8, Math.floor((area.r - area.l) / 70))));
    const px = (value: number) => area.l + ((value - scale.lo) / (scale.hi - scale.lo)) * (area.r - area.l);
    const rowH = Math.max(1, (area.b - area.t) / lanes.length);
    const thick = Math.max(1, Math.min(rowH * 0.56, 18));
    const ticks = ticksOf(scale);
    hair(ticks.map((tick) => `M${n(px(tick))} ${n(area.t)}V${n(area.b)}`).join(''));
    if (!small) for (const tick of ticks) text(px(tick), h - pad - 1, shortNumber(tick), 9.5, 'muted', { anchor: tick === ticks[0] ? undefined : tick === ticks[ticks.length - 1] ? 'end' : 'middle' });
    const lane = new Map(lanes.map((name, index) => [name, index]));
    const groups = new Map<number, string[]>();
    for (const row of rows) {
      const from = px(Math.min(Number(row[xi]), Number(row[x2i])));
      const to = px(Math.max(Number(row[xi]), Number(row[x2i])));
      const top = area.t + lane.get(String(row[yi]))! * rowH + (rowH - thick) / 2;
      const group = ki === -1 ? 0 : kinds.indexOf(String(row[ki]));
      let parts = groups.get(group);
      if (!parts) groups.set(group, (parts = []));
      parts.push(rect(from, top, Math.max(2, to - from), thick));
    }
    for (const [group, parts] of [...groups].sort((a, b) => a[0] - b[0])) out.push({ kind: 'path', d: parts.join(''), fill: paintOf(group).role, opacity: paintOf(group).opacity });
    if (!small) {
      const rowEvery = Math.max(1, Math.ceil(11 / rowH));
      lanes.forEach((name, index) => {
        if (index % rowEvery === 0) text(pad, area.t + (index + 0.5) * rowH + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
      });
    }
    for (const rule of upright) {
      if (typeof rule.at !== 'number') continue;
      const rx = px(rule.at);
      out.push({ kind: 'path', d: `M${n(rx)} ${n(area.t - 2)}V${n(area.b)}`, stroke: 'ink', width: 1, dash: true });
      if (!small && rule.label) text(Math.min(rx, w - pad), area.t - 5, fits(rule.label, 9.5, w * 0.5), 9.5, 'ink', { anchor: rx > w * 0.6 ? 'end' : undefined });
    }
    return out;
  }

  // ── Bars, lines, areas and dots: one or more small charts on shared scales ──
  const all = facets.flatMap((facet) => facet.points);
  const numericX = mark !== 'bar' && all.every((point) => typeof point.x === 'number');
  const names = numericX ? [] : namesOf(all.map((point) => point.x));
  const nameAt = new Map(names.map((name, index) => [name, index]));
  /** Each point's top and foot on the value axis: its own value, or its place in a stack. */
  const stackOf = (points: Point[]): { point: Point; from: number; to: number }[] => {
    if (!stacked) return points.map((point) => ({ point, from: 0, to: point.y }));
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    return [...points].sort((a, b) => a.s - b.s).map((point) => {
      const key = String(point.x);
      const sums = point.y < 0 ? down : up;
      const from = sums.get(key) ?? 0;
      sums.set(key, from + point.y);
      return { point, from, to: from + point.y };
    });
  };
  const stacks = facets.map((facet) => stackOf(facet.points));
  let lo = Infinity;
  let hi = -Infinity;
  for (const placed of stacks) for (const { from, to } of placed) {
    lo = Math.min(lo, from, to);
    hi = Math.max(hi, from, to);
  }
  if (mark === 'line' || mark === 'dot') {
    // A line may start where its numbers do, unless nothing is not far off.
    lo = Math.min(...all.map((point) => point.y));
    hi = Math.max(...all.map((point) => point.y));
    if (lo > 0 && lo < (hi - lo) * 2) lo = 0;
  } else {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  for (const rule of across) {
    lo = Math.min(lo, rule.at);
    hi = Math.max(hi, rule.at);
  }
  let xlo = Infinity;
  let xhi = -Infinity;
  if (numericX) for (const point of all) {
    xlo = Math.min(xlo, point.x as number);
    xhi = Math.max(xhi, point.x as number);
  }
  if (numericX && mark === 'dot') {
    // Dots sit inside round ends, so none is cut by the chart's edge.
    const round = scaleFor(xlo, xhi, 4);
    xlo = round.lo;
    xhi = round.hi;
  }
  const biggest = Math.max(0, ...all.map((point) => point.size));
  const ends = !small && !faceted && !flipped && (mark === 'line' || mark === 'area') && !stacked;

  const columns = faceted ? Math.min(facets.length, Math.max(1, Math.round(Math.sqrt((facets.length * w) / Math.max(1, h))))) : 1;
  const lines = Math.ceil(facets.length / columns);
  const body: Area = { l: pad, t: y + (small ? 0 : 12), r: w - pad, b: h - pad - (small ? 0 : 14) };
  const gapX = faceted ? 12 : 0;
  const gapY = faceted ? 26 : 0;
  const panelW = (body.r - body.l - gapX * (columns - 1)) / columns;
  const panelH = (body.b - body.t - gapY * (lines - 1)) / lines;

  facets.forEach((facet, index) => {
    const col = index % columns;
    const line = Math.floor(index / columns);
    const area: Area = { l: body.l + col * (panelW + gapX), t: body.t + line * (panelH + gapY), r: 0, b: 0 };
    area.b = area.t + panelH;
    const edge = area.l + panelW;
    area.r = edge;
    if (faceted) text(area.l, area.t - 5, fits(facet.name, 9.5, panelW), 9.5, 'ink');
    const placed = stacks[index];

    if (flipped) {
      // Names down the left, values running right.
      const gutter = small ? 0 : Math.min(w * 0.36, Math.max(...names.map((name) => mono(name, 9.5))) + 10);
      const left = area.l + gutter;
      const scale = scaleFor(lo, hi, Math.max(2, Math.min(6, Math.floor((edge - left) / 70))));
      const px = (value: number) => left + ((value - scale.lo) / (scale.hi - scale.lo)) * (edge - left);
      const ticks = ticksOf(scale);
      hair(ticks.filter((tick) => tick !== 0).map((tick) => `M${n(px(tick))} ${n(area.t)}V${n(area.b)}`).join(''));
      hair(`M${n(px(Math.max(scale.lo, Math.min(0, scale.hi))))} ${n(area.t)}V${n(area.b)}`, 'muted');
      if (!small) for (const tick of ticks) text(px(tick), h - pad - 1, `${shortNumber(tick)}${tick === ticks[ticks.length - 1] && unit ? ` ${unit}` : ''}`, 9.5, 'muted', { anchor: tick === ticks[0] ? undefined : tick === ticks[ticks.length - 1] ? 'end' : 'middle' });
      const band = Math.max(1, (area.b - area.t) / Math.max(1, names.length));
      const gap = Math.min(8, band * 0.24);
      const groups = stacked ? 1 : series.length;
      const thick = Math.max(1, Math.min((band - gap) / groups, 28));
      const inset = (band - thick * groups) / 2;
      const paths = new Map<number, string[]>();
      for (const { point, from, to } of placed) {
        const top = area.t + nameAt.get(String(point.x))! * band + inset + (stacked ? 0 : point.s * thick);
        const a = px(Math.min(from, to));
        const b = px(Math.max(from, to));
        let parts = paths.get(point.s);
        if (!parts) paths.set(point.s, (parts = []));
        parts.push(rect(a + (stacked && from !== 0 ? 0.75 : 0), top, Math.max(1, b - a - (stacked && from !== 0 ? 0.75 : 0)), thick));
      }
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push({ kind: 'path', d: parts.join(''), fill: paintOf(s).role, opacity: paintOf(s).opacity });
      if (!small) {
        const every = Math.max(1, Math.ceil(11 / band));
        names.forEach((name, i) => {
          if (i % every === 0) text(area.l, area.t + (i + 0.5) * band + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
        });
      }
      for (const rule of across) {
        out.push({ kind: 'path', d: `M${n(px(rule.at))} ${n(area.t - 2)}V${n(area.b)}`, stroke: 'ink', width: 1, dash: true });
        if (!small && rule.label) text(px(rule.at) + 4, area.t + 8, fits(rule.label, 9.5, w * 0.4), 9.5, 'ink');
      }
      return;
    }

    const scale = scaleFor(lo, hi, Math.max(2, Math.min(5, Math.floor(panelH / 46))));
    // The values written on the rules get a margin of their own, so no mark is drawn under them.
    const labelled = !small && (!faceted || col === columns - 1 || index === facets.length - 1);
    // Every small chart keeps the same margin, written in or not, so their marks line up down the page.
    const margin = ends ? 36 : labelled || (faceted && !small) ? Math.max(...ticksOf(scale).map((tick) => mono(shortNumber(tick), 9.5))) + (unit ? mono(unit, 9.5) + 6 : 0) + 8 : 0;
    area.r = edge - Math.min(margin, panelW * 0.4);
    const py = (value: number) => area.b - ((value - scale.lo) / (scale.hi - scale.lo)) * (area.b - area.t);
    const band = (area.r - area.l) / Math.max(1, names.length);
    const px = (value: ChartCell): number => {
      if (numericX) return xhi === xlo ? (area.l + area.r) / 2 : area.l + (((value as number) - xlo) / (xhi - xlo)) * (area.r - area.l);
      const at = nameAt.get(String(value)) ?? 0;
      if (mark === 'bar') return area.l + band * (at + 0.5);
      return names.length === 1 ? (area.l + area.r) / 2 : area.l + ((area.r - area.l) * at) / (names.length - 1);
    };
    const base = py(Math.max(scale.lo, Math.min(0, scale.hi)));

    // Where each line ends, so a rule's value is not written under a line's own.
    const lastOf = new Map<number, { x: number; y: number; value: number }>();
    const ordered = mark === 'bar' || mark === 'dot' || !numericX ? placed : [...placed].sort((a, b) => (a.point.x as number) - (b.point.x as number));
    if (mark === 'line' || mark === 'area') for (const { point, to } of ordered) lastOf.set(point.s, { x: px(point.x), y: py(to), value: point.y });

    // Rules, each with its value sitting on it. The one at nothing is the ground the marks stand on.
    const ticks = ticksOf(scale);
    hair(ticks.filter((tick) => Math.abs(py(tick) - base) > 0.5).map((tick) => `M${n(area.l)} ${n(py(tick))}H${n(edge)}`).join(''));
    hair(`M${n(area.l)} ${n(base)}H${n(edge)}`, 'muted');
    if (labelled) {
      const top = ticks[ticks.length - 1];
      for (const tick of ticks) {
        const ty = py(tick);
        if (Math.abs(ty - base) <= 0.5) continue;
        if (ends && [...lastOf.values()].some((end) => Math.abs(end.y - (ty - 4)) < 22)) continue;
        text(edge, ty - 4, `${shortNumber(tick)}${tick === top && unit ? ` ${unit}` : ''}`, 9.5, 'muted', { anchor: 'end' });
      }
    }

    if (mark === 'bar') {
      const gap = Math.max(0.5, Math.min(8, band * 0.22));
      const groups = stacked ? 1 : series.length;
      const thick = Math.max(0.5, (band - gap) / groups);
      const paths = new Map<number, string[]>();
      for (const { point, from, to } of placed) {
        const left = area.l + band * nameAt.get(String(point.x))! + gap / 2 + (stacked ? 0 : point.s * thick);
        const top = py(Math.max(from, to));
        const foot = py(Math.min(from, to));
        let parts = paths.get(point.s);
        if (!parts) paths.set(point.s, (parts = []));
        // A stacked part stands a hair off the one under it, so two quiet parts do not read as one.
        parts.push(rect(left, top, thick, Math.max(1, foot - top - (stacked && from !== 0 ? 0.75 : 0))));
      }
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push({ kind: 'path', d: parts.join(''), fill: paintOf(s).role, opacity: paintOf(s).opacity });
    } else if (mark === 'dot') {
      const paths = new Map<number, string[]>();
      for (const { point } of placed) {
        const r = biggest > 0 ? 2.5 + 9.5 * Math.sqrt(point.size / biggest) : 3.2;
        let parts = paths.get(point.s);
        if (!parts) paths.set(point.s, (parts = []));
        parts.push(dot(px(point.x), py(point.y), r));
      }
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push({ kind: 'path', d: parts.join(''), fill: paintOf(s).role, opacity: paintOf(s).opacity * 0.85 });
    } else {
      // The first series is drawn last, on top.
      for (let s = series.length - 1; s >= 0; s--) {
        const own = ordered.filter((entry) => entry.point.s === s);
        if (own.length === 0) continue;
        const top = own.map((entry, i) => `${i ? 'L' : 'M'}${n(px(entry.point.x))} ${n(py(entry.to))}`).join('');
        const paint = paintOf(s);
        if (mark === 'area') {
          const foot = [...own].reverse().map((entry) => `L${n(px(entry.point.x))} ${n(py(entry.from))}`).join('');
          out.push({ kind: 'path', d: `${top}${foot}Z`, fill: paint.role, opacity: stacked ? paint.opacity * 0.7 : 0.14 * paint.opacity + (s === 0 ? 0 : 0.02) });
        }
        if (!(mark === 'area' && stacked)) {
          out.push({ kind: 'path', d: top, stroke: paint.role, opacity: s === 0 ? 1 : Math.max(0.5, paint.opacity), width: s === 0 ? 2 : 1.25, dash: object.dash?.includes(series[s]) || undefined });
          if (own.length === 1) out.push({ kind: 'path', d: dot(px(own[0].point.x), py(own[0].to), 2.5), fill: paint.role });
        }
      }
      if (ends) {
        // Each line's last value beside its end; two that would sit on each other are moved apart.
        const labels = [...lastOf].map(([s, end]) => ({ s, ...end, at: end.y + 3.5 })).sort((a, b) => a.at - b.at);
        for (let i = 1; i < labels.length; i++) if (labels[i].at - labels[i - 1].at < 11) labels[i].at = labels[i - 1].at + 11;
        for (const label of labels) {
          out.push({ kind: 'path', d: rect(label.x - 2.5, label.y - 2.5, 5, 5), fill: paintOf(label.s).role });
          text(label.x + 7, label.at, shortNumber(label.value), 10, label.s === 0 ? 'ink' : 'muted');
        }
      }
    }

    for (const rule of across) {
      const ry = py(rule.at);
      out.push({ kind: 'path', d: `M${n(area.l)} ${n(ry)}H${n(edge)}`, stroke: 'ink', width: 1, dash: true });
      if (!small && rule.label) text(area.l, ry - 4, fits(rule.label, 9.5, panelW * 0.7), 9.5, 'ink');
    }
    for (const rule of upright) {
      if (numericX ? typeof rule.at !== 'number' : !nameAt.has(String(rule.at))) continue;
      const rx = px(rule.at);
      out.push({ kind: 'path', d: `M${n(rx)} ${n(area.t - 2)}V${n(area.b)}`, stroke: 'ink', width: 1, dash: true });
      if (!small && rule.label) text(rx + (rx > area.l + panelW * 0.6 ? -4 : 4), area.t + 8, fits(rule.label, 9.5, panelW * 0.5), 9.5, 'ink', { anchor: rx > area.l + panelW * 0.6 ? 'end' : undefined });
    }

    // Names along the bottom: under the last line of small charts only.
    if (!small && line === lines - 1) {
      if (numericX) {
        const xs = scaleFor(xlo, xhi, Math.max(1, Math.min(6, Math.floor((area.r - area.l) / 70))));
        for (const tick of ticksOf(xs)) if (tick >= xlo && tick <= xhi) text(px(tick), h - pad - 1, shortNumber(tick), 9.5, 'muted', { anchor: 'middle' });
      } else {
        const at = (i: number) => px(names[i]);
        const shown = names.map((name) => cut(name, faceted ? 8 : 14));
        const widest = Math.max(...shown.map((name) => mono(name, 9.5))) + 10;
        const picked = thinned(names.length, at, widest);
        for (const i of picked) {
          const anchor = mark === 'bar' || names.length === 1 ? 'middle' : i === 0 ? undefined : i === names.length - 1 ? 'end' : 'middle';
          text(at(i), h - pad - 1, shown[i], 9.5, 'muted', { anchor });
        }
      }
    }
  });
  return out;
}

const esc = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain colours for the roles, and the two faces: what a file needs, since it has no theme to ask. */
export type ChartPalette = Record<ChartRole, string> & { mono: string; sans: string };

/**
 * The same shapes as SVG text, for the still picture of a snapshot. Every word of the chart's is escaped
 * here; the paint comes from `palette`, which the caller makes from colours it has already checked.
 */
export function chartToSvg(object: ChartObject, palette: ChartPalette, options: ChartDrawOptions = {}): string {
  let out = '';
  for (const shape of chartShapes(object, options)) {
    if (shape.kind === 'text') {
      out += `<text x="${n(shape.x)}" y="${n(shape.y)}" font-size="${n(shape.size)}" font-family="${esc(shape.face === 'mono' ? palette.mono : palette.sans)}" fill="${esc(palette[shape.fill])}"${shape.anchor ? ` text-anchor="${shape.anchor}"` : ''}${shape.weight ? ` font-weight="${shape.weight}"` : ''}>${esc(shape.text)}</text>`;
      continue;
    }
    out += `<path d="${shape.d}" fill="${shape.fill ? esc(palette[shape.fill]) : 'none'}"${shape.stroke ? ` stroke="${esc(palette[shape.stroke])}" stroke-width="${n(shape.width ?? 1)}" stroke-linejoin="round" stroke-linecap="round"` : ''}${shape.opacity !== undefined && shape.opacity < 1 ? ` opacity="${n(shape.opacity)}"` : ''}${shape.dash ? ' stroke-dasharray="4 3"' : ''}/>`;
  }
  return out;
}

const MARK_NAMES = { bar: 'Bar chart', line: 'Line chart', area: 'Area chart', dot: 'Dot chart', cell: 'Grid', span: 'Timeline' } as const;

/**
 * A chart in words, from its data: what a screen reader says for it, what a snapshot's description
 * holds, and what an agent reads back in place of the rows.
 */
export function describeChart(object: ChartObject): string {
  const { mark, encode, fields, rows } = object;
  const unit = object.unit ? ` ${object.unit}` : '';
  const ys = Array.isArray(encode.y) ? encode.y : [encode.y];
  const column = (name: string) => rows.map((row) => row[fields.indexOf(name)]);
  const range = (values: ChartCell[]): string => {
    const numbers = values.filter((value): value is number => typeof value === 'number');
    return numbers.length ? `${shortNumber(Math.min(...numbers))} to ${shortNumber(Math.max(...numbers))}` : '';
  };
  const head = object.title ? `${object.title.trim()}. ` : '';
  const count = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
  if (mark === 'cell') {
    const size = `${namesOf(column(encode.x)).length} by ${namesOf(column(ys[0])).length}`;
    return `${head}${MARK_NAMES.cell} of ${encode.value ?? encode.series} by ${encode.x} and ${ys[0]}, ${size}${encode.value ? `, ${range(column(encode.value))}${unit}` : ''}.`;
  }
  if (mark === 'span') {
    const from = range([...column(encode.x), ...column(encode.x2 ?? encode.x)]);
    return `${head}${MARK_NAMES.span} of ${rows.length} ${rows.length === 1 ? 'span' : 'spans'} in ${namesOf(column(ys[0])).length} lanes, ${from}${unit}.`;
  }
  const x = column(encode.x);
  const along = `${String(x[0])} to ${String(x[x.length - 1])}`;
  const parts = ys.slice(0, 4).map((y) => {
    const values = column(y) as number[];
    // A line is read from its start to its end; bars and dots by how far they reach.
    return mark === 'line' || mark === 'area' ? `${y} from ${shortNumber(values[0])} to ${shortNumber(values[values.length - 1])}${unit}` : `${y} ${range(values)}${unit}`;
  });
  const split = encode.series ? `, by ${encode.series} (${namesOf(column(encode.series)).slice(0, 8).join(', ')})` : '';
  const small = encode.facet ? `, one small chart for each ${encode.facet}` : '';
  return `${head}${MARK_NAMES[mark]} of ${parts.join(', ')} by ${encode.x}${split}${small}: ${count}, ${along}.`;
}
