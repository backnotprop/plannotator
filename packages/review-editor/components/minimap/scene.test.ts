import { describe, expect, test } from 'bun:test';
import { buildFileRowModel, type RowMetrics } from './rowModel';
import { changeBands, hitTest, markBands, placeFiles, rasterize, type MinimapFile } from './scene';
import { densityAlpha } from './draw';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -10,4 +10,5 @@',
  ' keep',
  '-old',
  '+new one',
  '+new two',
  ' keep',
  ' keep',
].join('\n');

const METRICS: RowMetrics = { headerHeight: 32, lineHeight: 20, separatorHeight: 20, paddingBottom: 8 };

function files(split: boolean): Map<string, MinimapFile> {
  const model = buildFileRowModel(PATCH, { split, expandUnchanged: false });
  return new Map([
    ['a', { id: 'a', path: 'src/a.ts', model, viewed: false }],
    ['b', { id: 'b', path: 'src/b.ts', model, viewed: true }],
  ]);
}

describe('minimap marker positions', () => {
  test('unified: bands sit at the rows the layout gives each file, stretched to its measured height', () => {
    const layout = placeFiles(
      [
        { id: 'a', top: 100, height: 32 + 140 + 8, collapsed: false },
        { id: 'b', top: 280, height: 32 + 280 + 8, collapsed: false },
      ],
      files(false),
      METRICS,
      700,
    );
    const bands = changeBands(layout, METRICS).map(({ kind, top, height, dim }) => ({ kind, top, height, dim }));
    expect(bands).toEqual([
      { kind: 'add', top: 100 + 32 + 60, height: 40, dim: false },
      { kind: 'del', top: 100 + 32 + 40, height: 20, dim: false },
      { kind: 'add', top: 280 + 32 + 120, height: 80, dim: true },
      { kind: 'del', top: 280 + 32 + 80, height: 40, dim: true },
    ]);
  });

  test('split: a deletion and its addition share a row', () => {
    const layout = placeFiles([{ id: 'a', top: 0, height: 32 + 120 + 8, collapsed: false }], files(true), METRICS, 400);
    const bands = changeBands(layout, METRICS);
    expect(bands.map((b) => [b.kind, b.top, b.height])).toEqual([
      ['add', 32 + 40, 40],
      ['del', 32 + 40, 20],
    ]);
  });

  test('a collapsed file draws no change bands, and a comment on it marks the header', () => {
    const layout = placeFiles([{ id: 'a', top: 50, height: 32, collapsed: true }], files(false), METRICS, 400);
    expect(changeBands(layout, METRICS)).toEqual([]);
    expect(markBands(layout, [{ itemId: 'a', kind: 'comment', side: 'new', lineStart: 11, lineEnd: 11 }], METRICS)).toEqual([
      { kind: 'comment', top: 50, height: 32, dim: false },
    ]);
  });

  test('a comment lands on its line, and a point in the strip resolves back to that line', () => {
    const layout = placeFiles([{ id: 'a', top: 0, height: 180, collapsed: false }], files(false), METRICS, 400);
    const [comment] = markBands(layout, [{ itemId: 'a', kind: 'comment', side: 'new', lineStart: 12, lineEnd: 12 }], METRICS);
    expect(comment.top).toBe(32 + 80);
    const hit = hitTest(layout, comment.top + 5, METRICS);
    expect(hit?.file.id).toBe('a');
    expect(hit?.line).toBe(12);
    expect(hitTest(layout, 32 + 45, METRICS)).toMatchObject({ line: 11, side: 'old' });
  });

  test('a heavy region reads heavier than a one-line change', () => {
    const coverage = rasterize(
      [
        { kind: 'add', top: 0, height: 2000, dim: false },
        { kind: 'add', top: 6000, height: 20, dim: false },
      ],
      10_000,
      100,
    ).get('add')!;
    const heavy = coverage.slice(0, 20).reduce((sum, v) => sum + v, 0);
    const light = coverage.slice(55, 65).reduce((sum, v) => sum + v, 0);
    expect(heavy).toBeGreaterThan(light * 50);
    expect(light).toBeGreaterThan(0);
  });

  test('a +80/−80 file reads clearly heavier than a +2/−2 file when both are a few pixels tall on the strip', () => {
    const changed = (n: number) =>
      buildFileRowModel(['@@ -1,' + n + ' +1,' + n + ' @@', ...Array.from({ length: n }, () => '-old'), ...Array.from({ length: n }, () => '+new')].join('\n'), { split: true, expandUnchanged: false });
    const light = changed(2);
    const heavy = changed(80);
    const layout = placeFiles(
      [
        { id: 'light', top: 0, height: 32 + 2 * 20 + 8, collapsed: false },
        { id: 'heavy', top: 2_000, height: 32 + 80 * 20 + 8, collapsed: false },
      ],
      new Map([
        ['light', { id: 'light', path: 'light.ts', model: light, viewed: false }],
        ['heavy', { id: 'heavy', path: 'heavy.ts', model: heavy, viewed: false }],
      ]),
      METRICS,
      100_000,
    );
    const column = rasterize(changeBands(layout, METRICS, 400 / 100_000), 100_000, 800, { smoothRadius: 3, minSegmentBins: 2 }).get('add')!;
    const peak = (from: number, to: number) => Math.max(...column.slice(from, to));
    const lightAlpha = densityAlpha(peak(0, 2));
    const heavyAlpha = densityAlpha(peak(16, 24));
    expect(lightAlpha).toBeGreaterThan(0);
    expect(heavyAlpha).toBeGreaterThan(lightAlpha * 2);
  });

  test('in one big file a dense hunk outshines an isolated one-line change', () => {
    const column = rasterize(
      [
        { kind: 'add', top: 10_000, height: 8_000, dim: false },
        { kind: 'add', top: 60_000, height: 20, dim: false },
      ],
      100_000,
      1_000,
      { smoothRadius: 3 },
    ).get('add')!;
    const dense = densityAlpha(Math.max(...column.slice(100, 180)));
    const single = densityAlpha(Math.max(...column.slice(595, 606)));
    expect(single).toBeGreaterThan(0);
    expect(dense).toBeGreaterThan(single * 3);
  });
});
