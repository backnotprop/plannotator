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
      out.push({ ...table, mark, encode: { x: 'x', y: ['v', 'w'] }, stack: true, flip: true, dash: ['w'], rules: [{ at: 3, label: 'limit' }, { at: 'a', on: 'x' }, { at: 2, on: 'x' }] });
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
    for (const fields of awkward()) {
      // A negative size is refused by the codec (sizes are for dots); skip a table it does not take.
      const checked = checkObject({ id: 'c', type: 'chart', x: 0, y: 0, w: 380, h: 240, ...fields });
      if (!checked.ok) continue;
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
    expect(paths(chartShapes(cells, { detail: 'marks' })).length).toBeLessThanOrEqual(5);
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

  test('only a series that is named is dashed', () => {
    const object = chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] }, dash: ['plan', 'not a series'] });
    const lines = paths(chartShapes(object)).filter((shape) => shape.width === 2 || shape.width === 1.25);
    expect(lines.map((shape) => [shape.stroke, !!shape.dash])).toEqual([['ink', true], ['accent', false]]);
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
  test('a line is read from its start to its end', () => {
    expect(describeChart(chart({ ...WEEKS, mark: 'line', encode: { x: 'week', y: ['minutes', 'plan'] }, title: 'Scan to alert', unit: 'min' }))).toBe(
      'Scan to alert. Line chart of minutes from 11.2 to 1.3 min, plan from 10 to 8 min by week: 3 rows, W1 to W3.',
    );
  });

  test('bars by how far they reach; a grid and a timeline by their size', () => {
    expect(describeChart(chart({ ...WEEKS, mark: 'bar', encode: { x: 'week', y: 'minutes' } }))).toBe('Bar chart of minutes 1.3 to 11.2 by week: 3 rows, W1 to W3.');
    expect(describeChart(chart({ ...WEEKS, mark: 'cell', encode: { x: 'week', y: 'plan', value: 'minutes' } }))).toBe('Grid of minutes by week and plan, 3 by 3, 1.3 to 11.2.');
    expect(describeChart(chart({ ...WEEKS, mark: 'span', encode: { x: 'plan', x2: 'minutes', y: 'week' } }))).toBe('Timeline of 3 spans in 3 lanes, 1.3 to 11.2.');
  });
});
