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
 * travel as flags on the words, so a mark never splits their syntax.
 *
 * Pure; never throws.
 */
import { diffArrays } from 'diff';

/** Under this share of surviving words a changed line is drawn unmarked (see above). */
export const QUESTION_CHANGE_WHOLE_LINE_SHARE = 0.4;

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
  | { type: 'del'; before: QuestionChangeLine }
  | { type: 'add'; after: QuestionChangeLine };

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
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    if ((t === '**' || t === '__') && boldMarks % 2 === 0) { bold = !bold; continue; }
    if (t === '*' && emMarks % 2 === 0) { em = !em; continue; }
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

/** The lines of a value (blank lines dropped: a value is drawn line by line). */
export function questionChangeLines(text: string | null | undefined): QuestionChangeLine[] {
  if (!text) return [];
  return text.split('\n').filter((l) => l.trim() !== '').map(questionChangeLine);
}

const counts = (t: QuestionChangeToken) => t.kind !== 'space' && t.kind !== 'punct';
const sameToken = (a: QuestionChangeToken, b: QuestionChangeToken) => a.text === b.text && a.kind === b.kind && a.bold === b.bold && a.em === b.em;

/** A lone unchanged word between two changes joins them; spaces between two marks join too. */
function absorb(tokens: QuestionChangeMarkedToken[]): QuestionChangeMarkedToken[] {
  const out = tokens.map((t) => ({ ...t }));
  let i = 0;
  while (i < out.length) {
    if (out[i].mark) { i++; continue; }
    let j = i;
    while (j < out.length && !out[j].mark) j++;
    const run = out.slice(i, j);
    const words = run.filter(counts).length;
    const puncts = run.filter((t) => t.kind === 'punct').length;
    const before = i > 0 && out[i - 1].mark;
    const after = j < out.length && out[j].mark;
    if (before && after && puncts === 0 && words <= 1) for (const t of run) t.mark = true;
    i = j;
  }
  return out;
}

/** The word marks of one changed pair of lines. */
function wordMarks(before: QuestionChangeLine, after: QuestionChangeLine): Extract<QuestionChangeRow, { type: 'mod' }> {
  const changes = diffArrays(before.tokens, after.tokens, { comparator: sameToken });
  const beforeTokens: QuestionChangeMarkedToken[] = [];
  const afterTokens: QuestionChangeMarkedToken[] = [];
  let a = 0;
  let b = 0;
  let kept = 0;
  for (const change of changes) {
    const n = change.count ?? change.value.length;
    if (change.removed) {
      for (let k = 0; k < n; k++) beforeTokens.push({ ...before.tokens[a++], mark: true });
    } else if (change.added) {
      for (let k = 0; k < n; k++) afterTokens.push({ ...after.tokens[b++], mark: true });
    } else {
      for (let k = 0; k < n; k++) {
        if (counts(before.tokens[a])) kept++;
        beforeTokens.push({ ...before.tokens[a++], mark: false });
        afterTokens.push({ ...after.tokens[b++], mark: false });
      }
    }
  }
  const most = Math.max(before.tokens.filter(counts).length, after.tokens.filter(counts).length);
  const whole = most > 0 && kept / most < QUESTION_CHANGE_WHOLE_LINE_SHARE;
  if (whole) {
    return {
      type: 'mod',
      before,
      after,
      beforeTokens: before.tokens.map((t) => ({ ...t, mark: false })),
      afterTokens: after.tokens.map((t) => ({ ...t, mark: false })),
      whole: true,
    };
  }
  return { type: 'mod', before, after, beforeTokens: absorb(beforeTokens), afterTokens: absorb(afterTokens), whole: false };
}

/**
 * The rows of a before and after: unchanged lines, changed pairs with their
 * word marks, and lines only one side has. Lines are paired by their text;
 * within a run of changed lines, removed and added lines pair in order.
 */
export function diffQuestionChange(before: string | null | undefined, after: string | null | undefined): QuestionChangeRow[] {
  const a = questionChangeLines(before);
  const b = questionChangeLines(after);
  const changes = diffArrays(a, b, { comparator: (x, y) => x.raw === y.raw });
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
