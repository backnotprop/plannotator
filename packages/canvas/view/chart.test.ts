/**
 * The drawing of a chart. It is handed only tables the codec passed, and for any of those it must give
 * shapes a browser can draw, at any size; the still picture must say the same thing as the board, with
 * every word of the chart's made safe for a file.
 */
import { describe, expect, test } from 'bun:test';
import { CHART_LIMITS } from '../model/chart';
import { checkObject } from '../model/codec';
import { CHART_MARKS, type ChartObject } from '../model/types';
import { type ChartPalette, type ChartShape, chartShapes, chartToSvg, describeChart } from './chart';

const PALETTE: ChartPalette = { ink: '#111', muted: '#555', rule: '#ddd', accent: '#5b3fd6', mono: 'monospace', sans: 'sans-serif' };

function chart(fields: Record<string, unknown>): ChartObject {
  const result = checkObject({ id: 'c', type: 'chart', x: 0, y: 0, w: 380, h: 240, ...fields });
  if (!result.ok) throw new Error(result.error);
  return result.value as ChartObject;
}

const WEEKS = { fields: ['week', 'minutes', 'plan'], rows: [['W1', 11.2, 10], ['W2', 4.1, 9], ['W3', 1.3, 8]] };
const texts = (shapes: ChartShape[]) => shapes.filter((shape) => shape.kind === 'text').map((shape) => (shape as { text: string }).text);
/** A series' mark: filled, or a hollow series' outline. Not a rule, a ground line or a legend's line. */
const isMark = (shape: Extract<ChartShape, { kind: 'path' }>) => (!!shape.fill && shape.fill !== 'rule') || (!!shape.stroke && shape.width === 1.5 && !shape.dash);
const paths = (shapes: ChartShape[]) => shapes.filter((shape): shape is Extract<ChartShape, { kind: 'path' }> => shape.kind === 'path');

/** Every number in a path, and every place a word is put. */
function numbersOf(shapes: ChartShape[]): number[] {
  const out: number[] = [];
  for (const shape of shapes) {
    if (shape.kind === 'text') out.push(shape.x, shape.y, shape.size);
    else {
      if (/NaN|Infinity|undefined|null/.test(shape.d)) out.push(NaN);
      for (const part of shape.d.match(/-?\d+(\.\d+)?(e[+-]?\d+)?/g) ?? []) out.push(Number(part));
      if (shape.opacity !== undefined) out.push(shape.opacity);
    }
  }
  return out;
}

/** Tables that are allowed and awkward: one row, all the same, nothing, below nothing, the largest numbers, the most rows. */
function awkward(): Record<string, unknown>[] {
  const big = CHART_LIMITS.number;
  const tables = [
    { fields: ['x', 'v', 'w', 'k'], rows: [['only', 5, 5, 'a']] },
    { fields: ['x', 'v', 'w', 'k'], rows: [['a', 0, 0, 'a'], ['b', 0, 0, 'b']] },
    { fields: ['x', 'v', 'w', 'k'], rows: [['a', 7, 7, 'a'], ['b', 7, 7, 'a'], ['c', 7, 7, 'a']] },
    { fields: ['x', 'v', 'w', 'k'], rows: [['a', -5, -9, 'a'], ['b', 3, -1, 'b'], ['a', -2, 4, 'b']] },
    { fields: ['x', 'v', 'w', 'k'], rows: [['a', big, -big, 'a'], ['b', -big, big, 'b']] },
    { fields: ['x', 'v', 'w', 'k'], rows: [['a', 1e-9, 2e-9, 'a'], ['b', 3e-9, 1e-9, 'b']] },
    { fields: ['x', 'v', 'w', 'k'], rows: Array.from({ length: CHART_LIMITS.rows }, (_row, i) => [`n${i % CHART_LIMITS.categories}`, i, CHART_LIMITS.rows - i, `k${i % CHART_LIMITS.series}`]) },
    { fields: ['x', 'v', 'w', 'k'], rows: Array.from({ length: 40 }, (_row, i) => [i, i * i, 40 - i, `k${i % 3}`]) },
    { fields: ['x', 'v', 'w', 'k'], rows: [['x'.repeat(CHART_LIMITS.cell), 1, 2, 'y'.repeat(CHART_LIMITS.cell)], ['', 2, 3, '']] },
  ];
  const out: Record<string, unknown>[] = [];
  for (const table of tables) {
    for (const mark of ['bar', 'line', 'area', 'dot']) {
      out.push({ ...table, mark, encode: { x: 'x', y: 'v' } });
      out.push({ ...table, mark, encode: { x: 'x', y: ['v', 'w'] }, stack: true, flip: true, dash: ['w'], rules: [{ at: 3, label: 'limit' }, { at: -4 }] });
      out.push({ ...table, mark, encode: { x: 'x', y: 'v', series: 'k', size: 'w' in table ? undefined : undefined }, stack: true });
      out.push({ ...table, mark, encode: { x: 'x', y: 'v', facet: 'k' }, title: 'Small charts', unit: 'ms' });
    }
    out.push({ ...table, mark: 'dot', encode: { x: 'v', y: 'w', series: 'k', size: 'v' } });
    out.push({ ...table, mark: 'cell', encode: { x: 'x', y: 'k', value: 'v' }, unit: 'min' });
    out.push({ ...table, mark: 'cell', encode: { x: 'x', y: 'k', series: 'k' }, title: 'Kinds' });
    out.push({ ...table, mark: 'span', encode: { x: 'v', x2: 'w', y: 'k', series: 'k' }, rules: [{ at: 4, on: 'x', label: 'today' }] });
  }
  return out;
}

