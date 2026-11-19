/**
 * A chart from JSON someone else wrote. What passes `checkObject` is all the drawing ever sees, so every
 * way a table can be wrong is refused here, with a reason, and never guessed at.
 */
import { describe, expect, test } from 'bun:test';
import { CHART_LIMITS } from './chart';
import { checkObject, parseDocument, serializeDocument } from './codec';
import { createDocument } from './document';
import type { ChartObject } from './types';

const GOOD = {
  id: 'c', type: 'chart', x: 0, y: 0, w: 380, h: 240, mark: 'bar',
  fields: ['week', 'minutes', 'plan'],
  rows: [['W1', 11.2, 10], ['W2', 4.1, 10], ['W3', 1.3, 10]],
  encode: { x: 'week', y: 'minutes' },
};
const check = (change: Record<string, unknown>) => checkObject({ ...GOOD, ...change });
const refused = (change: Record<string, unknown>): string => {
  const result = check(change);
  return result.ok ? 'ACCEPTED' : result.error;
};
const table = (rows: number, fields: number) => ({
  fields: Array.from({ length: fields }, (_field, f) => (f === 0 ? 'x' : `v${f}`)),
  rows: Array.from({ length: rows }, (_row, r) => Array.from({ length: fields }, (_cell, f) => (f === 0 ? `r${r % 100}` : r * f))),
  encode: { x: 'x', y: 'v1' },
});

