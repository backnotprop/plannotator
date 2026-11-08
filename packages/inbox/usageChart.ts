/**
 * Settings → Usage's chart, the pure half (components/UsageChart.tsx draws it):
 * the span, the layout that fits the width, the SVG paths, hit testing and
 * the arrow-key moves. One row per thread in the order threads began, one
 * column per hour; a mark for each hour with messages.
 *
 * Two looks. "blend" (the default): the mark's size follows the hour's count,
 * neighbouring hours flow into one soft translucent shape (`usageJoin`), its
 * opacity a subtle step by the run's busiest hour, and a faint strand runs
 * along the thread between its first and last hour on screen. "dots" (dev only, `?usage-look=dots`): same-size
 * dots that never touch, the count in colour (five steps of the accent).
 */
import type { InboxUsageModel } from '@plannotator/core/inbox-types';

export const HOUR_MS = 3_600_000;
/** The range control's choices, in days. */
export const USAGE_RANGES = [1, 3, 7, 14, 30] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export type UsageLook = 'blend' | 'dots';

export const USAGE_RANGE_LABEL: Record<UsageRange, string> = { 1: 'Today', 3: '3 days', 7: 'Week', 14: '2 weeks', 30: '30 days' };

/** The day labels' band above the rows, px. */
export const USAGE_TOP = 34;

/** The count steps the key and the dots look use: 1 · 2 · 3–4 · 5–9 · 10+. */
export const USAGE_STEPS = [1, 2, 3, 5, 10] as const;
export function usageStep(count: number): number {
  return count >= 10 ? 4 : count >= 5 ? 3 : count >= 3 ? 2 : count >= 2 ? 1 : 0;
}

/** The look to draw: "dots" only when the page's address asks for it (dev comparison), never a setting. */
export function usageLookOf(search: string): UsageLook {
  return new URLSearchParams(search).get('usage-look') === 'dots' ? 'dots' : 'blend';
}

/** `[from, to)`: local midnight `days - 1` days ago to the coming midnight, so hours and days line up with this clock. */
export function usageSpan(days: number, now: Date): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from, to };
}

export interface UsageDay {
  /** The column (hour) the day starts at. */
  col: number;
  /** Hours in the day (23 or 25 across a clock change). */
  hours: number;
  date: Date;
}

/** Each local day in `[from, to)` and the columns it covers. */
export function usageDays(from: Date, to: Date): UsageDay[] {
  const days: UsageDay[] = [];
  for (let day = new Date(from); day < to; ) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    days.push({ col: Math.round((day.getTime() - from.getTime()) / HOUR_MS), hours: Math.round((next.getTime() - day.getTime()) / HOUR_MS), date: day });
    day = next;
  }
  return days;
}

/** Narrowest hour column before the chart scrolls sideways, and the width the default range wants, px. */
const MIN_CELL: Record<UsageLook, number> = { blend: 3, dots: 5 };
const WANT_CELL: Record<UsageLook, number> = { blend: 4, dots: 6 };

/** The widest range whose hours still get a comfortable column at this width: the default before the person picks one. */
export function defaultUsageRange(width: number, look: UsageLook): UsageRange {
  let best: UsageRange = USAGE_RANGES[0];
  for (const days of USAGE_RANGES) if (width / (days * 24) >= WANT_CELL[look]) best = days;
  return best;
}

export interface UsageLayout {
  look: UsageLook;
  cols: number;
  /** One hour's width. */
  cell: number;
  /** One row's height. */
  pitch: number;
  width: number;
  height: number;
  /** Whether the hours are wider than the space (the chart scrolls sideways, opened at the latest hour). */
  scrolls: boolean;
  /** The smallest and largest mark radius. */
  rMin: number;
  rMax: number;
}

/**
 * Fit `cols` hours into `width`: every column gets an equal share, never under MIN_CELL (then it scrolls).
 * Rows: blend's row leaves room for its biggest blob plus a 3 px gap so rows never touch; dots are square cells.
 */
export function usageLayout(width: number, cols: number, rows: number, look: UsageLook): UsageLayout {
  const fit = width / Math.max(1, cols);
  const cell = Math.max(MIN_CELL[look], fit);
  let pitch: number;
  let rMin: number;
  let rMax: number;
  if (look === 'blend') {
    pitch = Math.round(Math.min(16, Math.max(11, cell * 2.2)));
    rMin = 1.75;
    rMax = (pitch - 3) / 2;
  } else {
    pitch = Math.round(Math.min(10, Math.max(MIN_CELL.dots, cell)));
    // 70% of the tighter spacing, so dots never touch.
    rMin = rMax = 0.35 * Math.min(cell, pitch);
  }
  const w = Math.max(width, Math.ceil(cols * cell));
  return { look, cols, cell, pitch, width: w, height: USAGE_TOP + rows * pitch + 4, scrolls: cell > fit + 0.01, rMin, rMax };
}

/** A mark's radius: blend's area grows with the count, to a cap at 10+; dots are all one size. */
export function usageRadius(count: number, layout: Pick<UsageLayout, 'rMin' | 'rMax'>): number {
  const t = Math.sqrt((Math.min(Math.max(count, 1), 10) - 1) / 9);
  return layout.rMin + (layout.rMax - layout.rMin) * t;
}