describe('any chart the codec passes can be drawn', () => {
  test('every mark, on awkward tables, at every size: only finite numbers, and never a throw', () => {
    let drawn = 0;
    let refusedTables = 0;
    for (const fields of awkward()) {
      // A negative size is refused by the codec (sizes are for dots); skip a table it does not take.
      const checked = checkObject({ id: 'c', type: 'chart', x: 0, y: 0, w: 380, h: 240, ...fields });
      if (!checked.ok) {
        refusedTables += 1;
        continue;
      }
      const object = checked.value as ChartObject;
      for (const [w, h] of [[1, 1], [16, 16], [60, 300], [300, 40], [380, 240], [1200, 700], [20_000, 20_000]]) {
        for (const detail of ['full', 'marks'] as const) {
          const shapes = chartShapes(object, { w, h, detail });
          const bad = numbersOf(shapes).filter((value) => !Number.isFinite(value));
          if (bad.length) throw new Error(`${object.mark} ${JSON.stringify(object.encode)} at ${w}x${h}: a number that is not one`);
          for (const shape of paths(shapes)) if (shape.opacity !== undefined && (shape.opacity < 0 || shape.opacity > 1)) throw new Error('an opacity outside 0 to 1');
          drawn += 1;
        }
      }
    }
    // Most of the awkward tables must really have been drawn, or this proves nothing.
    expect(drawn).toBeGreaterThan(1500);
    expect(refusedTables).toBeLessThan(40);
  });

  test('the six marks are all drawn: each gives marks of its own', () => {
    const table = { fields: ['x', 'v', 'w', 'k'], rows: [['a', 1, 4, 'p'], ['b', 2, 6, 'q'], ['c', 3, 9, 'p']] };
    const encodes: Record<string, unknown> = { cell: { x: 'x', y: 'k', value: 'v' }, span: { x: 'v', x2: 'w', y: 'k' } };
    const seen = new Set<string>();
    for (const mark of CHART_MARKS) {
      const shapes = chartShapes(chart({ ...table, mark, encode: encodes[mark] ?? { x: 'x', y: 'v' } }), { detail: 'marks' });
      const marks = paths(shapes).filter((shape) => shape.fill === 'accent' || shape.stroke === 'accent');
      expect(marks.length).toBeGreaterThan(0);
      seen.add(marks.map((shape) => shape.d).join('|'));
    }
    expect(seen.size).toBe(CHART_MARKS.length);
  });
});

describe('what a chart costs to draw', () => {
  test('a series is one path, however many rows it has: 500 bars are not 500 elements', () => {
    const rows = Array.from({ length: CHART_LIMITS.rows }, (_row, i) => [`n${i % CHART_LIMITS.categories}`, i, `k${i % 4}`]);
    const object = chart({ mark: 'bar', fields: ['x', 'v', 'k'], rows, encode: { x: 'x', y: 'v', series: 'k' }, stack: true });
    expect(paths(chartShapes(object, { detail: 'marks' })).length).toBeLessThanOrEqual(4 + 2);
    expect(chartShapes(object).length).toBeLessThan(80);
    const cells = chart({ mark: 'cell', fields: ['x', 'y', 'v'], rows: Array.from({ length: CHART_LIMITS.rows }, (_row, i) => [i % 25, Math.floor(i / 25), i]), encode: { x: 'x', y: 'y', value: 'v' } });
    // Five steps of size, and the ground they stand on.
    expect(paths(chartShapes(cells, { detail: 'marks' })).length).toBeLessThanOrEqual(6);
  });

  test('too small to read on screen, a chart keeps its marks and draws no words', () => {
    const object = chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] }, title: 'Scan to alert', unit: 'min', rules: [{ at: 5, label: 'target' }] });
    expect(texts(chartShapes(object)).length).toBeGreaterThan(5);
    const marks = chartShapes(object, { detail: 'marks' });
    expect(texts(marks)).toEqual([]);
    expect(paths(marks).some((shape) => shape.stroke === 'accent')).toBe(true);
  });
});

