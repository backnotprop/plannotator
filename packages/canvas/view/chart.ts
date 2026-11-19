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
  /** `dash`: the line's own pattern of strokes and gaps, as SVG writes it ("6 4"). */
  | { kind: 'path'; d: string; fill?: ChartRole; stroke?: ChartRole; width?: number; opacity?: number; dash?: string }
  | { kind: 'text'; x: number; y: number; text: string; size: number; fill: ChartRole; anchor?: 'middle' | 'end'; face: 'mono' | 'sans'; weight?: number };

export interface ChartDrawOptions {
  w?: number;
  h?: number;
  /** `marks`: no words at all, and heavier lines, for a chart too small on screen to read. */
  detail?: 'full' | 'marks';
}

/**
 * How each series is filled, in order. The first is the object's colour at full strength. Every step is
 * at least 3 to 1 against the card on a light and on a dark board (ink never under 0.55, the colour never
 * under 0.82), so no part of a chart is a faint patch. The fourth and fifth are HOLLOW: an outline with
 * nothing in it, so the first five differ by more than a shade. A line also has its own pattern and its
 * name at its end, a dot its own outline, and the legend names every series.
 */
const SERIES: readonly { role: ChartRole; opacity: number; hollow?: true }[] = [
  { role: 'accent', opacity: 1 },
  { role: 'ink', opacity: 0.55 },
  { role: 'ink', opacity: 0.9 },
  { role: 'accent', opacity: 1, hollow: true },
  { role: 'ink', opacity: 1, hollow: true },
  { role: 'accent', opacity: 0.82 },
  { role: 'ink', opacity: 0.7 },
  { role: 'ink', opacity: 0.55, hollow: true },
];
const paintOf = (series: number) => SERIES[series % SERIES.length];
/** A series' marks as one shape: filled, or for a hollow series drawn as outlines. */
const filled = (d: string, series: number): ChartShape => {
  const paint = paintOf(series);
  return paint.hollow ? { kind: 'path', d, stroke: paint.role, width: 1.5, opacity: paint.opacity } : { kind: 'path', d, fill: paint.role, opacity: paint.opacity };
};

/** The pattern of each line after the first, which is solid: no two series are told apart by colour alone. */
const DASHES = ['7 4', '2 3', '10 3 2 3', '1 4', '12 4', '5 2 1 2', '3 6'] as const;
/** The pattern of a rule: a mark on the chart, not a series. */
const RULE_DASH = '4 3';

/**
 * How much of its square a cell fills, in five steps, for a chart of amounts. The amount is the SIZE of
 * the tile, drawn in the colour at full strength, so the smallest amount is still a mark that can be seen
 * and the steps do not depend on telling shades apart. Few enough that every tile of a step is one path.
 */
const CELL_STEPS = [0.34, 0.5, 0.66, 0.83, 1] as const;

const MONO_W = 0.61;
const n = (value: number): string => String(Math.round(value * 100) / 100);
const rect = (x: number, y: number, w: number, h: number): string => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
const poly = (points: [number, number][]): string => `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('')}z`;
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

/** A dot's outline, one for each series in turn: a round one, a square, a diamond, and so on. `r` is half its width. */
function marker(series: number, x: number, y: number, r: number): string {
  const t = r * 0.42;
  switch (series % 8) {
    case 0:
      return `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0z`;
    case 1:
      return rect(x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72);
    case 2:
      return poly([[x, y - r * 1.2], [x + r * 1.2, y], [x, y + r * 1.2], [x - r * 1.2, y]]);
    case 3:
      return poly([[x, y - r * 1.15], [x + r * 1.15, y + r * 0.9], [x - r * 1.15, y + r * 0.9]]);
    case 4:
      return poly([[x - r * 1.15, y - r * 0.9], [x + r * 1.15, y - r * 0.9], [x, y + r * 1.15]]);
    case 5:
      return poly([[x - t, y - r * 1.1], [x + t, y - r * 1.1], [x + t, y - t], [x + r * 1.1, y - t], [x + r * 1.1, y + t], [x + t, y + t], [x + t, y + r * 1.1], [x - t, y + r * 1.1], [x - t, y + t], [x - r * 1.1, y + t], [x - r * 1.1, y - t], [x - t, y - t]]);
    case 6:
      return rect(x - r * 1.2, y - t, r * 2.4, t * 2);
    default:
      return rect(x - t, y - r * 1.2, t * 2, r * 2.4);
  }
}

/** A round step for an axis: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, steps: number): number {
  const raw = span / Math.max(1, steps);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/** A number as a person would write it on an axis. Nothing is never "-0". */
