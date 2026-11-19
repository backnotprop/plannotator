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

  test('dots of different series have different outlines, and the legend names every series on as many lines as it takes', () => {
    const rows = Array.from({ length: 8 }, (_row, i) => [10, 10, `a series with a long name ${i + 1}`]);
    const object = chart({ mark: 'dot', fields: ['x', 'y', 'k'], rows, encode: { x: 'x', y: 'y', series: 'k' }, w: 380, h: 300 });
    const shapes = chartShapes(object, { detail: 'marks' });
    // Eight dots at one place: eight outlines, none the same.
    const dots = paths(shapes).filter(isMark);
    expect(new Set(dots.map((shape) => shape.d)).size).toBe(8);
    const words = texts(chartShapes(object));
    for (let i = 1; i <= 8; i++) expect(words).toContain(`a series with a long name ${i}`);
    expect(words.filter((word) => /^\+\d/.test(word))).toEqual([]);
    const legend = chartShapes(object).filter((shape): shape is Extract<ChartShape, { kind: 'text' }> => shape.kind === 'text' && shape.text.startsWith('a series'));
    expect(legend).toHaveLength(8);
    expect(new Set(legend.map((shape) => shape.y)).size).toBeGreaterThan(1);
    for (const item of legend) expect(item.x + item.text.length * 6.1).toBeLessThanOrEqual(object.w);
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

  test('every step a mark is drawn in is strong enough to be seen: none is a faint patch', () => {
    const rows = Array.from({ length: 16 }, (_row, i) => [`n${i % 2}`, `k${i % 8}`, i + 1]);
    for (const mark of ['bar', 'dot', 'span', 'cell'] as const) {
      const encode = mark === 'span' ? { x: 'v', x2: 'v', y: 'x', series: 'k' } : mark === 'cell' ? { x: 'x', y: 'k', series: 'k' } : { x: 'x', y: 'v', series: 'k' };
      const marks = paths(chartShapes(chart({ mark, fields: ['x', 'k', 'v'], rows, encode, stack: true }), { detail: 'marks' })).filter(isMark);
      expect(marks.length).toBeGreaterThanOrEqual(8);
      for (const shape of marks) expect(shape.opacity ?? 1).toBeGreaterThanOrEqual((shape.fill ?? shape.stroke) === 'accent' ? 0.82 : 0.55);
      // Among the first five series there are filled marks and hollow ones: they differ by more than a shade.
      expect(marks.some((shape) => !shape.fill && shape.stroke)).toBe(true);
    }
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