describe('the look', () => {
  test('the first series takes the colour; the rest are quieter steps', () => {
    const object = chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] } });
    const lines = paths(chartShapes(object)).filter((shape) => shape.stroke && shape.stroke !== 'rule' && shape.stroke !== 'muted' && shape.width !== 1);
    // Drawn back to front: the first series last, on top, heaviest.
    expect(lines.map((shape) => shape.stroke)).toEqual(['ink', 'accent']);
    expect(lines[1].width).toBeGreaterThan(lines[0].width!);
  });

  test('no two lines are told apart by colour alone: every line after the first has a pattern of its own', () => {
    const rows = Array.from({ length: 6 }, (_row, i) => [`W${i}`, i, i + 1, i + 2, i + 3]);
    const object = chart({ mark: 'line', fields: ['week', 'a', 'b', 'c', 'd'], rows, encode: { x: 'week', y: ['a', 'b', 'c', 'd'] } });
    const lines = paths(chartShapes(object)).filter((shape) => shape.stroke && shape.d.split('L').length === 6);
    expect(lines).toHaveLength(4);
    const patterns = lines.map((shape) => shape.dash ?? 'solid');
    expect(new Set(patterns).size).toBe(4);
    // The first series, drawn last, is the solid one; `dash` can pattern it too, and the others stay distinct.
    expect(patterns[3]).toBe('solid');
    const all = paths(chartShapes(chart({ mark: 'line', fields: ['week', 'a', 'b', 'c', 'd'], rows, encode: { x: 'week', y: ['a', 'b', 'c', 'd'] }, dash: ['a'] }))).filter((shape) => shape.stroke && shape.d.split('L').length === 6);
    expect(new Set(all.map((shape) => shape.dash)).size).toBe(4);
    expect(all.every((shape) => !!shape.dash)).toBe(true);
  });

  test('each line is named where it ends, beside its last value, and two ends that meet are moved apart', () => {
    const rows = [[0, 'failing', 180], [6, 'failing', 76], [0, 'plan', 180], [9, 'plan', 0], [6, 'at this rate', 76], [9, 'at this rate', 4]];
    const object = chart({ mark: 'line', fields: ['week', 'line', 'tests'], rows, encode: { x: 'week', y: 'tests', series: 'line' }, w: 520, h: 320 });
    const shapes = chartShapes(object);
    const ends = shapes.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && /^(76 failing|0 plan|4 at this rate)$/.test(shape.text));
    expect(ends.map((shape) => shape.text).sort()).toEqual(['0 plan', '4 at this rate', '76 failing']);
    const ys = ends.map((shape) => shape.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(11);
    for (const end of ends) expect(end.y).toBeLessThanOrEqual(object.h);
    // Two lines that end side by side in the middle of the chart, far from its foot.
    const close = chart({ mark: 'line', fields: ['week', 'a', 'b'], rows: [[0, 10, 200], [9, 100, 101]], encode: { x: 'week', y: ['a', 'b'] }, w: 520, h: 320 });
    const pair = chartShapes(close).filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && /^10[01] [ab]$/.test(shape.text));
    expect(pair).toHaveLength(2);
    expect(Math.abs(pair[0].y - pair[1].y)).toBeGreaterThanOrEqual(11);
    // Named at their ends, the lines need no legend: no name is written twice.
    expect(texts(shapes).filter((word) => word === 'plan')).toEqual([]);
  });

  test('dots of different series have different outlines', () => {
    const rows = Array.from({ length: 8 }, (_row, i) => [10, 10, `k${i + 1}`]);
    const object = chart({ mark: 'dot', fields: ['x', 'y', 'k'], rows, encode: { x: 'x', y: 'y', series: 'k' }, w: 380, h: 300 });
    // Eight dots at one place: eight outlines, none the same.
    const dots = paths(chartShapes(object, { detail: 'marks' })).filter(isMark);
    expect(new Set(dots.map((shape) => shape.d)).size).toBe(8);
  });

  test('a long key takes two lines at most and counts the rest; the plot under it is never crushed or turned over', () => {
    const rows = Array.from({ length: 8 }, (_row, i) => [i * 10, i * 10, `a series with a long name ${i + 1}`]);
    for (const [w, h] of [[380, 150], [380, 240], [380, 300], [200, 130], [900, 200]]) {
      const object = chart({ mark: 'dot', fields: ['x', 'y', 'k'], rows, encode: { x: 'x', y: 'y', series: 'k' }, w, h });
      const shapes = chartShapes(object);
      const key = shapes.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && (shape.text.startsWith('a series') || /^\+\d+$/.test(shape.text)));
      expect(new Set(key.map((shape) => shape.y)).size).toBeLessThanOrEqual(2);
      const named = key.filter((shape) => shape.text.startsWith('a series')).length;
      const counted = key.find((shape) => /^\+\d+$/.test(shape.text));
      // Every series is either named or counted: none is dropped in silence.
      expect(named + (counted ? Number(counted.text.slice(1)) : 0)).toBe(named === 0 ? 0 : 8);
      for (const item of key) expect(item.x + item.text.length * 6.1).toBeLessThanOrEqual(w);
      // The eight dots: all inside the box, under the key, and the one with the largest y is drawn highest.
      const keyFoot = Math.max(0, ...key.map((shape) => shape.y));
      const tops = paths(shapes).filter((shape) => isMark(shape) && !key.some((item) => Math.abs(Number(shape.d.match(/^M[\d.-]+ ([\d.-]+)/)![1]) - item.y) < 12)).map((shape) => Number(shape.d.match(/^M[\d.-]+ ([\d.-]+)/)![1]));
      expect(tops.length).toBeGreaterThanOrEqual(8);
      for (const top of tops) {
        expect(top).toBeGreaterThan(keyFoot - 2);
        expect(top).toBeLessThan(h);
      }
      const [first, last] = [tops[0], tops[7]];
      expect(last).toBeLessThanOrEqual(first);
    }
  });

  const EIGHT = Array.from({ length: 16 }, (_row, i) => [`n${i % 2}`, `k${i % 8}`, 20]);
  const seriesMarks = (shapes: ChartShape[]) => paths(shapes).filter((shape) => (shape.fill ?? shape.stroke) !== 'rule' && (shape.fill ?? shape.stroke) !== 'muted');
  /** A series' marks in the plot (two bars here), not its one swatch in the key. */
  const inPlot = (shape: Extract<ChartShape, { kind: 'path' }>) => shape.d.split('z').length - 1 >= 2;
  const form = (shape: Extract<ChartShape, { kind: 'path' }>) => (shape.fill ? 'solid' : shape.d.includes('L') ? 'hatched' : 'hollow');

  test('the first five series differ by form, not by shade: two quiet solids, two hollow, then hatched ones', () => {
    const bars = seriesMarks(chartShapes(chart({ mark: 'bar', fields: ['x', 'k', 'v'], rows: EIGHT, encode: { x: 'x', y: 'v', series: 'k' }, stack: true, w: 380, h: 420 }))).filter(inPlot);
    expect(bars.map(form)).toEqual(['solid', 'solid', 'solid', 'hollow', 'hollow', 'hatched', 'hatched', 'hatched']);
    // The three hatches are three different hatches: lines that rise, lines that fall, and both.
    const slants = (d: string) => {
      const found = new Set<string>();
      for (const [, x1, y1, x2, y2] of d.matchAll(/M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/g)) found.add((Number(x2) - Number(x1)) * (Number(y2) - Number(y1)) < 0 ? 'rise' : 'fall');
      return [...found].sort().join('+');
    };
    expect(bars.slice(5).map((shape) => slants(shape.d)).sort()).toEqual(['fall', 'fall+rise', 'rise']);
  });

  test('a form is drawn only where it can be read: a small mark, or a chart drawn small, is quiet solid steps, never stripes', () => {
    const object = (h: number) => chart({ mark: 'bar', fields: ['x', 'k', 'v'], rows: EIGHT, encode: { x: 'x', y: 'v', series: 'k' }, stack: true, w: 380, h });
    // The same stack in a short chart: every part is a few units high. All solid, each still at a step that can be seen.
    const short = seriesMarks(chartShapes(object(150), { detail: 'marks' })).concat(seriesMarks(chartShapes(object(140))).filter(inPlot));
    expect(short.length).toBeGreaterThanOrEqual(16);
    for (const shape of short) {
      expect(form(shape)).toBe('solid');
      expect(shape.opacity ?? 1).toBeGreaterThanOrEqual(0.46);
    }
    // And in a tall chart drawn small (a figure in a plan): solid too, the key's swatches with it.
    for (const detail of ['named', 'marks'] as const) for (const shape of seriesMarks(chartShapes(object(420), { detail }))) expect(form(shape)).toBe('solid');
  });

  test('in a grid of kinds the fourth and fifth kinds are whole tiles with a core, not outlines that read as holes', () => {
    const grid = Array.from({ length: 16 }, (_row, i) => [`c${i}`, `k${i % 8}`, `k${i % 8}`]);
    const tiles = seriesMarks(chartShapes(chart({ mark: 'cell', fields: ['x', 'y', 'k'], rows: grid, encode: { x: 'x', y: 'y', series: 'k' }, w: 520, h: 320 }), { detail: 'marks' }));
    expect(tiles.every((shape) => form(shape) === 'solid')).toBe(true);
    const full = seriesMarks(chartShapes(chart({ mark: 'cell', fields: ['x', 'y', 'k'], rows: grid, encode: { x: 'x', y: 'y', series: 'k' }, w: 520, h: 320 }))).filter((shape) => shape.d.split('M').length - 1 === 2);
    const width = (shape: (typeof full)[number]) => Number(shape.d.match(/h([\d.]+)v/)![1]);
    // Kinds one to three: one whole tile each. Kind four: a whole quiet tile, and a core half as wide in the colour.
    const whole = width(full[0]);
    expect(full.slice(0, 3).every((shape) => !!shape.fill && Math.abs(width(shape) - whole) < 0.01)).toBe(true);
    expect([form(full[3]), full[3].fill, Math.abs(width(full[3]) - whole) < 0.01]).toEqual(['solid', 'ink', true]);
    expect([form(full[4]), full[4].fill]).toEqual(['solid', 'accent']);
    expect(width(full[4])).toBeCloseTo(whole / 2, 1);
  });

  test('a chart spends a bounded number of hatch lines: 500 hatched spans are drawn as quiet solids past it, and stay one path a series', () => {
    const rows = Array.from({ length: 500 }, (_row, i) => [`lane ${i % 20}`, i * 2, i * 2 + 30, `k${i % 8}`]);
    const shapes = chartShapes(chart({ mark: 'span', fields: ['lane', 'from', 'to', 'k'], rows, encode: { x: 'from', x2: 'to', y: 'lane', series: 'k' }, w: 20_000, h: 20_000 }));
    const lines = paths(shapes).reduce((sum, shape) => sum + (shape.stroke && shape.d.includes('L') ? shape.d.split('L').length - 1 : 0), 0);
    expect(lines).toBeLessThanOrEqual(4000);
    // Every one of the 500 spans is still drawn, in at most two shapes a series.
    const marks = seriesMarks(shapes).filter((shape) => shape.d.split('M').length - 1 > 20 || shape.d.split('z').length - 1 > 20);
    expect(marks.reduce((sum, shape) => sum + (shape.d.match(/h[\d.-]+v[\d.-]+h[\d.-]+z/g)?.length ?? 0), 0)).toBeGreaterThanOrEqual(500);
    expect(marks.length).toBeLessThanOrEqual(16);
    // A small chart of the same kind has room: its hatched series are hatched.
    const few = chartShapes(chart({ mark: 'span', fields: ['lane', 'from', 'to', 'k'], rows: rows.slice(0, 16), encode: { x: 'from', x2: 'to', y: 'lane', series: 'k' }, w: 900, h: 600 }));
    expect(seriesMarks(few).some((shape) => form(shape) === 'hatched')).toBe(true);
  });

  test('the last name in a key is cut short, not counted: "+N" is only written for two or more', () => {
    for (let count = 2; count <= 8; count++) {
      for (const w of [220, 300, 380, 520]) {
        const rows = Array.from({ length: count }, (_row, i) => [i, i, `series ${'x'.repeat(i * 3)}${i}`]);
        const words = texts(chartShapes(chart({ mark: 'dot', fields: ['x', 'y', 'k'], rows, encode: { x: 'x', y: 'y', series: 'k' }, w, h: 300 })));
        expect(words.filter((word) => word === '+1')).toEqual([]);
        const counted = words.find((word) => /^\+\d+$/.test(word));
        const named = words.filter((word) => word.startsWith('series')).length;
        expect(named + (counted ? Number(counted.slice(1)) : 0)).toBe(count);
      }
    }
    // Three lines and room for two and a half names in a chart drawn small: the third is cut with an ellipsis.
    const rows = [[0, 'failing', 180], [6, 'failing', 76], [0, 'plan', 180], [9, 'plan', 0], [6, 'at this rate', 76], [9, 'at this rate', 4]];
    const key = texts(chartShapes(chart({ mark: 'line', title: 'Tests still failing', fields: ['week', 'line', 'tests'], rows, encode: { x: 'week', y: 'tests', series: 'line' }, w: 520, h: 320 }), { detail: 'named' }));
    expect(key.slice(1, 3)).toEqual(['failing', 'plan']);
    expect(key[3]).toMatch(/^at .*…$|^at this rate$/);
  });

  test('with names at the line ends, the values on the rules stand in a gutter at the left: no line runs through them', () => {
    const rows = [1, 2, 3].flatMap((voices) => [16, 64, 512].map((block) => [block, `${voices} voices`, 20 * voices + 600 / block]));
    const shapes = chartShapes(chart({ mark: 'line', fields: ['block', 'voices', 'load'], rows, encode: { x: 'block', y: 'load', series: 'voices' }, w: 520, h: 320 }));
    const lines = paths(shapes).filter((shape) => shape.stroke && shape.d.split('L').length === 3 && (shape.width ?? 1) >= 1.5);
    expect(lines).toHaveLength(3);
    const left = Math.min(...lines.map((shape) => Number(shape.d.match(/^M([\d.-]+) /)![1])));
    const values = shapes.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && /^\d+$/.test(shape.text) && shape.anchor === 'end' && shape.size === 9.5 && shape.y < 300);
    expect(values.length).toBeGreaterThanOrEqual(3);
    // Each ends before the plot begins, so before any line does.
    for (const value of values) {
      expect(value.x).toBeLessThan(left);
      // And inside the chart: the gutter is room the plot gave up, not the chart's own edge.
      expect(value.x - value.text.length * 9.5 * 0.61).toBeGreaterThanOrEqual(10);
    }
  });

  test('a label moved away from its end is clear of the other labels and of the foot of the plot', () => {
    // Three lines stop at the same place in the middle, low on the chart, where another runs on through.
    const rows = [[0, 'on', 60], [9, 'on', 2], ...['a', 'b', 'c'].flatMap((name, i) => [[0, name, 40 + i], [5, name, 27 + i * 0.4]])];
    const object = chart({ mark: 'line', fields: ['week', 'line', 'v'], rows, encode: { x: 'week', y: 'v', series: 'line' }, w: 520, h: 320 });
    const shapes = chartShapes(object);
    const labels = shapes.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && / (on|a|b|c)$/.test(shape.text));
    expect(labels).toHaveLength(4);
    const box = (label: (typeof labels)[number]) => {
      const wide = label.text.length * 6.1;
      const l = label.anchor === 'end' ? label.x - wide : label.x;
      return [l, label.y - 9, l + wide, label.y + 2];
    };
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [box(labels[i]), box(labels[j])];
      expect(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]).toBe(false);
    }
    // None is written over the names along the x axis.
    const foot = Math.min(...shapes.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && /^\d$/.test(shape.text) && shape.y > 300).map((shape) => shape.y - 9));
    for (const label of labels) expect(label.y).toBeLessThan(foot);
  });

  test('drawn small, a chart still says what it is: its title and a one-line key, larger, and none of the small words', () => {
    const object = chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] }, title: 'Scan to alert', unit: 'min', rules: [{ at: 5, label: 'target' }] });
    const full = chartShapes(object);
    const named = chartShapes(object, { detail: 'named' });
    const words = named.filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text');
    expect(words.map((shape) => shape.text)).toEqual(['SCAN TO ALERT', 'minutes', 'plan']);
    // Set large enough to read at under half size.
    for (const word of words) expect(word.size).toBeGreaterThanOrEqual(20);
    expect(new Set(words.slice(1).map((shape) => shape.y)).size).toBe(1);
    expect(texts(full)).toContain('target');
    // Each line keeps its own pattern and its weight against the other: the dashed plan is never a solid line heavier than the actual one.
    const lineOf = (shapes: ChartShape[], role: string) => paths(shapes).filter((shape) => shape.stroke === role && shape.d.split('L').length === 3 && (shape.width ?? 1) > 1.2 && shape.dash !== '12 9' && shape.dash !== '4 3').pop()!;
    for (const detail of ['named', 'marks'] as const) {
      const drawn = chartShapes(object, { detail });
      const actual = lineOf(drawn, 'accent');
      const plan = lineOf(drawn, 'ink');
      expect(actual.dash).toBeUndefined();
      expect(plan.dash).toBe('21 12');
      expect(plan.width!).toBeLessThan(actual.width!);
      expect(actual.width! / plan.width!).toBeCloseTo(2 / 1.5, 5);
    }
    expect(texts(chartShapes(object, { detail: 'marks' }))).toEqual([]);
  });

  test('more lines than the plot has room to name at their ends are named in the key instead, not piled under the plot', () => {
    const object = (h: number, series: number) => chart({ mark: 'line', fields: ['x', 'k', 'v'], rows: Array.from({ length: series * 2 }, (_row, i) => [i % 2, `line ${Math.floor(i / 2) + 1}`, 10 + Math.floor(i / 2)]), encode: { x: 'x', y: 'v', series: 'k' }, w: 380, h });
    // Room for all: named at their ends, each on a line of its own, inside the plot.
    const roomy = chartShapes(object(320, 8)).filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && /^1\d line \d$/.test(shape.text));
    expect(roomy).toHaveLength(8);
    // Not enough: no end names at all; the key names them (two lines, then a count), and nothing is written under the box.
    const tight = chartShapes(object(160, 8));
    expect(tight.filter((shape) => shape.kind === 'text' && /^1\d line \d$/.test(shape.text))).toEqual([]);
    expect(texts(tight)).toContain('line 1');
    for (const shape of tight) if (shape.kind === 'text') expect(shape.y).toBeLessThanOrEqual(160);
  });

  test('a label at a line\'s end is not written across another line that starts there', () => {
    // The actual line stops at week 6; a projection starts at that very point and runs down to the right.
    const rows = [[0, 'failing', 180], [3, 'failing', 138], [6, 'failing', 76], [6, 'at this rate', 76], [9, 'at this rate', 13], [0, 'plan', 180], [9, 'plan', 0]];
    const object = chart({ mark: 'line', fields: ['week', 'line', 'tests'], rows, encode: { x: 'week', y: 'tests', series: 'line' }, w: 520, h: 320 });
    const shapes = chartShapes(object);
    const label = shapes.find((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && shape.text === '76 failing')!;
    const projection = paths(shapes).find((shape) => shape.dash === '7 4' && shape.d.split('L').length === 2)!;
    const [x1, y1, x2, y2] = projection.d.match(/[\d.-]+/g)!.map(Number);
    // No point of the projection lies inside the label's box.
    const left = label.anchor === 'end' ? label.x - label.text.length * 6.1 : label.x;
    for (let k = 0; k <= 100; k++) {
      const x = x1 + ((x2 - x1) * k) / 100;
      const y = y1 + ((y2 - y1) * k) / 100;
      expect(x >= left && x <= left + label.text.length * 6.1 && y >= label.y - 9 && y <= label.y + 2).toBe(false);
    }
    // A line that ends alone at the right edge keeps its label beside its end.
    const plan = shapes.find((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && shape.text === '0 plan')!;
    expect(plan.anchor).toBeUndefined();
  });

  test('a line runs along the x axis whatever order its rows came in, and the latest value is the right-most one', () => {
    // B's rows come W3, W1, W2; the axis reads W1, W2, W3 because that is how the names first appear.
    const inOrder = [['W1', 'A', 10], ['W2', 'A', 8], ['W3', 'A', 6], ['W1', 'B', 50], ['W2', 'B', 40], ['W3', 'B', 30]];
    const jumbled = [['W1', 'A', 10], ['W2', 'A', 8], ['W3', 'A', 6], ['W3', 'B', 30], ['W1', 'B', 50], ['W2', 'B', 40]];
    const draw = (rows: unknown[][]) => chartShapes(chart({ mark: 'line', fields: ['week', 'team', 'minutes'], rows, encode: { x: 'week', y: 'minutes', series: 'team' } }));
    expect(draw(jumbled)).toEqual(draw(inOrder));
    expect(texts(draw(jumbled))).toContain('30 B');
    // Numbers along the bottom: sorted by size, and the large number at the head is the last in time.
    const byNumber = (rows: number[][]) => chartShapes(chart({ mark: 'area', fields: ['day', 'v'], rows, encode: { x: 'day', y: 'v' } }));
    expect(byNumber([[3, 5], [1, 9], [2, 7]])).toEqual(byNumber([[1, 9], [2, 7], [3, 5]]));
    const head = byNumber([[3, 5], [1, 9], [2, 7]]).find((shape) => shape.kind === 'text' && shape.size === 28) as { text: string };
    expect(head.text).toBe('5');
  });

  test('an upright rule past the data is inside the chart too: the x axis grows to hold it', () => {
    const rows = Array.from({ length: 8 }, (_row, i) => [i + 1, 10 - i]);
    const object = chart({ mark: 'line', fields: ['week', 'v'], rows, encode: { x: 'week', y: 'v' }, rules: [{ at: 12, on: 'x', label: 'freeze' }] });
    const rule = paths(chartShapes(object)).find((shape) => shape.dash === '4 3')!;
    const x = Number(rule.d.match(/^M([\d.-]+) /)![1]);
    const end = paths(chartShapes(object)).find((shape) => shape.stroke === 'accent')!;
    const lastX = Number(end.d.match(/L([\d.-]+) [\d.-]+$/)![1]);
    expect(x).toBeGreaterThan(lastX);
    expect(x).toBeLessThanOrEqual(object.w - 14);
  });

  test('a chart of amounts says what its sizes mean, with a title or without, and the smallest amount is still a mark', () => {
    const rows = [['a', 'p', 2], ['b', 'p', 40], ['a', 'q', 21]];
    for (const title of [undefined, 'Minutes on the knobs']) {
      const object = chart({ mark: 'cell', fields: ['x', 'y', 'v'], rows, encode: { x: 'x', y: 'y', value: 'v' }, unit: 'min', ...(title ? { title } : {}) });
      const words = texts(chartShapes(object));
      expect(words).toContain('2');
      expect(words).toContain('40 min');
      // Three tiles in three different sizes, every one in the colour at full strength.
      const tiles = paths(chartShapes(object, { detail: 'marks' })).filter((shape) => shape.fill === 'accent');
      expect(tiles).toHaveLength(3);
      expect(tiles.every((shape) => shape.opacity === undefined || shape.opacity === 1)).toBe(true);
      const widths = tiles.map((shape) => Number(shape.d.match(/h([\d.]+)v/)![1]));
      expect(new Set(widths).size).toBe(3);
      expect(Math.min(...widths)).toBeGreaterThan(8);
    }
  });

  test('a cell that holds nothing is an empty cell, not a small tile', () => {
    const rows = [['a', 'p', 0], ['b', 'p', 40], ['a', 'q', 21], ['b', 'q', 0]];
    const tiles = paths(chartShapes(chart({ mark: 'cell', fields: ['x', 'y', 'v'], rows, encode: { x: 'x', y: 'y', value: 'v' } }), { detail: 'marks' })).filter((shape) => shape.fill === 'accent');
    expect(tiles.reduce((count, shape) => count + shape.d.split('M').length - 1, 0)).toBe(2);
    // The key still starts at nothing.
    expect(texts(chartShapes(chart({ mark: 'cell', fields: ['x', 'y', 'v'], rows, encode: { x: 'x', y: 'y', value: 'v' } })))).toContain('0');
  });

  test('spans in one lane that overlap in time stand in rows of their own; spans that only meet share a row', () => {
    const rows = [['Dish', 0, 6, 'listening'], ['Dish', 4, 5, 'locked'], ['Dish', 6, 9, 'listening'], ['Log', 0, 9, 'listening']];
    const shapes = paths(chartShapes(chart({ mark: 'span', fields: ['lane', 'from', 'to', 'state'], rows, encode: { x: 'from', x2: 'to', y: 'lane', series: 'state' } }), { detail: 'marks' }));
    const tops = (d: string) => [...d.matchAll(/M[\d.-]+ ([\d.-]+)h/g)].map((m) => Number(m[1]));
    const listening = tops(shapes.find((shape) => shape.fill === 'accent')!.d);
    const locked = tops(shapes.find((shape) => shape.fill === 'ink')!.d);
    // Dish 0-6 and Dish 6-9 meet and share a row; "locked" 4-5 lies inside the first and stands under it.
    expect(listening[0]).toBe(listening[1]);
    expect(locked[0]).toBeGreaterThan(listening[0]);
  });

  test('a rule past the data is still inside the chart: the scale grows to hold it', () => {
    const object = chart({ ...WEEKS, mark: 'bar', encode: { x: 'week', y: 'minutes' }, rules: [{ at: 40, label: 'limit' }] });
    const rule = paths(chartShapes(object)).find((shape) => shape.dash)!;
    const y = Number(rule.d.match(/^M[\d.]+ ([\d.-]+)H/)![1]);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(object.h);
    expect(texts(chartShapes(object))).toContain('limit');
  });

  test('stacked bars stand on each other: the scale holds their sum, not their largest', () => {
    const table = { fields: ['x', 'a', 'b'], rows: [['one', 60, 70], ['two', 10, 20]] };
    const top = (stack: boolean) => Math.max(...texts(chartShapes(chart({ ...table, mark: 'bar', encode: { x: 'x', y: ['a', 'b'] }, ...(stack ? { stack: true } : {}) }))).map(Number).filter(Number.isFinite));
    expect(top(false)).toBeLessThan(130);
    expect(top(true)).toBeGreaterThanOrEqual(130);
  });

  test('one small chart for each value of the facet, each named', () => {
    const rows = ['p1', 'p2', 'p3'].flatMap((player) => [[player, 'keys', 20], [player, 'knobs', 30]]);
    const shapes = chartShapes(chart({ mark: 'bar', fields: ['player', 'doing', 'minutes'], rows, encode: { x: 'doing', y: 'minutes', facet: 'player' }, w: 600, h: 300 }));
    for (const player of ['p1', 'p2', 'p3']) expect(texts(shapes)).toContain(player);
    expect(paths(shapes).filter((shape) => shape.fill === 'accent').length).toBe(3);
  });

  test('twelve small charts in a short box each keep a height: no bar is drawn upside down', () => {
    const rows = Array.from({ length: 24 }, (_row, i) => [`p${Math.floor(i / 2)}`, i % 2 ? 'b' : 'a', 5 + (i % 7)]);
    const shapes = chartShapes(chart({ mark: 'bar', title: 'Twelve', fields: ['player', 'doing', 'v'], rows, encode: { x: 'doing', y: 'v', facet: 'player' }, w: 200, h: 130 }), { detail: 'marks' });
    const bars = paths(shapes).filter((shape) => shape.fill === 'accent');
    expect(bars).toHaveLength(12);
    for (const bar of bars) for (const [, drop] of bar.d.matchAll(/v([\d.-]+)h/g)) expect(Number(drop)).toBeGreaterThan(0);
    // The taller of the two bars in a small chart reaches higher up the box.
    for (const bar of bars) {
      const [first, second] = [...bar.d.matchAll(/M[\d.-]+ ([\d.-]+)h[\d.-]+v([\d.-]+)/g)].map((m) => ({ top: Number(m[1]), drop: Number(m[2]) }));
      expect(Math.sign(first.top - second.top)).toBe(Math.sign(second.drop - first.drop));
    }
  });

  test('a long line of names is thinned, and the first and last are always written', () => {
    const rows = Array.from({ length: 60 }, (_row, i) => [`day ${i + 1}`, i]);
    const words = texts(chartShapes(chart({ mark: 'line', fields: ['day', 'v'], rows, encode: { x: 'day', y: 'v' } })));
    expect(words).toContain('day 1');
    expect(words).toContain('day 60');
    expect(words.filter((word) => word.startsWith('day ')).length).toBeLessThan(12);
  });
});

