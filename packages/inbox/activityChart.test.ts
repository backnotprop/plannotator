import { describe, expect, test } from 'bun:test';
import type { InboxActivityModel } from '@plannotator/core/inbox-types';
import {
  ACTIVITY_TOP,
  PREVIEW_HEIGHT,
  defaultActivityRange,
  activityDayCount,
  activityDays,
  activityHit,
  activityJoin,
  activityLayout,
  activityPaths,
  activityRadius,
  activityRows,
  activitySpan,
  activityX,
  activityY,
} from './activityChart';

const model = (threads: [string, number[]][]): InboxActivityModel => ({
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  hour_count: 168,
  project_id: null,
  threads: threads.map(([id, hours]) => ({ thread_id: id, name: id, project_id: 'prj_a', started_at: '2026-11-01T00:00:00.000Z', last_at: '2026-11-07T00:00:00.000Z', total: 1, hours })),
});

describe('layout', () => {
  test('the preview packs any range into its width and never scrolls: a week is one dense picture', () => {
    for (const width of [340, 700, 1100]) {
      for (const days of [1, 3, 7, 14, 30]) {
        const layout = activityLayout(width, days * 24, 60, 'blend', 'preview');
        expect(layout.scrolls).toBe(false);
        expect(layout.width).toBe(width);
        expect(layout.cell * days * 24).toBeCloseTo(width, 5);
      }
    }
    const week = activityLayout(1000, 7 * 24, 120, 'blend', 'preview');
    expect(week.cell).toBeLessThan(7);
    expect(week.pitch).toBeLessThanOrEqual(5);
    expect(week.height - week.top).toBeLessThanOrEqual(PREVIEW_HEIGHT + 2);
  });

  test('the full screen fills the space it is given, and scrolls sideways (never squeezes) past the narrowest hour', () => {
    const fits = activityLayout(1392, 7 * 24, 60, 'blend', 'full', 760);
    expect(fits.scrolls).toBe(false);
    expect(fits.cell * 168).toBeCloseTo(1392, 5);
    expect(fits.pitch).toBeGreaterThan(9 - 0.01);
    const many = activityLayout(1392, 7 * 24, 140, 'blend', 'full', 760);
    expect(many.top + 140 * many.pitch).toBeLessThanOrEqual(760 + 0.25 * 140);
    const tooMany = activityLayout(358, 30 * 24, 10, 'blend', 'full', 600);
    expect(tooMany.scrolls).toBe(true);
    expect(tooMany.width).toBeGreaterThan(358);
    expect(tooMany.cell).toBe(1.5);
  });

  test('the full screen is roomier than the preview for the same threads', () => {
    const preview = activityLayout(1000, 168, 300, 'blend', 'preview');
    const full = activityLayout(1392, 168, 300, 'blend', 'full', 760);
    expect(full.pitch).toBeGreaterThan(preview.pitch);
    expect(full.top).toBeGreaterThan(preview.top);
  });

  test('the default range is a week on a desktop and three days on a phone', () => {
    expect(defaultActivityRange(false)).toBe(7);
    expect(defaultActivityRange(true)).toBe(3);
  });

  test('marks never touch the next row at either size, however many threads; dots never touch at all', () => {
    for (const size of ['preview', 'full'] as const) {
      for (const width of [300, 812, 1600]) {
        for (const rows of [1, 5, 60, 425, 2000]) {
          const blend = activityLayout(width, 7 * 24, rows, 'blend', size, 700);
          expect(2 * activityRadius(100, blend)).toBeLessThanOrEqual(blend.pitch - 0.75 + 1e-9);
          const dots = activityLayout(width, 7 * 24, rows, 'dots', size, 700);
          expect(2 * dots.rMin).toBeLessThan(Math.min(dots.cell, dots.pitch));
        }
      }
    }
  });

  test('the faint line along a thread is drawn only on rows tall enough for it', () => {
    expect(activityLayout(1000, 168, 400, 'blend', 'preview').strands).toBe(false);
    expect(activityLayout(1392, 168, 60, 'blend', 'full', 760).strands).toBe(true);
    expect(activityLayout(1392, 168, 60, 'dots', 'full', 760).strands).toBe(false);
  });

  test('a mark grows with its count up to 10, and one message is the smallest', () => {
    const layout = activityLayout(812, 168, 1, 'blend', 'full', 600);
    expect(activityRadius(1, layout)).toBe(layout.rMin);
    expect(activityRadius(4, layout)).toBeGreaterThan(activityRadius(2, layout));
    expect(activityRadius(10, layout)).toBe(layout.rMax);
    expect(activityRadius(40, layout)).toBe(layout.rMax);
  });
});

