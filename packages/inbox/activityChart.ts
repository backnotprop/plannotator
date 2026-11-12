import type { InboxActivityModel } from '@plannotator/core/inbox-types';

export const HOUR_MS = 3_600_000;
export const ACTIVITY_RANGES = [1, 3, 7, 14, 30] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];
export type ActivityLook = 'blend' | 'dots';

export const ACTIVITY_RANGE_LABEL: Record<ActivityRange, string> = { 1: 'Today', 3: '3 days', 7: 'Week', 14: '2 weeks', 30: '30 days' };

export type ActivitySize = 'preview' | 'full';

export const ACTIVITY_TOP: Record<ActivitySize, number> = { preview: 22, full: 34 };

export const ACTIVITY_STEPS = [1, 2, 3, 5, 10] as const;
export function activityStep(count: number): number {
  return count >= 10 ? 4 : count >= 5 ? 3 : count >= 3 ? 2 : count >= 2 ? 1 : 0;
}

export function activityLookOf(search: string): ActivityLook {
  return new URLSearchParams(search).get('activity-look') === 'dots' ? 'dots' : 'blend';
}

export function activitySpan(days: number, now: Date): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from, to };
}

export interface ActivityDay {
  col: number;
  hours: number;
  date: Date;
}

export function activityDays(from: Date, to: Date): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (let day = new Date(from); day < to; ) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    days.push({ col: Math.round((day.getTime() - from.getTime()) / HOUR_MS), hours: Math.round((next.getTime() - day.getTime()) / HOUR_MS), date: day });
    day = next;
  }
  return days;
}

export function defaultActivityRange(phone: boolean): ActivityRange {
  return phone ? 3 : 7;
}

export const PREVIEW_HEIGHT = 480;
const PREVIEW_PITCH: readonly [number, number] = [2, 5];
const FULL_PITCH: readonly [number, number] = [5, 9];
const FULL_MIN_CELL = 1.5;
const STRAND_PITCH = 4;

const clamp = (value: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, value));

export interface ActivityLayout {
  look: ActivityLook;
  size: ActivitySize;
  cols: number;
  cell: number;
  pitch: number;
  top: number;
  width: number;
  height: number;
  scrolls: boolean;
  rMin: number;
  rMax: number;
  strands: boolean;
}

export function activityLayout(width: number, cols: number, rows: number, look: ActivityLook, size: ActivitySize = 'full', height = PREVIEW_HEIGHT): ActivityLayout {
  const fit = width / Math.max(1, cols);
  const cell = size === 'full' ? Math.max(FULL_MIN_CELL, fit) : fit;
  const top = ACTIVITY_TOP[size];
  const pitch = Math.round(clamp((size === 'full' ? height - top : PREVIEW_HEIGHT) / Math.max(1, rows), size === 'full' ? FULL_PITCH : PREVIEW_PITCH) * 4) / 4;
  const gap = Math.max(0.75, pitch * 0.2);
  let rMax = (pitch - gap) / 2;
  let rMin = Math.min(rMax, Math.max(0.6, pitch * 0.2));
  if (look === 'dots') {
    rMin = rMax = Math.min(rMax, 0.35 * Math.min(cell, pitch));
  }
  const w = Math.max(width, Math.ceil(cols * cell));
  return { look, size, cols, cell, pitch, top, width: w, height: top + rows * pitch + 2, scrolls: cell > fit + 0.01, rMin, rMax, strands: look === 'blend' && pitch >= STRAND_PITCH };
}

export function activityRadius(count: number, layout: Pick<ActivityLayout, 'rMin' | 'rMax'>): number {
  const t = Math.sqrt((Math.min(Math.max(count, 1), 10) - 1) / 9);
  return layout.rMin + (layout.rMax - layout.rMin) * t;
}

export interface ActivityRow {
  id: string;
  name: string | null;
  projectId: string;
  startedAt: number;
  lastAt: number;
  total: number;
  hours: number[];
  counts: number[];
}

