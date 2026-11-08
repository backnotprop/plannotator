/**
 * Settings → Usage's chart model (usageChart.ts). What regresses: a range that
 * no longer fits the width (or never scrolls when it cannot), rows whose
 * biggest marks touch the next row, a mark the pointer cannot hit (or a hit on
 * empty space), arrow keys that skip or leave the chart, day columns off by an
 * hour across a clock change, or busy neighbouring hours drawn apart.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxUsageModel } from '@plannotator/core/inbox-types';
import {
  USAGE_TOP,
  defaultUsageRange,
  usageDayCount,
  usageDays,
  usageHit,
  usageJoin,
  usageLayout,
  usageMove,
  usagePaths,
  usageRadius,
  usageRows,
  usageSpan,
  usageStart,
  usageX,
  usageY,
} from './usageChart';

const model = (threads: [string, number[]][]): InboxUsageModel => ({
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  hour_count: 168,
  project_id: null,
  threads: threads.map(([id, hours]) => ({ thread_id: id, name: id, project_id: 'prj_a', started_at: '2026-11-01T00:00:00.000Z', last_at: '2026-11-07T00:00:00.000Z', total: 1, hours })),
});

describe('layout', () => {
  test('a range fits the width without scrolling while the hours stay wide enough, and scrolls (never squeezes) past that', () => {
    const fits = usageLayout(812, 7 * 24, 10, 'blend');
    expect(fits.scrolls).toBe(false);
    expect(fits.width).toBe(812);
    expect(fits.cell * 168).toBeCloseTo(812, 5);
    const tooMany = usageLayout(358, 30 * 24, 10, 'blend');
    expect(tooMany.scrolls).toBe(true);
    expect(tooMany.width).toBeGreaterThan(358);
    expect(tooMany.cell).toBe(3);
  });

  test('the default range is the widest that fits: a week on a desktop, fewer days on a phone', () => {
    expect(defaultUsageRange(812, 'blend')).toBe(7);
    expect(defaultUsageRange(358, 'blend')).toBe(3);
    expect(defaultUsageRange(358, 'dots')).toBe(1);
  });

  test('blend: the biggest mark leaves a gap to the next row at every width; dots never touch', () => {
    for (const width of [300, 358, 812, 1600, 4000]) {
      for (const days of [1, 3, 7, 14, 30]) {
        const blend = usageLayout(width, days * 24, 5, 'blend');
        expect(2 * usageRadius(100, blend)).toBeLessThanOrEqual(blend.pitch - 3);
        const dots = usageLayout(width, days * 24, 5, 'dots');
        expect(2 * dots.rMin).toBeLessThan(Math.min(dots.cell, dots.pitch));
      }
    }
  });

  test('a mark grows with its count up to 10, and one message is the smallest', () => {
    const layout = usageLayout(812, 168, 1, 'blend');
    expect(usageRadius(1, layout)).toBe(layout.rMin);
    expect(usageRadius(4, layout)).toBeGreaterThan(usageRadius(2, layout));
    expect(usageRadius(10, layout)).toBe(layout.rMax);
    expect(usageRadius(40, layout)).toBe(layout.rMax);
  });
});

describe('days', () => {
  test('a span is whole local days, and each day covers its own hours across a clock change', () => {
    const { from, to } = usageSpan(7, new Date(2026, 10, 7, 15, 30));
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(1);
    expect(to.getDate()).toBe(8);
    const days = usageDays(from, to);
    expect(days).toHaveLength(7);
    // Contiguous: each day starts where the one before ended, whatever its length.
    for (let i = 1; i < days.length; i++) expect(days[i]!.col).toBe(days[i - 1]!.col + days[i - 1]!.hours);
    expect(days[6]!.col + days[6]!.hours).toBe(Math.round((to.getTime() - from.getTime()) / 3_600_000));
  });

  test("a mark's day count adds that thread's hours on that day only", () => {
    const [row] = usageRows(model([['t', [1, 2, 23, 3, 24, 5]]]));
    const days = usageDays(new Date(2026, 10, 10), new Date(2026, 10, 12));
    expect(usageDayCount(row!, 1, days).count).toBe(5);
    expect(usageDayCount(row!, 24, days).count).toBe(5);
  });
});

describe('paths', () => {
  test('neighbouring hours join into one shape; hours apart do not', () => {
    expect(usageJoin(10, 4, 14, 4, 20)).not.toBeNull();
    expect(usageJoin(10, 2, 40, 2, 20)).toBeNull();
    // One mark inside the other: nothing to join.
    expect(usageJoin(10, 5, 11, 1, 20)).toBeNull();
  });

  test('every mark is drawn into a handful of paths, however many threads', () => {
    const many = model(Array.from({ length: 400 }, (_, i) => [`t${i}`, [i % 160, 3, (i % 160) + 1, 12]] as [string, number[]]));
    const rows = usageRows(many);
    const layout = usageLayout(812, 168, rows.length, 'blend');
    const paths = usagePaths(rows, layout, usageDays(new Date(2026, 10, 1), new Date(2026, 10, 8)));
    expect(paths.marks).toBe(800);
    expect(paths.tiers).toHaveLength(3);
    // A run goes whole into its busiest hour's tier: 12 messages is the top tier, so nothing in the faint one.
    expect(paths.tiers[0]).toBe('');
    expect(paths.tiers[2]!.length).toBeGreaterThan(0);
  });
});

describe('pointer and keys', () => {
  const rows = usageRows(model([['a', [2, 1, 10, 4]], ['b', [5, 2, 6, 1, 40, 9]], ['c', [100, 3]]]));
  const layout = usageLayout(812, 168, rows.length, 'blend');

  test('the pointer finds the mark it is near, in the row it is over, and nothing between marks or above the rows', () => {
    expect(usageHit(rows, layout, usageX(layout, 10) + 1, usageY(layout, 0))).toEqual({ row: 0, k: 1 });
    expect(usageHit(rows, layout, usageX(layout, 40), usageY(layout, 1) + 2)).toEqual({ row: 1, k: 2 });
    expect(usageHit(rows, layout, usageX(layout, 25), usageY(layout, 1))).toBeNull();
    expect(usageHit(rows, layout, usageX(layout, 2), USAGE_TOP - 1)).toBeNull();
    expect(usageHit(rows, layout, usageX(layout, 100), usageY(layout, 3))).toBeNull();
  });

  test('arrows step along a row and to the nearest hour of the next row, and stop at the edges', () => {
    const start = usageStart(rows)!;
    expect(start).toEqual({ row: 2, k: 0 });
    expect(usageMove(rows, start, 'ArrowUp')).toEqual({ row: 1, k: 2 });
    expect(usageMove(rows, { row: 1, k: 2 }, 'ArrowLeft')).toEqual({ row: 1, k: 1 });
    expect(usageMove(rows, { row: 1, k: 0 }, 'ArrowUp')).toEqual({ row: 0, k: 0 });
    expect(usageMove(rows, { row: 0, k: 0 }, 'ArrowUp')).toEqual({ row: 0, k: 0 });
    expect(usageMove(rows, { row: 0, k: 1 }, 'ArrowRight')).toEqual({ row: 0, k: 1 });
    expect(usageMove(rows, { row: 1, k: 0 }, 'End')).toEqual({ row: 1, k: 2 });
    expect(usageMove(rows, { row: 1, k: 0 }, 'x')).toBeNull();
  });
});