describe('days', () => {
  test('a span is whole local days, and each day covers its own hours across a clock change', () => {
    const { from, to } = activitySpan(7, new Date(2026, 10, 7, 15, 30));
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(1);
    expect(to.getDate()).toBe(8);
    const days = activityDays(from, to);
    expect(days).toHaveLength(7);
    for (let i = 1; i < days.length; i++) expect(days[i]!.col).toBe(days[i - 1]!.col + days[i - 1]!.hours);
    expect(days[6]!.col + days[6]!.hours).toBe(Math.round((to.getTime() - from.getTime()) / 3_600_000));
  });

  test("a mark's day count adds that thread's hours on that day only", () => {
    const [row] = activityRows(model([['t', [1, 2, 23, 3, 24, 5]]]));
    const days = activityDays(new Date(2026, 10, 10), new Date(2026, 10, 12));
    expect(activityDayCount(row!, 1, days).count).toBe(5);
    expect(activityDayCount(row!, 24, days).count).toBe(5);
  });
});

describe('paths', () => {
  test('neighbouring hours join into one shape; hours apart do not', () => {
    expect(activityJoin(10, 4, 14, 4, 20)).not.toBeNull();
    expect(activityJoin(10, 2, 40, 2, 20)).toBeNull();
    expect(activityJoin(10, 5, 11, 1, 20)).toBeNull();
  });

  test('every mark is drawn into a handful of paths, however many threads', () => {
    const many = model(Array.from({ length: 400 }, (_, i) => [`t${i}`, [i % 160, 3, (i % 160) + 1, 12]] as [string, number[]]));
    const rows = activityRows(many);
    const layout = activityLayout(812, 168, rows.length, 'blend', 'preview');
    const paths = activityPaths(rows, layout, activityDays(new Date(2026, 10, 1), new Date(2026, 10, 8)));
    expect(paths.marks).toBe(800);
    expect(paths.tiers).toHaveLength(3);
    expect(paths.tiers[0]).toBe('');
    expect(paths.tiers[2]!.length).toBeGreaterThan(0);
  });
});

describe('pointer', () => {
  const rows = activityRows(model([['a', [2, 1, 10, 4]], ['b', [5, 2, 6, 1, 40, 9]], ['c', [100, 3]]]));
  const layout = activityLayout(812, 168, rows.length, 'blend', 'full', 600);

  test('the pointer finds the mark it is near, in the row it is over, and nothing between marks or above the rows', () => {
    expect(activityHit(rows, layout, activityX(layout, 10) + 1, activityY(layout, 0))).toEqual({ row: 0, k: 1 });
    expect(activityHit(rows, layout, activityX(layout, 40), activityY(layout, 1) + 2)).toEqual({ row: 1, k: 2 });
    expect(activityHit(rows, layout, activityX(layout, 25), activityY(layout, 1))).toBeNull();
    expect(activityHit(rows, layout, activityX(layout, 2), ACTIVITY_TOP.full - 1)).toBeNull();
    expect(activityHit(rows, layout, activityX(layout, 100), activityY(layout, 3))).toBeNull();
  });
});