export function shortNumber(given: number): string {
  const value = given + 0 === 0 ? 0 : given;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${n(value / 1e9)}B`;
  if (abs >= 1e6) return `${n(value / 1e6)}M`;
  if (abs >= 1e4) return `${n(value / 1e3)}k`;
  // Thousands are grouped by hand: asking the locale for it is slow enough to show in a frame of 200 charts.
  if (Number.isInteger(value)) return abs < 1000 ? String(value) : `${value < 0 ? '-' : ''}${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, '0')}`;
  if (abs < 0.001) return String(Number(value.toPrecision(2)));
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
  return { lo: from, hi: to > from ? to : from + 1, step };
}

const ticksOf = (scale: Scale): number[] => {
  const out: number[] = [];
  // Counted, not added up, so no rounding error grows along the axis; and never more than a chart can hold.
  const count = Math.max(1, Math.min(40, Math.round((scale.hi - scale.lo) / scale.step)));
  for (let i = 0; i <= count; i++) out.push(scale.lo + ((scale.hi - scale.lo) * i) / count);
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

interface Plotted {
  /** The series' names, in the order they are drawn and listed. */
  series: string[];
  /** One for each small chart a `facet` asks for; one in all when there is none. Points in the order of the x axis. */
  facets: { name: string; points: Point[] }[];
  /** The x axis is a number line: every x is a number, and the mark is not a bar. */
  numericX: boolean;
  /** The names along the x axis when it is not a number line, in the order they first appear in ALL the rows. */
  names: string[];
}

/**
 * A chart's rows as points: split into the small charts a `facet` asks for, the series named, and each
 * small chart's points put in the order of the x axis (numbers by size; names by where each first appears
 * in the whole table). So a line runs left to right whatever order its rows came in, and "the latest" is
 * the right-most point. The drawing and the description both read this, so they cannot disagree.
 */
function plot(object: ChartObject): Plotted {
  const { encode, fields, rows, mark } = object;
  const ys = Array.isArray(encode.y) ? encode.y : [encode.y];
  const xi = fields.indexOf(encode.x);
  const yi = ys.map((y) => fields.indexOf(y));
  const si = encode.series ? fields.indexOf(encode.series) : -1;
  const zi = encode.size ? fields.indexOf(encode.size) : -1;
  const fi = encode.facet ? fields.indexOf(encode.facet) : -1;
  const series = si !== -1 ? namesOf(rows.map((row) => row[si])) : ys;
  const seriesAt = new Map(series.map((name, index) => [name, index]));
  const facets = new Map<string, Point[]>();
  for (const row of rows) {
    const key = fi === -1 ? '' : String(row[fi]);
    let points = facets.get(key);
    if (!points) facets.set(key, (points = []));
    const size = zi === -1 ? 0 : Math.max(0, Number(row[zi]) || 0);
    if (si !== -1) points.push({ s: seriesAt.get(String(row[si])) ?? 0, x: row[xi], y: Number(row[yi[0]]) || 0, size });
    else yi.forEach((column, s) => points!.push({ s, x: row[xi], y: Number(row[column]) || 0, size }));
  }
  const numericX = mark !== 'bar' && rows.every((row) => typeof row[xi] === 'number');
  const names = numericX ? [] : namesOf(rows.map((row) => row[xi]));
  const nameAt = new Map(names.map((name, index) => [name, index]));
  const place = (point: Point): number => (numericX ? (point.x as number) : (nameAt.get(String(point.x)) ?? 0));
  // A stable sort: points at one place keep the order their rows came in.
  return { series, facets: [...facets].map(([name, points]) => ({ name, points: points.map((point, i) => ({ point, i })).sort((a, b) => place(a.point) - place(b.point) || a.i - b.i).map((entry) => entry.point) })), numericX, names };
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

/** Labels that would sit on each other, moved apart, and kept between `top` and `bottom` when there is room. */
function spread<T extends { at: number }>(labels: T[], gap: number, top: number, bottom: number): T[] {
  const sorted = [...labels].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].at - sorted[i - 1].at < gap) sorted[i].at = sorted[i - 1].at + gap;
  const last = sorted[sorted.length - 1];
  if (last && last.at > bottom) {
    last.at = Math.max(top + gap * (sorted.length - 1), bottom);
    for (let i = sorted.length - 2; i >= 0; i--) if (sorted[i + 1].at - sorted[i].at < gap) sorted[i].at = sorted[i + 1].at - gap;
  }
  return sorted;
}

/** The shapes of one chart, in a box `w` by `h` with its corner at 0,0, back to front. */
export function chartShapes(object: ChartObject, options: ChartDrawOptions = {}): ChartShape[] {
  const w = options.w ?? object.w;
  const h = options.h ?? object.h;
  const words = options.detail !== 'marks';
  /** Drawn small on screen, a line is made heavier and loses its pattern, so it is still a line. */
  const heavy = words ? 1 : 3;
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
  const { series, facets, numericX, names } = xy ? plot(object) : { series: [] as string[], facets: [] as Plotted['facets'], numericX: false, names: [] as string[] };
  const kinds = !xy && encode.series ? namesOf(rows.map((row) => row[fields.indexOf(encode.series!)])) : [];
  const faceted = xy && facets.length > 1;
  const flipped = mark === 'bar' && !!object.flip && !faceted;
  const stacked = !!object.stack && (mark === 'bar' || mark === 'area') && series.length > 1;
  const lined = mark === 'line' || (mark === 'area' && !stacked);
  /** Lines that end in the open: each is named there, beside its last value, so the legend is not needed. */
  const ends = !small && !faceted && lined;
  const amounts = mark === 'cell' && !!encode.value && !encode.series;
  /** One sideways bar made of parts: each part is named over itself, so the legend is not needed. */
  const whole = flipped && stacked && names.length === 1 && !small;
  const legend = xy ? (series.length > 1 && !ends && !whole ? series : []) : kinds;
  /** A series' line: the first is solid, every other has a pattern of its own. `dash` gives the first one too. */
  const firstDashed = object.dash?.includes(series[0]) ?? false;
  const dashOf = (s: number): string | undefined => {
    if (!words) return undefined;
    if (s === 0) return firstDashed ? DASHES[0] : undefined;
    return DASHES[(s - (firstDashed ? 0 : 1)) % DASHES.length];
  };
  let y = pad;
  if (!tiny && object.title && (h >= 80 || !small)) {
    text(pad, y + 8, fits(object.title.toUpperCase(), 10, w - pad * 2), 10, 'muted', { weight: 500 });
    y += 20;
  }
  if (!small && !faceted && (mark === 'line' || mark === 'area') && facets[0]) {
    // The latest value of the first series, large: its right-most point, whatever order the rows came in.
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
    // Every series is named, in the order drawn, on as many lines as that takes. Its room is kept when no
    // words are drawn, so the marks do not move when the detail changes.
    let at = pad;
    legend.forEach((name, s) => {
      const swatch = mark === 'line' || mark === 'area' ? 22 : 14;
      // A name is cut only when it is longer than a whole line of the chart.
      const label = fits(name, 10, w - pad * 2 - swatch - 2);
      const width = swatch + mono(label, 10) + 14;
      if (at > pad && at + width > w - pad) {
        at = pad;
        y += 16;
      }
      const paint = paintOf(s);
      if (words) {
        if (mark === 'line' || (mark === 'area' && !stacked)) out.push({ kind: 'path', d: `M${n(at)} ${n(y + 6)}h18`, stroke: paint.role, opacity: Math.max(0.75, paint.opacity), width: s === 0 ? 2 : 1.5, dash: dashOf(s) });
        else if (mark === 'dot') out.push(filled(marker(s, at + 4.5, y + 6, 4), s));
        else out.push(filled(rect(at + 0.75, y + 2.75, 8, 7), s));
      }
      text(at + swatch, y + 9, label, 10, s === 0 ? 'ink' : 'muted');
      at += width;
    });
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
    let lo = Infinity;
    let hi = -Infinity;
    if (vi !== -1) for (const row of rows) {
      lo = Math.min(lo, Number(row[vi]));
      hi = Math.max(hi, Number(row[vi]));
    }
    if (amounts && !small) {
      // What the sizes mean, said on every chart of amounts, titled or not: the least, the five steps, the most.
      const from = shortNumber(lo);
      text(pad, y + 9, from, 10, 'muted');
      let at = pad + mono(from, 10) + 7;
      if (words) for (const step of CELL_STEPS) {
        out.push({ kind: 'path', d: rect(at + (10 - 10 * step) / 2, y + 1 + (10 - 10 * step) / 2, 10 * step, 10 * step), fill: 'accent' });
        at += 13;
      }
      text(at + 4, y + 9, `${shortNumber(hi)}${unit ? ` ${unit}` : ''}`, 10, 'muted');
      y += 18;
    }
    const gutter = small ? 0 : Math.min(w * 0.34, Math.max(...lanes.map((lane) => mono(lane, 9.5))) + 8);
    const area: Area = { l: pad + gutter, t: y + (small ? 0 : 2), r: w - pad, b: h - pad - (small ? 0 : 14) };
    const cw = Math.max(0.5, (area.r - area.l) / columns.length);
    const ch = Math.max(0.5, (area.b - area.t) / lanes.length);
    const gap = Math.min(1.5, cw * 0.12, ch * 0.12);
    // One path for each step or kind, however many cells there are.
    const groups = new Map<number, string[]>();
    const column = new Map(columns.map((name, index) => [name, index]));
    const lane = new Map(lanes.map((name, index) => [name, index]));
    for (const row of rows) {
      const cx = area.l + column.get(String(row[xi]))! * cw;
      const cy = area.t + lane.get(String(row[yi]))! * ch;
      const group = ki !== -1 ? kinds.indexOf(String(row[ki])) : hi === lo ? CELL_STEPS.length - 1 : Math.min(CELL_STEPS.length - 1, Math.floor(((Number(row[vi]) - lo) / (hi - lo)) * CELL_STEPS.length));
      let parts = groups.get(group);
      if (!parts) groups.set(group, (parts = []));
      const fw = Math.max(0.5, cw - gap);
      const fh = Math.max(0.5, ch - gap);
      const share = ki !== -1 ? 1 : CELL_STEPS[group];
      parts.push(rect(cx + gap / 2 + (fw - fw * share) / 2, cy + gap / 2 + (fh - fh * share) / 2, fw * share, fh * share));
    }
    // The ground every tile of amounts stands on: where a cell is, however little it holds.
    if (ki === -1) hair(`${[...Array(columns.length + 1).keys()].map((i) => `M${n(area.l + i * cw)} ${n(area.t)}V${n(area.b)}`).join('')}${[...Array(lanes.length + 1).keys()].map((i) => `M${n(area.l)} ${n(area.t + i * ch)}H${n(area.r)}`).join('')}`);
    for (const [group, parts] of [...groups].sort((a, b) => a[0] - b[0])) out.push(ki !== -1 ? filled(parts.join(''), group) : { kind: 'path', d: parts.join(''), fill: 'accent' });
    if (!small) {
      const rowEvery = Math.max(1, Math.ceil(11 / ch));
      lanes.forEach((name, index) => {
        if (index % rowEvery === 0) text(pad, area.t + (index + 0.5) * ch + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
      });
      const at = (index: number) => area.l + (index + 0.5) * cw;
      const widest = Math.max(...columns.map((name) => mono(cut(name, 12), 9.5))) + 8;
      for (const index of thinned(columns.length, at, widest)) text(at(index), h - pad - 1, cut(columns[index], 12), 9.5, 'muted', { anchor: 'middle' });
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
    const ticks = ticksOf(scale);
    hair(ticks.map((tick) => `M${n(px(tick))} ${n(area.t)}V${n(area.b)}`).join(''));
    if (!small) for (const tick of ticks) text(px(tick), h - pad - 1, shortNumber(tick), 9.5, 'muted', { anchor: tick === ticks[0] ? undefined : tick === ticks[ticks.length - 1] ? 'end' : 'middle' });
    // Spans in one lane that overlap in time are stood in rows of their own, so none is painted over another.
    const lane = new Map(lanes.map((name, index) => [name, index]));
    const placed = rows
      .map((row) => ({ lane: lane.get(String(row[yi]))!, from: Math.min(Number(row[xi]), Number(row[x2i])), to: Math.max(Number(row[xi]), Number(row[x2i])), group: ki === -1 ? 0 : kinds.indexOf(String(row[ki])), row: 0 }))
      .sort((a, b) => a.lane - b.lane || a.from - b.from);
    const depth = lanes.map(() => 1);
    const busy: number[][] = lanes.map(() => []);
    for (const span of placed) {
      const until = busy[span.lane];
      let free = until.findIndex((end) => end <= span.from);
      if (free === -1) free = until.length;
      until[free] = span.to;
      span.row = free;
      depth[span.lane] = Math.max(depth[span.lane], free + 1);
    }
    const groups = new Map<number, string[]>();
    for (const span of placed) {
      const rowsHere = depth[span.lane];
      const band = (rowH * 0.78) / rowsHere;
      const thick = Math.max(1, Math.min(band * (rowsHere > 1 ? 0.86 : 0.72), 18));
      const top = area.t + span.lane * rowH + (rowH - band * rowsHere) / 2 + span.row * band + (band - thick) / 2;
      let parts = groups.get(span.group);
      if (!parts) groups.set(span.group, (parts = []));
      parts.push(rect(px(span.from), top, Math.max(2, px(span.to) - px(span.from)), thick));
    }
    for (const [group, parts] of [...groups].sort((a, b) => a[0] - b[0])) out.push(filled(parts.join(''), group));
    if (!small) {
      const rowEvery = Math.max(1, Math.ceil(11 / rowH));
      lanes.forEach((name, index) => {
        if (index % rowEvery === 0) text(pad, area.t + (index + 0.5) * rowH + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
      });
    }
    for (const rule of upright) {
      if (typeof rule.at !== 'number') continue;
      const rx = px(rule.at);
      out.push({ kind: 'path', d: `M${n(rx)} ${n(area.t - 2)}V${n(area.b)}`, stroke: 'ink', width: heavy, dash: RULE_DASH });
      if (!small && rule.label) text(rx + (rx > w * 0.6 ? -4 : 4), area.t - 5, fits(rule.label, 9.5, w * 0.5), 9.5, 'ink', { anchor: rx > w * 0.6 ? 'end' : undefined });
    }
    return out;
  }

  // ── Bars, lines, areas and dots: one or more small charts on shared scales ──
  const all = facets.flatMap((facet) => facet.points);
  const nameAt = new Map(names.map((name, index) => [name, index]));
  /** Each point's top and foot on the value axis: its own value, or its place in a stack. */
  const stackOf = (points: Point[]): { point: Point; from: number; to: number }[] => {
    if (!stacked) return points.map((point) => ({ point, from: 0, to: point.y }));
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    // By series, then along the axis: each series' points stay in the order of the x axis.
    return points.map((point, i) => ({ point, i })).sort((a, b) => a.point.s - b.point.s || a.i - b.i).map(({ point }) => {
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
  if (numericX) {
    for (const point of all) {
      xlo = Math.min(xlo, point.x as number);
      xhi = Math.max(xhi, point.x as number);
    }
    // An upright rule past the data is still inside the chart: the x axis grows to hold it.
    for (const rule of upright) if (typeof rule.at === 'number') {
      xlo = Math.min(xlo, rule.at);
      xhi = Math.max(xhi, rule.at);
    }
    if (mark === 'dot') {
      // Dots sit inside round ends, so none is cut by the chart's edge.
      const round = scaleFor(xlo, xhi, 4);
      xlo = round.lo;
      xhi = round.hi;
    }
  }
  const biggest = Math.max(0, ...all.map((point) => point.size));
  /** The words at each line's end: its last value, and its name when there is more than one line. */
  const endWords = (s: number, value: number) => `${shortNumber(value)}${series.length > 1 ? ` ${cut(series[s], 14)}` : ''}`;
  // Room for those words: measured from each line's last point only (writing a number out is the slow part of a chart).
  const lasts = new Map<number, number>();
  if (ends) for (const point of all) lasts.set(point.s, point.y);
  const endRoom = ends ? Math.min(w * 0.36, Math.max(36, ...[...lasts].map(([s, value]) => mono(endWords(s, value), 10))) + 12) : 0;

  const columns = faceted ? Math.min(facets.length, Math.max(1, Math.round(Math.sqrt((facets.length * w) / Math.max(1, h))))) : 1;
  const lines = Math.ceil(facets.length / columns);
  const body: Area = { l: pad, t: y + (small ? 0 : faceted ? 24 : 12), r: w - pad, b: h - pad - (small ? 0 : 14) };
  const gapX = faceted ? 12 : 0;
  const gapY = faceted ? 38 : 0;
  const panelW = (body.r - body.l - gapX * (columns - 1)) / columns;
  const panelH = (body.b - body.t - gapY * (lines - 1)) / lines;

  facets.forEach((facet, index) => {
    const col = index % columns;
    const line = Math.floor(index / columns);
    const area: Area = { l: body.l + col * (panelW + gapX), t: body.t + line * (panelH + gapY), r: 0, b: 0 };
    area.b = area.t + panelH;
    const edge = area.l + panelW;
    area.r = edge;
    // Its name stands on a line of its own, above the value written on the top rule.
    if (faceted) text(area.l, area.t - 15, fits(facet.name, 9.5, panelW), 9.5, 'ink');
    const placed = stacks[index];
    /** Nothing sits under this small chart, so the names along its foot are written. */
    const footed = index + columns >= facets.length;

    if (flipped) {
      // Names down the left, values running right.
      const gutter = small ? 0 : Math.min(w * 0.36, Math.max(...names.map((name) => mono(name, 9.5))) + 10);
      const left = area.l + gutter;
      const scale = scaleFor(lo, hi, Math.max(2, Math.min(6, Math.floor((edge - left) / 70))));
      const px = (value: number) => left + ((value - scale.lo) / (scale.hi - scale.lo)) * (edge - left);
      const ticks = ticksOf(scale);
      const top0 = area.t + (whole ? 14 : 0);
      hair(ticks.filter((tick) => tick !== 0).map((tick) => `M${n(px(tick))} ${n(top0)}V${n(area.b)}`).join(''));
      hair(`M${n(px(Math.max(scale.lo, Math.min(0, scale.hi))))} ${n(top0)}V${n(area.b)}`, 'muted');
      if (!small) for (const tick of ticks) text(px(tick), h - pad - 1, `${shortNumber(tick)}${tick === ticks[ticks.length - 1] && unit ? ` ${unit}` : ''}`, 9.5, 'muted', { anchor: tick === ticks[0] ? undefined : tick === ticks[ticks.length - 1] ? 'end' : 'middle' });
      const band = Math.max(1, (area.b - top0) / Math.max(1, names.length));
      const gap = Math.min(8, band * 0.24);
      const groups = stacked ? 1 : series.length;
      const thick = Math.max(1, Math.min((band - gap) / groups, 28));
      const inset = (band - thick * groups) / 2;
      const paths = new Map<number, string[]>();
      for (const { point, from, to } of placed) {
        const top = top0 + nameAt.get(String(point.x))! * band + inset + (stacked ? 0 : point.s * thick);
        const a = px(Math.min(from, to));
        const b = px(Math.max(from, to));
        let parts = paths.get(point.s);
        if (!parts) paths.set(point.s, (parts = []));
        parts.push(rect(a + (stacked && from !== 0 ? 0.75 : 0), top, Math.max(1, b - a - (stacked && from !== 0 ? 0.75 : 0)), thick));
        if (whole) {
          const label = `${cut(series[point.s], 16)} ${shortNumber(point.y)}`;
          if (mono(label, 9.5) <= b - a - 2) text(a + 1, top - 5, label, 9.5, point.s === 0 ? 'ink' : 'muted');
        }
      }
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push(filled(parts.join(''), s));
      if (!small) {
        const every = Math.max(1, Math.ceil(11 / band));
        names.forEach((name, i) => {
          if (i % every === 0) text(area.l, top0 + (i + 0.5) * band + 3.5, fits(name, 9.5, gutter - 6), 9.5, 'muted');
        });
      }
      for (const rule of across) {
        out.push({ kind: 'path', d: `M${n(px(rule.at))} ${n(top0 - 2)}V${n(area.b)}`, stroke: 'ink', width: heavy, dash: RULE_DASH });
        if (!small && rule.label) text(px(rule.at) + (px(rule.at) > w * 0.6 ? -4 : 4), top0 + 8, fits(rule.label, 9.5, w * 0.4), 9.5, 'ink', { anchor: px(rule.at) > w * 0.6 ? 'end' : undefined });
      }
      return;
    }

    const scale = scaleFor(lo, hi, Math.max(2, Math.min(5, Math.floor(panelH / 46))));
    // The values written on the rules get a margin of their own, so no mark is drawn under them.
    const labelled = !small && (!faceted || col === columns - 1 || index === facets.length - 1);
    // Every small chart keeps the same margin, written in or not, so their marks line up down the page.
    const margin = ends ? endRoom : labelled || (faceted && !small) ? Math.max(...ticksOf(scale).map((tick) => mono(shortNumber(tick), 9.5))) + (unit ? mono(unit, 9.5) + 6 : 0) + 8 : 0;
    area.r = edge - Math.min(margin, panelW * 0.45);
    const py = (value: number) => area.b - ((value - scale.lo) / (scale.hi - scale.lo)) * (area.b - area.t);
    const band = (area.r - area.l) / Math.max(1, names.length);
    const px = (value: ChartCell): number => {
      if (numericX) return xhi === xlo ? (area.l + area.r) / 2 : area.l + (((value as number) - xlo) / (xhi - xlo)) * (area.r - area.l);
      const at = nameAt.get(String(value)) ?? 0;
      if (mark === 'bar') return area.l + band * (at + 0.5);
      return names.length === 1 ? (area.l + area.r) / 2 : area.l + ((area.r - area.l) * at) / (names.length - 1);
    };
    const base = py(Math.max(scale.lo, Math.min(0, scale.hi)));

    // Where each line ends: its right-most point, since the points are in the order of the x axis.
    const lastOf = new Map<number, { x: number; y: number; value: number }>();
    if (mark === 'line' || mark === 'area') for (const { point, to } of placed) lastOf.set(point.s, { x: px(point.x), y: py(to), value: point.y });

    // Rules, each with its value sitting on it. The one at nothing is the ground the marks stand on.
    const ticks = ticksOf(scale);
    hair(ticks.filter((tick) => Math.abs(py(tick) - base) > 0.5).map((tick) => `M${n(area.l)} ${n(py(tick))}H${n(ends ? area.r : edge)}`).join(''));
    hair(`M${n(area.l)} ${n(base)}H${n(ends ? area.r : edge)}`, 'muted');
    if (labelled && !ends) {
      const top = ticks[ticks.length - 1];
      for (const tick of ticks) {
        const ty = py(tick);
        if (Math.abs(ty - base) <= 0.5) continue;
        text(edge, ty - 4, `${shortNumber(tick)}${tick === top && unit ? ` ${unit}` : ''}`, 9.5, 'muted', { anchor: 'end' });
      }
    } else if (ends) {
      // With names at the line ends, the rules' values are written at the left, on the rules.
      for (const tick of ticks) if (Math.abs(py(tick) - base) > 0.5) text(area.l, py(tick) - 4, shortNumber(tick), 9.5, 'muted');
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
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push(filled(parts.join(''), s));
    } else if (mark === 'dot') {
      const paths = new Map<number, string[]>();
      for (const { point } of placed) {
        const r = biggest > 0 ? 2.5 + 9.5 * Math.sqrt(point.size / biggest) : 3.2;
        let parts = paths.get(point.s);
        if (!parts) paths.set(point.s, (parts = []));
        parts.push(marker(point.s, px(point.x), py(point.y), r));
      }
      for (const [s, parts] of [...paths].sort((a, b) => a[0] - b[0])) out.push(filled(parts.join(''), s));
    } else {
      // The first series is drawn last, on top.
      for (let s = series.length - 1; s >= 0; s--) {
        const own = placed.filter((entry) => entry.point.s === s);
        if (own.length === 0) continue;
        const top = own.map((entry, i) => `${i ? 'L' : 'M'}${n(px(entry.point.x))} ${n(py(entry.to))}`).join('');
        const paint = paintOf(s);
        if (mark === 'area') {
          const foot = [...own].reverse().map((entry) => `L${n(px(entry.point.x))} ${n(py(entry.from))}`).join('');
          // Stacked, an area is a part and is filled like one. Alone it is a line with a wash under it: the line is the mark.
          out.push(stacked ? filled(`${top}${foot}Z`, s) : { kind: 'path', d: `${top}${foot}Z`, fill: paint.role, opacity: 0.14 });
        }
        if (!(mark === 'area' && stacked)) {
          out.push({ kind: 'path', d: top, stroke: paint.role, opacity: s === 0 ? 1 : Math.max(0.75, paint.opacity), width: (s === 0 ? 2 : 1.5) * heavy, dash: dashOf(s) });
          if (own.length === 1) out.push({ kind: 'path', d: marker(0, px(own[0].point.x), py(own[0].to), 2.5), fill: paint.role });
        }
      }
      if (ends) {
        // Each line's last value and its name beside its end; two that would sit on each other are moved apart.
        const labels = spread([...lastOf].map(([s, end]) => ({ s, ...end, at: end.y + 3.5 })), 11, area.t + 4, area.b + 3);
        for (const label of labels) {
          out.push({ kind: 'path', d: rect(label.x - 2.5, label.y - 2.5, 5, 5), fill: paintOf(label.s).role });
          text(label.x + 7, label.at, fits(endWords(label.s, label.value), 10, edge - label.x - 7), 10, label.s === 0 ? 'ink' : 'muted');
        }
      }
    }

    for (const rule of across) {
      const ry = py(rule.at);
      out.push({ kind: 'path', d: `M${n(area.l)} ${n(ry)}H${n(ends ? area.r : edge)}`, stroke: 'ink', width: heavy, dash: RULE_DASH });
      if (!small && rule.label) text(ends ? area.r : area.l, ry - 4, fits(rule.label, 9.5, panelW * 0.7), 9.5, 'ink', { anchor: ends ? 'end' : undefined });
    }
    for (const rule of upright) {
      if (numericX ? typeof rule.at !== 'number' : !nameAt.has(String(rule.at))) continue;
      const rx = px(rule.at);
      out.push({ kind: 'path', d: `M${n(rx)} ${n(area.t - 2)}V${n(area.b)}`, stroke: 'ink', width: heavy, dash: RULE_DASH });
      const leftward = rx > area.l + (area.r - area.l) * 0.6;
      if (!small && rule.label) text(rx + (leftward ? -4 : 4), area.t + 8, fits(rule.label, 9.5, panelW * 0.5), 9.5, 'ink', { anchor: leftward ? 'end' : undefined });
    }

    // Names along the foot of every small chart that has nothing under it.
    if (!small && footed) {
      const foot = line === lines - 1 ? h - pad - 1 : area.b + 12;
      if (numericX) {
        const xs = scaleFor(xlo, xhi, Math.max(1, Math.min(6, Math.floor((area.r - area.l) / 70))));
        for (const tick of ticksOf(xs)) if (tick >= xlo && tick <= xhi) text(px(tick), foot, shortNumber(tick), 9.5, 'muted', { anchor: 'middle' });
      } else {
        const at = (i: number) => px(names[i]);
        const shown = names.map((name) => cut(name, faceted ? 8 : 14));
        const widest = Math.max(...shown.map((name) => mono(name, 9.5))) + 10;
        for (const i of thinned(names.length, at, widest)) {
          const anchor = mark === 'bar' || names.length === 1 ? 'middle' : i === 0 ? undefined : i === names.length - 1 ? 'end' : 'middle';
          text(at(i), foot, shown[i], 9.5, 'muted', { anchor });
        }
      }
    }
  });
  return out;
}

/** Text made safe for XML: the five characters escaped, and the control characters XML forbids taken out (one of them makes the whole file fail to load). */
export const escapeXml = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = escapeXml;

/** Plain colours for the roles, and the two faces: what a file needs, since it has no theme to ask. */
export type ChartPalette = Record<ChartRole, string> & { mono: string; sans: string };

/**
 * The same shapes as SVG text, for the still picture of a snapshot. Every word of the chart's is escaped
 * here, and so is every paint: the caller hands colours over as they are, not escaped already.
 */
export function chartToSvg(object: ChartObject, palette: ChartPalette, options: ChartDrawOptions = {}): string {
  let out = '';
  for (const shape of chartShapes(object, options)) {
    if (shape.kind === 'text') {
      out += `<text x="${n(shape.x)}" y="${n(shape.y)}" font-size="${n(shape.size)}" font-family="${esc(shape.face === 'mono' ? palette.mono : palette.sans)}" fill="${esc(palette[shape.fill])}"${shape.anchor ? ` text-anchor="${shape.anchor}"` : ''}${shape.weight ? ` font-weight="${shape.weight}"` : ''}>${esc(shape.text)}</text>`;
      continue;
    }
    out += `<path d="${shape.d}" fill="${shape.fill ? esc(palette[shape.fill]) : 'none'}"${shape.stroke ? ` stroke="${esc(palette[shape.stroke])}" stroke-width="${n(shape.width ?? 1)}" stroke-linejoin="round" stroke-linecap="round"` : ''}${shape.opacity !== undefined && shape.opacity < 1 ? ` opacity="${n(shape.opacity)}"` : ''}${shape.dash ? ` stroke-dasharray="${esc(shape.dash)}"` : ''}/>`;
  }
  return out;
}

const MARK_NAMES = { bar: 'Bar chart', line: 'Line chart', area: 'Area chart', dot: 'Dot chart', cell: 'Grid', span: 'Timeline' } as const;

/** How many series a description spells out one by one. Past it, it says how many there are and how far they reach. */
const DESCRIBED = 4;

/**
 * A chart in words, from its data: what a screen reader says for it, what a snapshot's description
 * holds, and what an agent reads back in place of the rows. It must be TRUE of the rows. So a line is
 * read from its left-most point to its right-most, one series at a time, never across series; and where
 * there are too many series, or small charts, it gives how far the values reach and claims no direction.
 */
export function describeChart(object: ChartObject): string {
  const { mark, encode, fields, rows } = object;
  const unit = object.unit ? ` ${object.unit}` : '';
  const ys = Array.isArray(encode.y) ? encode.y : [encode.y];
  const column = (name: string) => rows.map((row) => row[fields.indexOf(name)]);
  const reach = (values: number[]): string => (values.length ? `${shortNumber(Math.min(...values))} to ${shortNumber(Math.max(...values))}` : '');
  const numbers = (values: ChartCell[]): number[] => values.filter((value): value is number => typeof value === 'number');
  const head = object.title ? `${object.title.trim()}. ` : '';
  const count = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
  if (mark === 'cell') {
    const size = `${namesOf(column(encode.x)).length} by ${namesOf(column(ys[0])).length}`;
    return `${head}${MARK_NAMES.cell} of ${encode.value ?? encode.series} by ${encode.x} and ${ys[0]}, ${size}${encode.value ? `, ${reach(numbers(column(encode.value)))}${unit}` : ''}.`;
  }
  if (mark === 'span') {
    const from = reach(numbers([...column(encode.x), ...column(encode.x2 ?? encode.x)]));
    return `${head}${MARK_NAMES.span} of ${rows.length} ${rows.length === 1 ? 'span' : 'spans'} in ${namesOf(column(ys[0])).length} lanes, ${from}${unit}.`;
  }
  const { series, facets, numericX, names } = plot(object);
  const all = facets.flatMap((facet) => facet.points);
  const xs = numericX ? numbers(all.map((point) => point.x)) : [];
  const along = numericX ? reach(xs) : `${names[0]} to ${names[names.length - 1]}`;
  const measured = encode.series ? ys[0] : '';
  let said: string;
  if (facets.length > 1 || series.length > DESCRIBED) {
    // Too many to read one by one, or split into small charts: how far the values reach, and no direction.
    const what = encode.series ? `${measured} in ${series.length} series by ${encode.series}` : ys.join(', ');
    said = `${what}, ${reach(all.map((point) => point.y))}${unit}`;
  } else {
    const directed = mark === 'line' || mark === 'area';
    const parts = series.map((name, s) => {
      const own = facets[0].points.filter((point) => point.s === s);
      const values = own.map((point) => point.y);
      // A line is read from its left end to its right end; bars and dots by how far they reach.
      return directed && own.length > 1 ? `${name} from ${shortNumber(values[0])} to ${shortNumber(values[values.length - 1])}${unit}` : `${name} ${reach(values)}${unit}`;
    });
    said = encode.series ? `${measured} by ${encode.series}: ${parts.join(', ')}` : parts.join(', ');
  }
  const small = facets.length > 1 ? `, one small chart for each ${encode.facet} (${facets.length})` : '';
  return `${head}${MARK_NAMES[mark]} of ${said}, by ${encode.x}${small}: ${count}, ${along}.`;
}
