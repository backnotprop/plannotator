/**
 * The word marks of a question's before and after (change lines, approval
 * "before-after", the Versions card): which lines changed, and inside a
 * changed line which words were removed and which were added.
 *
 * The same engine as the plan diff (`planDiffEngine`, the `diff` package):
 * lines are paired first, then the words of a changed pair, the shape of
 * `git diff --word-diff`. Two rules keep the marks calm instead of confetti:
 *
 *  - a lone unchanged word between two changes joins the change (a rewrite
 *    reads as one run, not "removed · kept · removed");
 *  - a line that keeps less than `QUESTION_CHANGE_WHOLE_LINE_SHARE` (40%) of
 *    its words is mostly rewritten: it carries no marks on either side, and
 *    the card shows today's line plain and dimmed beside the new one plain
 *    (marking 90% of a line, or striking all of today's in red, is noise).
 *
 * Markdown in a value stays whole: a link, a picture or a code span is one
 * token (a changed link text marks the whole link), and `**bold**` / `*em*`
 * travel as flags on the words, so a mark never splits their syntax. A token
 * never splits a grapheme (an emoji sequence, a letter and its accents).
 *
 * Writing with no spaces between words (Chinese, Japanese, Thai and the
 * like): a changed line carries no marks (both lines drawn whole), never one
 * mark over the whole clause.
 *
 * Bounded: a pair over `QUESTION_CHANGE_MAX_DIFF_CHARS` (20,000 characters
 * together) is never diffed, and a diff that would take over
 * `QUESTION_CHANGE_MAX_EDITS` edits or 50 ms gives up; either way the lines
 * are shown unmarked. Results are kept per pair (a pick or a keystroke never
 * diffs again), except a diff that ran out of time: a slow moment is not
 * remembered as "unmarked" for good.
 *
 * Pure; never throws.
 */
import { diffArrays } from 'diff';

/** Under this share of surviving words a changed line is drawn unmarked (see above). */
export const QUESTION_CHANGE_WHOLE_LINE_SHARE = 0.4;

/** Over this many characters (before and after together) the lines are shown unmarked, never diffed. */
export const QUESTION_CHANGE_MAX_DIFF_CHARS = 20_000;
/** A diff that would need more edits than this (or over 50 ms) gives up: the lines are shown unmarked. */
export const QUESTION_CHANGE_MAX_EDITS = 500;
const DIFF_TIMEOUT_MS = 50;
const DIFF_LIMITS = { maxEditLength: QUESTION_CHANGE_MAX_EDITS, timeout: DIFF_TIMEOUT_MS } as const;

/** The clock a diff's time is measured on (tests swap it in `setQuestionChangeDiffClock`). */
let clock: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** Tests only: the clock diffs are timed with; returns the one it replaces. */
export function setQuestionChangeDiffClock(next: () => number): () => number {
  const previous = clock;
  clock = next;
  return previous;
}
/** Set while working out one pair when a diff gave up after running out of time. */
let ranOutOfTime = false;
/** A `diffArrays` result, noting a give-up that took the whole time allowed (not the edit cap, which always gives the same answer). */
function timedDiff<T>(run: () => T | undefined): T | undefined {
  const started = clock();
  const result = run();
  if (result === undefined && clock() - started >= DIFF_TIMEOUT_MS) ranOutOfTime = true;
  return result;
}

/** Scripts written with no spaces between words: no word marks there. */
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

export interface QuestionChangeToken {
  /** The text: a word, a space run or a punctuation mark as written; a link's
   *  text, a picture's alt, or a code span's contents for an atom. */
  text: string;
  kind: 'word' | 'space' | 'punct' | 'link' | 'image' | 'code';
  bold: boolean;
  em: boolean;
}

export interface QuestionChangeLine {
  /** `li` a list item (with its marker, `•` or `1.`), `h` a heading, `p` a line of prose. */
  kind: 'p' | 'li' | 'h';
  marker?: string;
  tokens: QuestionChangeToken[];
  /** The line as written, trimmed: what lines are paired on. */
  raw: string;
}

export interface QuestionChangeMarkedToken extends QuestionChangeToken {
  /** Removed (on the before side) or added (on the after side). */
  mark: boolean;
}

export type QuestionChangeRow =
  | { type: 'same'; before: QuestionChangeLine; after: QuestionChangeLine }
  | {
    type: 'mod';
    before: QuestionChangeLine;
    after: QuestionChangeLine;
    beforeTokens: QuestionChangeMarkedToken[];
    afterTokens: QuestionChangeMarkedToken[];
    /** Mostly rewritten (under the whole-line share): no marks on either side. */
    whole: boolean;
  }
  /** `unmarked`: the pair was too big to diff, so the line is shown as written, never marked. */
  | { type: 'del'; before: QuestionChangeLine; unmarked?: boolean }
  | { type: 'add'; after: QuestionChangeLine; unmarked?: boolean };