describe('the still picture', () => {
  const HOSTILE = '</text></svg><script>alert(1)</script><img src=x onerror="alert(2)">&"\'';
  const object = chart({
    mark: 'bar', title: HOSTILE, unit: '<u>',
    fields: ['x', 'v', 'k'], rows: [[HOSTILE.slice(0, CHART_LIMITS.cell), 1, HOSTILE.slice(0, 40)], ['b', 2, '<b>']],
    encode: { x: 'x', y: 'v', series: 'k' }, rules: [{ at: 1, label: HOSTILE.slice(0, CHART_LIMITS.cell) }],
  });

  test('every word of the chart is escaped: nothing in it can end an element or start one', () => {
    const svg = chartToSvg(object, PALETTE, { w: 900, h: 500 });
    expect(svg).not.toMatch(/<script|<img|<\/svg|<b>|<u>|onerror="/i);
    expect(svg).toContain('&lt;/TEXT&gt;&lt;/SVG&gt;&lt;SCRIPT&gt;');
    // Only our two elements, and every one closed.
    expect(svg.replace(/<text [^<>]*>[^<>]*<\/text>|<path [^<>]*\/>/g, '')).toBe('');
  });

  test('a colour that could end an attribute is escaped where it is written', () => {
    const svg = chartToSvg(object, { ...PALETTE, accent: '"/><script>x</script>' }, {});
    expect(svg).not.toContain('<script>');
  });

  test('it says what the board says: the same words, the same paths', () => {
    const plain = chart({ ...WEEKS, mark: 'area', encode: { x: 'week', y: 'minutes' }, title: 'Scan to alert', unit: 'min' });
    const shapes = chartShapes(plain);
    const svg = chartToSvg(plain, PALETTE);
    for (const word of texts(shapes)) expect(svg).toContain(`>${word}<`);
    for (const shape of paths(shapes)) expect(svg).toContain(`d="${shape.d}"`);
  });
});

describe('a chart in words', () => {
  test('a line is read from its left end to its right end, one series at a time', () => {
    expect(describeChart(chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] }, title: 'Scan to alert', unit: 'min' }))).toBe(
      'Scan to alert. Line chart of minutes from 11.2 to 1.3 min, plan from 10 to 8 min, by week: 3 rows, W1 to W3.',
    );
  });

  test('it is true of the rows: two series that both fall are never read as one that rises', () => {
    const rows = [['W1', 'A', 10], ['W2', 'A', 8], ['W1', 'B', 50], ['W2', 'B', 40]];
    expect(describeChart(chart({ mark: 'line', fields: ['week', 'team', 'minutes'], rows, encode: { x: 'week', y: 'minutes', series: 'team' } }))).toBe(
      'Line chart of minutes by team: A from 10 to 8, B from 50 to 40, by week: 4 rows, W1 to W2.',
    );
    // Rows out of order: read along the axis, not down the table.
    expect(describeChart(chart({ mark: 'line', fields: ['day', 'v'], rows: [[3, 5], [1, 9], [2, 7]], encode: { x: 'day', y: 'v' } }))).toBe('Line chart of v from 9 to 5, by day: 3 rows, 1 to 3.');
    expect(describeChart(chart({ mark: 'line', fields: ['week', 'team', 'minutes'], rows: [['W1', 'A', 1], ['W2', 'A', 2], ['W2', 'B', 9], ['W1', 'B', 7]], encode: { x: 'week', y: 'minutes', series: 'team' } }))).toContain('B from 7 to 9');
  });

  test('small charts, or more series than can be read out, give how far the values reach and claim no direction', () => {
    const rows = ['p1', 'p2', 'p3'].flatMap((player) => [[player, 'keys', 20], [player, 'knobs', 30]]);
    const faceted = describeChart(chart({ mark: 'line', fields: ['player', 'doing', 'minutes'], rows, encode: { x: 'doing', y: 'minutes', facet: 'player' } }));
    expect(faceted).toBe('Line chart of minutes, 20 to 30, by doing, one small chart for each player (3): 6 rows, keys to knobs.');
    const many = Array.from({ length: 10 }, (_row, i) => [i % 2, `k${i % 5}`, 10 - i]);
    const crowded = describeChart(chart({ mark: 'line', fields: ['x', 'k', 'v'], rows: many, encode: { x: 'x', y: 'v', series: 'k' } }));
    expect(crowded).toBe('Line chart of v in 5 series by k, 1 to 10, by x: 10 rows, 0 to 1.');
    expect(crowded).not.toContain('from');
  });

  test('nothing is never written as minus nothing', () => {
    const text = describeChart(chart({ mark: 'bar', fields: ['x', 'v'], rows: [['a', -0], ['b', 0]], encode: { x: 'x', y: 'v' } }));
    expect(text).toBe('Bar chart of v 0 to 0, by x: 2 rows, a to b.');
    expect(texts(chartShapes(chart({ mark: 'line', fields: ['x', 'v'], rows: [[1, -0], [2, -0]], encode: { x: 'x', y: 'v' } }))).join(' ')).not.toContain('-0');
  });

  test('bars by how far they reach; a grid and a timeline by their size', () => {
    expect(describeChart(chart({ ...WEEKS, mark: 'bar', encode: { x: 'week', y: 'minutes' } }))).toBe('Bar chart of minutes 1.3 to 11.2, by week: 3 rows, W1 to W3.');
    expect(describeChart(chart({ ...WEEKS, mark: 'cell', encode: { x: 'week', y: 'plan', value: 'minutes' } }))).toBe('Grid of minutes by week and plan, 3 by 3, 1.3 to 11.2.');
    expect(describeChart(chart({ ...WEEKS, mark: 'span', encode: { x: 'plan', x2: 'minutes', y: 'week' } }))).toBe('Timeline of 3 spans in 3 lanes, 1.3 to 11.2.');
  });
});