export interface UsageRow {
  id: string;
  name: string | null;
  projectId: string;
  startedAt: number;
  lastAt: number;
  total: number;
  /** The hours with messages, ascending. */
  hours: number[];
  /** The count for each of `hours`. */
  counts: number[];
}

export function usageRows(model: InboxUsageModel): UsageRow[] {
  return model.threads.map((thread) => {
    const hours: number[] = [];
    const counts: number[] = [];
    for (let i = 0; i + 1 < thread.hours.length; i += 2) {
      hours.push(thread.hours[i]!);
      counts.push(thread.hours[i + 1]!);
    }
    return { id: thread.thread_id, name: thread.name, projectId: thread.project_id, startedAt: Date.parse(thread.started_at), lastAt: Date.parse(thread.last_at), total: thread.total, hours, counts };
  });
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export const usageX = (layout: UsageLayout, hour: number) => (hour + 0.5) * layout.cell;
export const usageY = (layout: UsageLayout, row: number) => USAGE_TOP + (row + 0.5) * layout.pitch;

/** A circle as a subpath, drawn left → bottom → right → top (one winding for every subpath, so nonzero fills overlaps). */
function circle(x: number, y: number, r: number): string {
  return `M${fmt(x - r)} ${fmt(y)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0`;
}

/**
 * What joins two marks side by side (x1 < x2, one y) into one soft shape, drawn with the same winding as
 * `circle`: the metaball connector (tangent points spread by `v`, bezier handles toward each other), so a run
 * of busy hours reads as one organic blob that swells and pinches with the counts, a small hour budding off a
 * big one rather than pointing like an arrow. Marks far apart get no join (the strand carries the thread).
 * Null when there is no join, or one mark holds the other.
 */
export function usageJoin(x1: number, r1: number, x2: number, r2: number, y: number, v = 0.7, handle = 2.4): string | null {
  const d = x2 - x1;
  if (d <= Math.abs(r1 - r2) || d <= 0 || d > (r1 + r2) * 1.6) return null;
  const overlap = d < r1 + r2;
  const u1 = overlap ? Math.acos(Math.max(-1, Math.min(1, (r1 * r1 + d * d - r2 * r2) / (2 * r1 * d)))) : 0;
  const u2 = overlap ? Math.acos(Math.max(-1, Math.min(1, (r2 * r2 + d * d - r1 * r1) / (2 * r2 * d)))) : 0;
  const spread = Math.acos(Math.max(-1, Math.min(1, (r1 - r2) / d)));
  // Angles in screen space (y down), from the line between the centres (pointing right): positive is below.
  const a1 = u1 + (spread - u1) * v; // below, on mark 1
  const a3 = Math.PI - u2 - (Math.PI - u2 - spread) * v; // below, on mark 2
  const at = (cx: number, a: number, r: number) => [cx + Math.cos(a) * r, y + Math.sin(a) * r] as const;
  const p1 = at(x1, a1, r1);
  const p2 = at(x1, -a1, r1);
  const p3 = at(x2, a3, r2);
  const p4 = at(x2, -a3, r2);
  const span = Math.hypot(p3[0] - p1[0], p3[1] - p1[1]);
  const k = Math.min(v * handle, span / (r1 + r2)) * Math.min(1, (d * 2) / (r1 + r2));
  const h = (p: readonly [number, number], a: number, len: number) => [p[0] + Math.cos(a) * len, p[1] + Math.sin(a) * len] as const;
  const h1 = h(p1, a1 - Math.PI / 2, r1 * k);
  const h3 = h(p3, a3 + Math.PI / 2, r2 * k);
  const h4 = h(p4, -a3 - Math.PI / 2, r2 * k);
  const h2 = h(p2, -a1 + Math.PI / 2, r1 * k);
  const pt = (p: readonly [number, number]) => `${fmt(p[0])} ${fmt(p[1])}`;
  return `M${pt(p1)}C${pt(h1)} ${pt(h3)} ${pt(p3)}L${pt(p4)}C${pt(h4)} ${pt(h2)} ${pt(p2)}Z`;
}

/** Blend's three opacity tiers, by a run's busiest hour: 1–2, 3–9, 10+ messages. */
export function usageTier(peak: number): number {
  return peak >= 10 ? 2 : peak >= 3 ? 1 : 0;
}

export interface UsagePaths {
  /** Blend: the faint line along each thread, first to last hour on screen. */
  strands: string;
  /**
   * Blend: the marks and their joins, one path per opacity tier. A run (neighbouring hours) goes whole into the
   * tier of its busiest hour, so one shape is one colour and overlaps never darken inside it.
   */
  tiers: string[];
  /** Dots: one path per count step. */
  steps: string[];
  /** A line at each day's start (but the first). */
  days: string;
  /** How many marks were drawn. */
  marks: number;
}

/** Every mark in a handful of paths: the whole chart is a few SVG nodes however many threads there are. */
export function usagePaths(rows: readonly UsageRow[], layout: UsageLayout, days: readonly UsageDay[]): UsagePaths {
  const strands: string[] = [];
  const tiers: string[][] = [[], [], []];
  const steps: string[][] = [[], [], [], [], []];
  let marks = 0;
  rows.forEach((row, i) => {
    const y = usageY(layout, i);
    if (layout.look === 'blend' && row.hours.length > 1) strands.push(`M${fmt(usageX(layout, row.hours[0]!))} ${fmt(y)}H${fmt(usageX(layout, row.hours[row.hours.length - 1]!))}`);
    if (layout.look === 'dots') {
      for (let k = 0; k < row.hours.length; k++) {
        marks++;
        steps[usageStep(row.counts[k]!)]!.push(circle(usageX(layout, row.hours[k]!), y, layout.rMin));
      }
      return;
    }
    for (let k = 0; k < row.hours.length; ) {
      // One run: hours next to each other.
      let end = k;
      while (end + 1 < row.hours.length && row.hours[end + 1] === row.hours[end]! + 1) end++;
      let peak = 0;
      const shape: string[] = [];
      for (let j = k; j <= end; j++) {
        const count = row.counts[j]!;
        peak = Math.max(peak, count);
        const x = usageX(layout, row.hours[j]!);
        const r = usageRadius(count, layout);
        shape.push(circle(x, y, r));
        if (j < end) {
          const join = usageJoin(x, r, usageX(layout, row.hours[j + 1]!), usageRadius(row.counts[j + 1]!, layout), y);
          if (join) shape.push(join);
        }
        marks++;
      }
      tiers[usageTier(peak)]!.push(shape.join(''));
      k = end + 1;
    }
  });
  const dayLines = days
    .slice(1)
    .map((day) => `M${fmt(day.col * layout.cell)} 0V${fmt(layout.height)}`)
    .join('');
  return { strands: strands.join(''), tiers: tiers.map((list) => list.join('')), steps: steps.map((list) => list.join('')), days: dayLines, marks };
}

/** A mark: its row and its index in that row's hours. */
export interface UsageAt {
  row: number;
  k: number;
}

/** The index of the hour in `hours` (ascending) nearest to `hour`. */
function nearest(hours: readonly number[], hour: number): number {
  let lo = 0;
  let hi = hours.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid]! < hour) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(hours[lo - 1]! - hour) <= Math.abs(hours[lo]! - hour)) return lo - 1;
  return lo;
}