const LIST_RE = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;
const TOKEN_RE = /!\[([^\]\n]*)\]\([^)\n]+\)|\[([^\]\n]+)\]\([^)\n]+\)|`([^`\n]+)`|<(https?:\/\/[^>\s]+)>|\*\*|__|\*|\s+|[\p{L}\p{N}][\p{L}\p{N}'’.:/_-]*[\p{L}\p{N}]|[\p{L}\p{N}]|./gsu;

/** One line read into tokens (see the module comment). */
export function questionChangeLine(line: string): QuestionChangeLine {
  const raw = line.trim();
  let kind: QuestionChangeLine['kind'] = 'p';
  let marker: string | undefined;
  let text = raw;
  const list = raw.match(LIST_RE);
  const heading = list ? null : raw.match(HEADING_RE);
  if (list) {
    kind = 'li';
    marker = /\d/.test(list[1]) ? list[1] : '•';
    text = list[2];
  } else if (heading) {
    kind = 'h';
    text = heading[1];
  }
  // Emphasis markers are flags, read only when they pair up on the line.
  const boldMarks = (text.match(/\*\*|__/g) ?? []).length;
  const emMarks = (text.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  const tokens: QuestionChangeToken[] = [];
  let bold = false;
  let em = false;
  const starts = graphemeStarts(text);
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    if ((t === '**' || t === '__') && boldMarks % 2 === 0) { bold = !bold; continue; }
    if (t === '*' && emMarks % 2 === 0) { em = !em; continue; }
    // Inside a grapheme (an emoji's joiner or skin tone, an accent): the token before it goes on.
    const last = tokens[tokens.length - 1];
    if (starts && last && !starts.has(m.index!)) {
      last.text += t;
      continue;
    }
    const base = { bold, em };
    if (m[1] !== undefined) tokens.push({ text: m[1] || 'picture', kind: 'image', ...base });
    else if (m[2] !== undefined) tokens.push({ text: m[2], kind: 'link', ...base });
    else if (m[3] !== undefined) tokens.push({ text: m[3], kind: 'code', ...base });
    else if (m[4] !== undefined) tokens.push({ text: m[4], kind: 'link', ...base });
    else if (/^\s+$/.test(t)) tokens.push({ text: t, kind: 'space', ...base });
    else if (/^[\p{L}\p{N}]/u.test(t)) tokens.push({ text: t, kind: 'word', ...base });
    else tokens.push({ text: t, kind: 'punct', ...base });
  }
  return { kind, ...(marker ? { marker } : {}), tokens, raw };
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** Where each grapheme of the text starts, or null (no segmenter, or nothing past plain ASCII to split). */
function graphemeStarts(text: string): Set<number> | null {
  if (!graphemes || !/[^\x00-\x7f]/.test(text)) return null;
  const out = new Set<number>();
  for (const g of graphemes.segment(text)) out.add(g.index);
  return out;
}

/** The lines of a value (blank lines dropped: a value is drawn line by line). */
export function questionChangeLines(text: string | null | undefined): QuestionChangeLine[] {
  if (!text) return [];
  return text.split('\n').filter((l) => l.trim() !== '').map(questionChangeLine);
}

const counts = (t: QuestionChangeToken) => t.kind !== 'space' && t.kind !== 'punct';
const sameToken = (a: QuestionChangeToken, b: QuestionChangeToken) => a.text === b.text && a.kind === b.kind && a.bold === b.bold && a.em === b.em;

/** A changed pair drawn with no marks (mostly rewritten, unspaced writing, or too big to diff). */
const unmarked = (before: QuestionChangeLine, after: QuestionChangeLine): Extract<QuestionChangeRow, { type: 'mod' }> => ({
  type: 'mod',
  before,
  after,
  beforeTokens: before.tokens.map((t) => ({ ...t, mark: false })),
  afterTokens: after.tokens.map((t) => ({ ...t, mark: false })),
  whole: true,
});

/**
 * The word marks of one changed pair of lines. A lone unchanged word between
 * two changes joins them, as do the spaces between two changes: on both sides
 * at once, so a kept word reads kept (or changed) on both.
 */
function wordMarks(before: QuestionChangeLine, after: QuestionChangeLine): Extract<QuestionChangeRow, { type: 'mod' }> {
  if (UNSPACED_RE.test(before.raw) || UNSPACED_RE.test(after.raw)) return unmarked(before, after);
  const changes = timedDiff(() => diffArrays(before.tokens, after.tokens, { comparator: sameToken, ...DIFF_LIMITS }));
  if (!changes) return unmarked(before, after);
  const changed = (k: number) => k >= 0 && k < changes.length && !!(changes[k].added || changes[k].removed);
  const beforeTokens: QuestionChangeMarkedToken[] = [];
  const afterTokens: QuestionChangeMarkedToken[] = [];
  let a = 0;
  let b = 0;
  let kept = 0;
  changes.forEach((change, k) => {
    const n = change.count ?? change.value.length;
    if (change.removed) {
      for (let x = 0; x < n; x++) beforeTokens.push({ ...before.tokens[a++], mark: true });
    } else if (change.added) {
      for (let x = 0; x < n; x++) afterTokens.push({ ...after.tokens[b++], mark: true });
    } else {
      const run = before.tokens.slice(a, a + n);
      const joins = changed(k - 1) && changed(k + 1)
        && run.filter(counts).length <= 1 && !run.some((t) => t.kind === 'punct');
      for (let x = 0; x < n; x++) {
        if (!joins && counts(before.tokens[a])) kept++;
        beforeTokens.push({ ...before.tokens[a++], mark: joins });
        afterTokens.push({ ...after.tokens[b++], mark: joins });
      }
    }
  });
  const most = Math.max(before.tokens.filter(counts).length, after.tokens.filter(counts).length);
  if (most > 0 && kept / most < QUESTION_CHANGE_WHOLE_LINE_SHARE) return unmarked(before, after);
  return { type: 'mod', before, after, beforeTokens, afterTokens, whole: false };
}

/** Rows already worked out, by their pair (most recent last): a re-render never diffs again. */
const rowsCache = new Map<string, QuestionChangeRow[]>();
const ROWS_CACHE_SIZE = 200;

/**
 * The rows of a before and after: unchanged lines, changed pairs with their
 * word marks, and lines only one side has. Lines are paired by their text;
 * within a run of changed lines, removed and added lines pair in order.
 */
export function diffQuestionChange(before: string | null | undefined, after: string | null | undefined): QuestionChangeRow[] {
  const key = `${before ?? ''}\u0000${after ?? ''}`;
  const known = rowsCache.get(key);
  if (known) {
    rowsCache.delete(key);
    rowsCache.set(key, known);
    return known;
  }
  ranOutOfTime = false;
  const rows = computeRows(before, after);
  if (ranOutOfTime) return rows;
  rowsCache.set(key, rows);
  if (rowsCache.size > ROWS_CACHE_SIZE) rowsCache.delete(rowsCache.keys().next().value!);
  return rows;
}

function computeRows(before: string | null | undefined, after: string | null | undefined): QuestionChangeRow[] {
  const a = questionChangeLines(before);
  const b = questionChangeLines(after);
  const tooBig = (before?.length ?? 0) + (after?.length ?? 0) > QUESTION_CHANGE_MAX_DIFF_CHARS;
  const changes = tooBig ? undefined : timedDiff(() => diffArrays(a, b, { comparator: (x, y) => x.raw === y.raw, ...DIFF_LIMITS }));
  if (!changes) {
    // Too big to diff: every line shown as written, none marked (same lines still read as same).
    const rows: QuestionChangeRow[] = [];
    const n = Math.max(a.length, b.length);
    for (let k = 0; k < n; k++) {
      if (a[k] && b[k]) rows.push(a[k].raw === b[k].raw ? { type: 'same', before: a[k], after: b[k] } : unmarked(a[k], b[k]));
      else if (a[k]) rows.push({ type: 'del', before: a[k], unmarked: true });
      else rows.push({ type: 'add', after: b[k], unmarked: true });
    }
    return rows;
  }
  const rows: QuestionChangeRow[] = [];
  let i = 0;
  let j = 0;
  let removed: QuestionChangeLine[] = [];
  let added: QuestionChangeLine[] = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) rows.push(wordMarks(removed[k], added[k]));
    for (let k = pairs; k < removed.length; k++) rows.push({ type: 'del', before: removed[k] });
    for (let k = pairs; k < added.length; k++) rows.push({ type: 'add', after: added[k] });
    removed = [];
    added = [];
  };
  for (const change of changes) {
    const n = change.count ?? change.value.length;
    if (change.removed) for (let k = 0; k < n; k++) removed.push(a[i++]);
    else if (change.added) for (let k = 0; k < n; k++) added.push(b[j++]);
    else {
      flush();
      for (let k = 0; k < n; k++) rows.push({ type: 'same', before: a[i++], after: b[j++] });
    }
  }
  flush();
  return rows;
}

/** A value's words as a screen reader hears them: the markdown marks taken out, lines joined. */
export function questionChangePlainText(text: string | null | undefined): string {
  return questionChangeLines(text)
    .map((line) => line.tokens.map((t) => t.text).join('').trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;…]$/.test(line) ? line : `${line}.`))
    .join(' ');
}

/** The removed and added words of the rows (each run once, in order), for the screen reader's sentence. */
export function questionChangeMarkedRuns(rows: readonly QuestionChangeRow[]): { removed: string[]; added: string[] } {
  const runs = (tokens: readonly QuestionChangeMarkedToken[]) => {
    const out: string[] = [];
    let current = '';
    for (const t of tokens) {
      if (t.mark) current += t.text;
      else if (current) { out.push(current.trim()); current = ''; }
    }
    if (current.trim()) out.push(current.trim());
    return out.filter(Boolean);
  };
  const removed: string[] = [];
  const added: string[] = [];
  for (const row of rows) {
    if (row.type === 'mod' && !row.whole) {
      removed.push(...runs(row.beforeTokens));
      added.push(...runs(row.afterTokens));
    }
  }
  return { removed, added };
}
