/**
 * Reading a chart from JSON someone else wrote. Fail closed, like the rest of the codec: a chart is a
 * small table and a few words from closed lists, and anything else is refused with a reason.
 *
 * What is checked here is what the drawing relies on (`view/chart.ts`), so that never has to doubt its
 * input: every row is as long as the list of fields, every field a mark measures holds finite numbers,
 * every name an encoding uses is a field, and the table is small enough to draw in a frame.
 *
 * An option that means nothing for the mark (`stack` on a line, `dash` on a bar) is kept and not drawn,
 * so a person can change the mark without first undoing every option. RULES are the exception: a rule
 * must have somewhere to be drawn, so a `cell` chart with rules is refused, and an upright rule must
 * stand at a place its x axis has (a number on a number line, else one of the names along it). That ties
 * the rules to the mark and to the rows: an edit that takes away the place a rule stands at is refused
 * with the reason until the rule goes too (see "Known limits" in the canvas guide).
 */
import { CHART_MARKS, type ChartCell, type ChartEncode, type ChartMark, type ChartObject, type ChartRule } from './types';

export const CHART_LIMITS = {
  rows: 500,
  fields: 12,
  /** The longest a text cell, a field name, a rule's word or a series name may be. */
  cell: 80,
  fieldName: 32,
  /** The largest number a cell may hold, either sign. Past this a scale's arithmetic stops being exact. */
  number: 1e12,
  /** How many `y` fields may be drawn as series. */
  yFields: 4,
  /** How many different values a `series` field may hold. */
  series: 8,
  facets: 12,
  rules: 8,
  /** How many different values a field used as names along an axis may hold (`cell` and `span` rows, bars). */
  categories: 200,
  unit: 12,
  title: 300,
  /**
   * The most characters a chart may hold in all: every field name, every cell (a number as it is written),
   * every word of its rules, its series to dash, its title and unit. A real table of 500 rows by 4 numbers is
   * about 10,000; this is the size of the largest HTML item, so a chart is never the heaviest thing on a board.
   */
  characters: 64_000,
} as const;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

/** What a chart holds beyond a placed object's own fields. */
export type ChartFields = Pick<ChartObject, 'mark' | 'fields' | 'rows' | 'encode' | 'stack' | 'flip' | 'dash' | 'rules' | 'title' | 'unit'>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= CHART_LIMITS.number;
/**
 * Characters no word of a chart may hold: the control characters (a chart's words are one line each, and
 * one of these in a file makes it fail to load), and the marks that turn the direction of the text round,
 * which can make a label read as something it is not.
 */
const UNSEEN_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !UNSEEN_RE.test(value);

/**
 * A field's name: a letter or digit, then letters, digits, spaces and `_ - . % /`. Never a name every
 * object has (`constructor`, `toString`): a field is looked up by its place in the list, but a name that
 * could be mistaken for a property is not worth having in a document at all.
 */
const FIELD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.%/-]*$/u;
export const isChartFieldName = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= CHART_LIMITS.fieldName && FIELD_NAME_RE.test(value) && !(value in Object.prototype) && value !== 'prototype' && value.trim() === value;

const ENCODE_KEYS = ['x', 'y', 'series', 'x2', 'value', 'size', 'facet'] as const;

/** How many different values a column holds, counted as the drawing counts them (as text). */
function distinct(rows: ChartCell[][], column: number): number {
  const seen = new Set<string>();
  for (const row of rows) seen.add(String(row[column]));
  return seen.size;
}

const allNumbers = (rows: ChartCell[][], column: number): boolean => rows.every((row) => typeof row[column] === 'number');