describe('a chart is a small table and an encoding', () => {
  test('a good one passes and is rebuilt from only what a chart has', () => {
    const result = check({ title: 'Scan to alert', unit: 'min', stack: true, rules: [{ at: 5, label: 'target' }], onclick: 'alert(1)', html: '<b>x</b>' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(['encode', 'fields', 'h', 'id', 'mark', 'rows', 'rules', 'stack', 'title', 'type', 'unit', 'w', 'x', 'y']);
    // The rows are a copy: changing what was sent afterwards changes nothing that was stored.
    expect((result.value as ChartObject).rows).not.toBe(GOOD.rows);
    expect((result.value as ChartObject).rows[0]).not.toBe(GOOD.rows[0]);
  });

  test('an option that means nothing for the mark is kept, so the mark can be changed back and forth', () => {
    for (const mark of ['bar', 'line', 'area', 'dot']) {
      const result = check({ mark, stack: true, flip: true, dash: ['plan'], encode: { x: 'week', y: ['minutes', 'plan'] } });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ stack: true, flip: true, dash: ['plan'] });
    }
  });

  test('a table at its limits passes, and saves and loads as the same table', () => {
    const full = check({ ...table(CHART_LIMITS.rows, CHART_LIMITS.fields), title: 'x'.repeat(CHART_LIMITS.title), unit: 'u'.repeat(CHART_LIMITS.unit) });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const doc = { ...createDocument('board'), objects: { c: full.value }, order: ['c'] };
    const loaded = parseDocument(JSON.parse(serializeDocument(doc)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect({ ...loaded.value.objects.c, z: undefined }).toEqual({ ...full.value, z: undefined });
  });
});

describe('a table that cannot be drawn is refused, with the reason', () => {
  test('the mark, the fields and the rows', () => {
    expect(refused({ mark: 'pie' })).toContain('mark must be one of');
    expect(refused({ fields: 'week,minutes' })).toContain('fields must be a list');
    expect(refused({ fields: [] })).toContain('fields must be a list');
    expect(refused(table(3, CHART_LIMITS.fields + 1))).toContain('fields must be a list');
    expect(refused({ rows: 'W1,11.2' })).toContain('rows must be a list');
    expect(refused({ rows: { length: 3, 0: ['W1', 1, 1] } })).toContain('rows must be a list');
    expect(refused({ rows: [] })).toContain('rows must be a list');
    expect(refused(table(CHART_LIMITS.rows + 1, 2))).toContain('rows must be a list');
    // A ragged row, a row that is not a list, a row with a hole in it.
    expect(refused({ rows: [['W1', 1, 1], ['W2', 2]] })).toContain('as long as fields');
    expect(refused({ rows: [['W1', 1, 1, 9]] })).toContain('as long as fields');
    expect(refused({ rows: [{ week: 'W1', minutes: 1, plan: 1 }] })).toContain('as long as fields');
    // eslint-disable-next-line no-sparse-arrays
    expect(refused({ rows: [['W1', , 1]] })).toContain('a cell is');
  });

  test('a cell is a finite number or short text, and nothing else', () => {
    for (const cell of [NaN, Infinity, -Infinity, CHART_LIMITS.number * 10, null, true, undefined, {}, [1], 'x'.repeat(CHART_LIMITS.cell + 1), 10n, () => 1]) {
      expect(refused({ rows: [['W1', cell, 1]] })).toContain('a cell is');
    }
    // What JSON makes of a number that is not one is null: refused the same.
    expect(refused(JSON.parse(JSON.stringify({ rows: [['W1', NaN, 1]] })))).toContain('a cell is');
  });

  test('a field is named in a closed grammar: nothing that is also a name on every object, no markup', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '', ' week', 'week ', '<b>', 'a"b', "a'b", 'a&b', 'a\nb', '-x', 'x'.repeat(CHART_LIMITS.fieldName + 1), 7, null]) {
      expect(refused({ fields: [name, 'minutes', 'plan'], encode: { x: 'minutes', y: 'plan' } })).toContain("a field's name");
    }
    expect(refused({ fields: ['week', 'minutes', 'minutes'] })).toContain('listed twice');
    // Names in other scripts and with the listed marks are fine.
    expect(check({ fields: ['週', 'p95 ms', 'CPU %/core'], encode: { x: '週', y: 'p95 ms' } }).ok).toBe(true);
  });

  test('an encoding names fields that are there, from a closed list of places', () => {
    expect(refused({ encode: undefined })).toContain('encode is missing');
    expect(refused({ encode: 'week,minutes' })).toContain('encode is missing');
    expect(refused({ encode: { x: 'week' } })).toContain('encode.y');
    expect(refused({ encode: { x: 'nope', y: 'minutes' } })).toContain('encode.x must name');
    expect(refused({ encode: { x: 'week', y: 'nope' } })).toContain('encode.y must name');
    expect(refused({ encode: { x: 'week', y: 'minutes', series: 'nope' } })).toContain('encode.series must name');
    expect(refused({ encode: { x: 'week', y: 'minutes', colour: 'plan' } })).toContain('encode has no "colour"');
    expect(refused({ encode: { x: 'week', y: 'minutes', __proto__: null, constructor: 'plan' } })).toContain('encode has no "constructor"');
    expect(refused({ encode: { x: 'week', y: [] } })).toContain('encode.y is one field');
    expect(refused({ encode: { x: 'week', y: ['minutes', 'minutes'] } })).toContain('twice');
    expect(refused({ ...table(3, 6), encode: { x: 'x', y: ['v1', 'v2', 'v3', 'v4', 'v5'] } })).toContain('encode.y is one field');
    expect(refused({ encode: { x: 'week', y: ['minutes', 'plan'], series: 'week' } })).toContain('not both');
  });

  test('what a mark measures must be numbers, and what it needs must be there', () => {
    expect(refused({ encode: { x: 'minutes', y: 'week' } })).toContain('must be a number');
    expect(refused({ rows: [['W1', '11.2', 10]] })).toContain('must be a number');
    expect(refused({ mark: 'span' })).toContain('needs encode.x2');
    expect(refused({ mark: 'span', encode: { x: 'week', x2: 'minutes', y: 'plan' } })).toContain('must be a number');
    expect(check({ mark: 'span', encode: { x: 'minutes', x2: 'plan', y: 'week' } }).ok).toBe(true);
    expect(refused({ mark: 'cell' })).toContain('needs encode.value');
    expect(refused({ mark: 'cell', encode: { x: 'week', y: 'plan', value: 'week' } })).toContain('must be a number');
    expect(check({ mark: 'cell', encode: { x: 'week', y: 'plan', value: 'minutes' } }).ok).toBe(true);
    expect(check({ mark: 'cell', encode: { x: 'week', y: 'plan', series: 'week' } }).ok).toBe(true);
    expect(refused({ mark: 'dot', encode: { x: 'minutes', y: 'plan', size: 'week' } })).toContain('must be a number');
  });

  test('no more series, small charts or names than can be told apart', () => {
    const many = (count: number) => ({ fields: ['x', 'kind', 'v'], rows: Array.from({ length: count }, (_row, i) => [i, `k${i}`, i]) });
    expect(check({ ...many(CHART_LIMITS.series), encode: { x: 'x', y: 'v', series: 'kind' } }).ok).toBe(true);
    expect(refused({ ...many(CHART_LIMITS.series + 1), encode: { x: 'x', y: 'v', series: 'kind' } })).toContain('different values');
    expect(check({ ...many(CHART_LIMITS.facets), encode: { x: 'x', y: 'v', facet: 'kind' } }).ok).toBe(true);
    expect(refused({ ...many(CHART_LIMITS.facets + 1), encode: { x: 'x', y: 'v', facet: 'kind' } })).toContain('different values');
    expect(refused({ ...many(CHART_LIMITS.categories + 1), mark: 'bar', encode: { x: 'kind', y: 'v' } })).toContain('different values');
    // A line may have as many points as rows: only names that each need room are counted.
    expect(check({ ...many(CHART_LIMITS.categories + 1), mark: 'line', encode: { x: 'kind', y: 'v' } }).ok).toBe(true);
  });

  test('the options are words from closed lists', () => {
    expect(refused({ stack: 'yes' })).toContain('stack is true');
    expect(refused({ flip: 1 })).toContain('flip is true');
    expect(refused({ dash: 'plan' })).toContain('dash is a list');
    expect(refused({ dash: [7] })).toContain('dash is a list');
    expect(refused({ dash: Array.from({ length: CHART_LIMITS.series + 1 }, (_name, i) => `s${i}`) })).toContain('dash is a list');
    expect(refused({ rules: { at: 5 } })).toContain('rules is a list');
    expect(refused({ rules: Array.from({ length: CHART_LIMITS.rules + 1 }, () => ({ at: 1 })) })).toContain('rules is a list');
    expect(refused({ rules: [5] })).toContain('a rule must be');
    expect(refused({ rules: [{ at: NaN }] })).toContain('"at" must be a number');
    expect(refused({ rules: [{ at: 'W2' }] })).toContain('"at" must be a number');
    expect(check({ rules: [{ at: 'W2', on: 'x' }] }).ok).toBe(true);
    expect(refused({ rules: [{ at: 5, on: 'y' }] })).toContain('"on" is "x"');
    expect(refused({ rules: [{ at: 5, color: 'red' }] })).toContain('a rule has');
    expect(refused({ rules: [{ at: 5, label: 'x'.repeat(CHART_LIMITS.cell + 1) }] })).toContain('label is too long');
    expect(refused({ unit: 'x'.repeat(CHART_LIMITS.unit + 1) })).toContain('unit is at most');
    expect(refused({ title: 'x'.repeat(CHART_LIMITS.title + 1) })).toContain('title is too long');
    expect(refused({ title: 7 })).toContain('title is too long');
  });

  test('a chart has a size in all, well under what its limits one by one would let it reach', () => {
    // Every cell at its longest: 500 rows of 12 would be 480,000 characters. The whole chart is held to 64,000.
    const wide = (rows: number) => ({ fields: ['x', 'a', 'b'], rows: Array.from({ length: rows }, (_row, r) => [`${r}`.padEnd(CHART_LIMITS.cell, 'x'), 'y'.repeat(CHART_LIMITS.cell), r]), encode: { x: 'x', y: 'b' }, mark: 'line' });
    expect(check(wide(300)).ok).toBe(true);
    expect(refused(wide(500))).toContain(`at most ${CHART_LIMITS.characters} characters in all`);
    // Numbers count as they are written.
    const long = { fields: ['x', 'v'], rows: Array.from({ length: 500 }, (_row, r) => [r + 0.123456789012, 123456789.123456 + r]), encode: { x: 'x', y: 'v' }, mark: 'line' };
    expect(check(long).ok).toBe(true);
    expect(refused({ ...long, fields: ['x', 'v', 'w', 'u', 't', 's', 'r', 'q', 'p', 'o'], rows: long.rows.map((row) => [...row, ...row, ...row, ...row, ...row]) })).toContain('characters in all');
  });

  test('no word of a chart holds a control character or a mark that turns the text round', () => {
    for (const bad of ['a\u0000b', 'a\u0001', 'two\nlines', 'tab\there', '\u007f', '\u0085', 'safe\u202egnp.exe', '\u2066x\u2069']) {
      expect(refused({ rows: [[bad, 1, 1]] })).toContain('no control characters');
      expect(refused({ title: bad })).toContain('control character');
      expect(refused({ unit: bad.slice(0, 6) })).toContain('unit is at most');
      expect(refused({ rules: [{ at: 1, label: bad }] })).toContain('control character');
      expect(refused({ dash: [bad] })).toContain('dash is a list');
    }
    // Words in any script, and marks a script needs to join its letters, are words.
    expect(check({ rows: [['週 الأسبوع ‍👩‍💻', 1, 1]], title: 'Ünïcödé — ok' }).ok).toBe(true);
  });

  test('a rule that would have nowhere to stand is refused with the reason, not kept and never drawn', () => {
    // Names along the bottom: an upright rule stands at one of them.
    expect(check({ rules: [{ at: 'W2', on: 'x' }] }).ok).toBe(true);
    expect(refused({ rules: [{ at: 'W9', on: 'x' }] })).toContain('must be one of the names along the x axis ("W9" is not)');
    // A number line along the bottom: at a number.
    const numbered = { mark: 'line', fields: ['week', 'v'], rows: [[1, 5], [2, 4]], encode: { x: 'week', y: 'v' } };
    expect(check({ ...numbered, rules: [{ at: 6, on: 'x' }] }).ok).toBe(true);
    expect(refused({ ...numbered, rules: [{ at: 'W36', on: 'x' }] })).toContain('x axis is a number line');
    const gantt = { mark: 'span', fields: ['lane', 'from', 'to'], rows: [['a', 1, 3]], encode: { x: 'from', x2: 'to', y: 'lane' } };
    expect(check({ ...gantt, rules: [{ at: 2, on: 'x', label: 'today' }] }).ok).toBe(true);
    expect(refused({ ...gantt, rules: [{ at: 'W36', on: 'x', label: 'today' }] })).toContain('x axis is a number line');
    expect(refused({ mark: 'cell', encode: { x: 'week', y: 'plan', value: 'minutes' }, rules: [{ at: 'W2', on: 'x' }] })).toContain('a cell chart draws no rules');
    expect(refused({ mark: 'cell', encode: { x: 'week', y: 'plan', value: 'minutes' }, rules: [{ at: 3 }] })).toContain('a cell chart draws no rules');
    // A bar's x axis is always names, even when they are numbers.
    expect(check({ mark: 'bar', fields: ['n', 'v'], rows: [[1, 5], [2, 4]], encode: { x: 'n', y: 'v' }, rules: [{ at: 2, on: 'x' }] }).ok).toBe(true);
  });

  test('its colour is a colour from the closed grammar, like any object', () => {
    expect(check({ color: 'green' }).ok).toBe(true);
    expect(check({ color: { custom: '#c2410c' } }).ok).toBe(true);
    for (const color of [{ custom: 'url(https://x.test/a.png)' }, { custom: 'red;background:url(x)' }, { custom: 'var(--x)' }, 'chartreuse-ish', { custom: 'expression(alert(1))' }]) {
      expect(refused({ color })).toContain('color');
    }
  });
});