export function activityRows(model: InboxActivityModel): ActivityRow[] {
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

export const activityX = (layout: ActivityLayout, hour: number) => (hour + 0.5) * layout.cell;
export const activityY = (layout: ActivityLayout, row: number) => layout.top + (row + 0.5) * layout.pitch;

function circle(x: number, y: number, r: number): string {
  return `M${fmt(x - r)} ${fmt(y)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0`;
}

export function activityJoin(x1: number, r1: number, x2: number, r2: number, y: number, v = 0.7, handle = 2.4): string | null {
  const d = x2 - x1;
  if (d <= Math.abs(r1 - r2) || d <= 0 || d > (r1 + r2) * 1.6) return null;
  const overlap = d < r1 + r2;
  const u1 = overlap ? Math.acos(Math.max(-1, Math.min(1, (r1 * r1 + d * d - r2 * r2) / (2 * r1 * d)))) : 0;
  const u2 = overlap ? Math.acos(Math.max(-1, Math.min(1, (r2 * r2 + d * d - r1 * r1) / (2 * r2 * d)))) : 0;
  const spread = Math.acos(Math.max(-1, Math.min(1, (r1 - r2) / d)));
  const a1 = u1 + (spread - u1) * v;
  const a3 = Math.PI - u2 - (Math.PI - u2 - spread) * v;
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

export function activityTier(peak: number): number {
  return peak >= 10 ? 2 : peak >= 3 ? 1 : 0;
}

export interface ActivityPaths {
  strands: string;
  tiers: string[];
  steps: string[];
  days: string;
  marks: number;
}

export function activityPaths(rows: readonly ActivityRow[], layout: ActivityLayout, days: readonly ActivityDay[]): ActivityPaths {
  const strands: string[] = [];
  const tiers: string[][] = [[], [], []];
  const steps: string[][] = [[], [], [], [], []];
  let marks = 0;
  rows.forEach((row, i) => {
    const y = activityY(layout, i);
    if (layout.strands && row.hours.length > 1) strands.push(`M${fmt(activityX(layout, row.hours[0]!))} ${fmt(y)}H${fmt(activityX(layout, row.hours[row.hours.length - 1]!))}`);
    if (layout.look === 'dots') {
      for (let k = 0; k < row.hours.length; k++) {
        marks++;
        steps[activityStep(row.counts[k]!)]!.push(circle(activityX(layout, row.hours[k]!), y, layout.rMin));
      }
      return;
    }
    for (let k = 0; k < row.hours.length; ) {
      let end = k;
      while (end + 1 < row.hours.length && row.hours[end + 1] === row.hours[end]! + 1) end++;
      let peak = 0;
      const shape: string[] = [];
      for (let j = k; j <= end; j++) {
        const count = row.counts[j]!;
        peak = Math.max(peak, count);
        const x = activityX(layout, row.hours[j]!);
        const r = activityRadius(count, layout);
        shape.push(circle(x, y, r));
        if (j < end) {
          const join = activityJoin(x, r, activityX(layout, row.hours[j + 1]!), activityRadius(row.counts[j + 1]!, layout), y);
          if (join) shape.push(join);
        }
        marks++;
      }
      tiers[activityTier(peak)]!.push(shape.join(''));
      k = end + 1;
    }
  });
  const dayLines = days
    .slice(1)
    .map((day) => `M${fmt(day.col * layout.cell)} 0V${fmt(layout.height)}`)
    .join('');
  return { strands: strands.join(''), tiers: tiers.map((list) => list.join('')), steps: steps.map((list) => list.join('')), days: dayLines, marks };
}

export interface ActivityAt {
  row: number;
  k: number;
}

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

export function activityHit(rows: readonly ActivityRow[], layout: ActivityLayout, x: number, y: number): ActivityAt | null {
  if (y < layout.top) return null;
  const row = Math.floor((y - layout.top) / layout.pitch);
  const hours = rows[row]?.hours;
  if (!hours || hours.length === 0) return null;
  const k = nearest(hours, x / layout.cell - 0.5);
  const reach = Math.max(layout.cell * 0.75, 6);
  return Math.abs(activityX(layout, hours[k]!) - x) <= reach ? { row, k } : null;
}

export function activityDayCount(row: ActivityRow, hour: number, days: readonly ActivityDay[]): { day: ActivityDay | null; count: number } {
  const day = days.find((d) => hour >= d.col && hour < d.col + d.hours) ?? null;
  if (!day) return { day, count: 0 };
  let count = 0;
  for (let k = 0; k < row.hours.length; k++) if (row.hours[k]! >= day.col && row.hours[k]! < day.col + day.hours) count += row.counts[k]!;
  return { day, count };
}