/**
 * The mark under the pointer at (x, y) in chart space: the row under it, then that row's nearest hour if it is
 * within a few px (a mark is easier to hit than to see). Null over the labels, past the rows, or between marks.
 */
export function usageHit(rows: readonly UsageRow[], layout: UsageLayout, x: number, y: number): UsageAt | null {
  if (y < USAGE_TOP) return null;
  const row = Math.floor((y - USAGE_TOP) / layout.pitch);
  const hours = rows[row]?.hours;
  if (!hours || hours.length === 0) return null;
  const k = nearest(hours, x / layout.cell - 0.5);
  const reach = Math.max(layout.cell * 0.75, 7);
  return Math.abs(usageX(layout, hours[k]!) - x) <= reach ? { row, k } : null;
}

/**
 * The arrow keys inside the chart (a focused-widget pattern, no global shortcut): ← → step through a row's
 * hours, ↑ ↓ go to the row above or below at its nearest hour, Home / End to the row's first or last hour.
 * Null for any other key.
 */
export function usageMove(rows: readonly UsageRow[], at: UsageAt, key: string): UsageAt | null {
  const row = rows[at.row];
  if (!row) return null;
  switch (key) {
    case 'ArrowLeft':
      return { row: at.row, k: Math.max(0, at.k - 1) };
    case 'ArrowRight':
      return { row: at.row, k: Math.min(row.hours.length - 1, at.k + 1) };
    case 'Home':
      return { row: at.row, k: 0 };
    case 'End':
      return { row: at.row, k: row.hours.length - 1 };
    case 'ArrowUp':
    case 'ArrowDown': {
      const next = at.row + (key === 'ArrowUp' ? -1 : 1);
      const target = rows[next];
      if (!target || target.hours.length === 0) return at;
      return { row: next, k: nearest(target.hours, row.hours[at.k]!) };
    }
    default:
      return null;
  }
}

/** Where the keyboard starts: the newest thread's latest hour. */
export function usageStart(rows: readonly UsageRow[]): UsageAt | null {
  for (let row = rows.length - 1; row >= 0; row--) if (rows[row]!.hours.length > 0) return { row, k: rows[row]!.hours.length - 1 };
  return null;
}

/** The thread's messages on the local day that holds `hour`. */
export function usageDayCount(row: UsageRow, hour: number, days: readonly UsageDay[]): { day: UsageDay | null; count: number } {
  const day = days.find((d) => hour >= d.col && hour < d.col + d.hours) ?? null;
  if (!day) return { day, count: 0 };
  let count = 0;
  for (let k = 0; k < row.hours.length; k++) if (row.hours[k]! >= day.col && row.hours[k]! < day.col + day.hours) count += row.counts[k]!;
  return { day, count };
}