export function checkChart(value: Record<string, unknown>, id: string): { ok: true; value: ChartFields } | Fail {
  if (!(CHART_MARKS as readonly unknown[]).includes(value.mark)) return fail(`${id}: mark must be one of ${CHART_MARKS.join(', ')}`);
  const mark = value.mark as ChartMark;

  const rawFields = value.fields;
  if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > CHART_LIMITS.fields) return fail(`${id}: fields must be a list of 1 to ${CHART_LIMITS.fields} names`);
  const fields: string[] = [];
  for (const name of rawFields) {
    if (!isChartFieldName(name)) return fail(`${id}: a field's name is 1 to ${CHART_LIMITS.fieldName} letters, digits, spaces and _ - . % /, starting with a letter or digit`);
    if (fields.includes(name)) return fail(`${id}: the field ${JSON.stringify(name)} is listed twice`);
    fields.push(name);
  }

  const rawRows = value.rows;
  if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > CHART_LIMITS.rows) return fail(`${id}: rows must be a list of 1 to ${CHART_LIMITS.rows} rows`);
  const rows: ChartCell[][] = [];
  let total = fields.reduce((sum, name) => sum + name.length, 0);
  for (const raw of rawRows) {
    if (!Array.isArray(raw) || raw.length !== fields.length) return fail(`${id}: every row must be a list as long as fields (${fields.length})`);
    const row: ChartCell[] = [];
    for (const cell of raw) {
      if (!isNumber(cell) && !isText(cell, CHART_LIMITS.cell)) return fail(`${id}: a cell is a finite number or text of at most ${CHART_LIMITS.cell} characters, with no control characters`);
      total += typeof cell === 'number' ? String(cell).length : cell.length;
      row.push(cell);
    }
    rows.push(row);
    if (total > CHART_LIMITS.characters) return fail(`${id}: a chart holds at most ${CHART_LIMITS.characters} characters in all its cells and names`);
  }

  const rawEncode = value.encode;
  if (!isRecord(rawEncode)) return fail(`${id}: encode is missing`);
  for (const key of Object.keys(rawEncode)) if (!(ENCODE_KEYS as readonly string[]).includes(key)) return fail(`${id}: encode has no "${key.slice(0, 40)}"`);
  const column = (name: unknown): number => (typeof name === 'string' ? fields.indexOf(name) : -1);
  const named = (key: string, name: unknown): Fail | null => (column(name) === -1 ? fail(`${id}: encode.${key} must name one of the fields`) : null);
  const ys = Array.isArray(rawEncode.y) ? rawEncode.y : [rawEncode.y];
  if (ys.length < 1 || ys.length > CHART_LIMITS.yFields) return fail(`${id}: encode.y is one field, or a list of 1 to ${CHART_LIMITS.yFields}`);
  if (new Set(ys).size !== ys.length) return fail(`${id}: encode.y names a field twice`);
  for (const [key, name] of [['x', rawEncode.x], ...ys.map((y) => ['y', y] as const)] as const) {
    const bad = named(key, name);
    if (bad) return bad;
  }
  const encode: ChartEncode = { x: rawEncode.x as string, y: Array.isArray(rawEncode.y) ? (ys as string[]) : (ys[0] as string) };
  for (const key of ['series', 'x2', 'value', 'size', 'facet'] as const) {
    if (rawEncode[key] === undefined) continue;
    const bad = named(key, rawEncode[key]);
    if (bad) return bad;
    encode[key] = rawEncode[key] as string;
  }
  if (encode.series && ys.length > 1) return fail(`${id}: a chart has several y fields or a series field, not both`);

  // What each mark measures must be numbers; what it names may be anything, within a count it can draw.
  const numeric = (key: string, name: string): Fail | null => (allNumbers(rows, column(name)) ? null : fail(`${id}: every value of ${JSON.stringify(name)} must be a number (it is encode.${key})`));
  const counted = (key: string, name: string, max: number): Fail | null => (distinct(rows, column(name)) <= max ? null : fail(`${id}: ${JSON.stringify(name)} holds more than ${max} different values (it is encode.${key})`));
  const checks: (Fail | null)[] = [];
  if (mark === 'cell') {
    if (!encode.value && !encode.series) return fail(`${id}: a cell chart needs encode.value (a number) or encode.series (a kind)`);
    checks.push(counted('x', encode.x, CHART_LIMITS.categories), counted('y', ys[0] as string, CHART_LIMITS.categories));
    if (ys.length > 1) return fail(`${id}: a cell chart has one y field`);
  } else if (mark === 'span') {
    if (!encode.x2) return fail(`${id}: a span chart needs encode.x2, where each span ends`);
    if (ys.length > 1) return fail(`${id}: a span chart has one y field`);
    checks.push(numeric('x', encode.x), numeric('x2', encode.x2), counted('y', ys[0] as string, CHART_LIMITS.categories));
  } else {
    for (const y of ys as string[]) checks.push(numeric('y', y));
    if (mark === 'bar') checks.push(counted('x', encode.x, CHART_LIMITS.categories));
  }
  if (encode.value) checks.push(numeric('value', encode.value));
  if (encode.size) checks.push(numeric('size', encode.size));
  if (encode.series) checks.push(counted('series', encode.series, CHART_LIMITS.series));
  if (encode.facet) checks.push(counted('facet', encode.facet, CHART_LIMITS.facets));
  for (const bad of checks) if (bad) return bad;

  // Whether the x axis is a number line (a span's always is; a bar's never), and the names along it when it is not.
  const xColumn = column(encode.x);
  const numberLine = mark === 'span' || (mark !== 'bar' && allNumbers(rows, xColumn));
  const xNames = new Set(numberLine ? [] : rows.map((row) => String(row[xColumn])));
  const out: ChartFields = { mark, fields, rows, encode };
  for (const key of ['stack', 'flip'] as const) {
    if (value[key] === undefined) continue;
    if (value[key] !== true) return fail(`${id}: ${key} is true or left out`);
    out[key] = true;
  }
  if (value.dash !== undefined) {
    const dash = value.dash;
    if (!Array.isArray(dash) || dash.length > CHART_LIMITS.series || !dash.every((name) => isText(name, CHART_LIMITS.cell))) return fail(`${id}: dash is a list of at most ${CHART_LIMITS.series} series names`);
    if (dash.length) out.dash = [...(dash as string[])];
    total += (dash as string[]).reduce((sum, name) => sum + name.length, 0);
  }
  if (value.rules !== undefined) {
    const rules = value.rules;
    if (!Array.isArray(rules) || rules.length > CHART_LIMITS.rules) return fail(`${id}: rules is a list of at most ${CHART_LIMITS.rules}`);
    // A rule must have somewhere to be drawn, or it would be kept and never seen.
    if (mark === 'cell' && rules.length) return fail(`${id}: a cell chart draws no rules`);
    const kept: ChartRule[] = [];
    for (const raw of rules) {
      if (!isRecord(raw)) return fail(`${id}: a rule must be a JSON object`);
      for (const key of Object.keys(raw)) if (key !== 'at' && key !== 'label' && key !== 'on') return fail(`${id}: a rule has "at", "label" and "on"`);
      if (raw.on !== undefined && raw.on !== 'x') return fail(`${id}: a rule's "on" is "x" or left out`);
      // Across the chart a rule sits at a number; upright it may also sit at one of the names along the bottom.
      if (!(isNumber(raw.at) || (raw.on === 'x' && isText(raw.at, CHART_LIMITS.cell)))) return fail(`${id}: a rule's "at" must be a number${raw.on === 'x' ? ' or a name' : ''}`);
      if (raw.on === 'x') {
        // An upright rule stands at a place the x axis has.
        if (numberLine && !isNumber(raw.at)) return fail(`${id}: this chart's x axis is a number line, so an upright rule's "at" must be a number`);
        if (!numberLine && !xNames.has(String(raw.at))) return fail(`${id}: an upright rule's "at" must be one of the names along the x axis (${JSON.stringify(String(raw.at).slice(0, 40))} is not)`);
      }
      if (raw.label !== undefined && !isText(raw.label, CHART_LIMITS.cell)) return fail(`${id}: a rule's label is too long or holds a control character`);
      total += (typeof raw.at === 'string' ? raw.at.length : 0) + (typeof raw.label === 'string' ? raw.label.length : 0);
      kept.push({ at: raw.at as ChartCell, ...(raw.label ? { label: raw.label as string } : {}), ...(raw.on ? { on: 'x' as const } : {}) });
    }
    if (kept.length) out.rules = kept;
  }
  if (value.title !== undefined) {
    if (!isText(value.title, CHART_LIMITS.title)) return fail(`${id}: title is too long or holds a control character`);
    if (value.title) out.title = value.title;
  }
  if (value.unit !== undefined) {
    if (!isText(value.unit, CHART_LIMITS.unit)) return fail(`${id}: unit is at most ${CHART_LIMITS.unit} characters`);
    if (value.unit) out.unit = value.unit;
  }
  if (total + (out.title?.length ?? 0) + (out.unit?.length ?? 0) > CHART_LIMITS.characters) return fail(`${id}: a chart holds at most ${CHART_LIMITS.characters} characters in all its cells and names`);
  return { ok: true, value: out };
}
