/**
 * Plannotator Inbox search: the text rules both sides share (browser-safe,
 * no Node). The server's index (packages/shared/inbox/search.ts) tokenizes
 * stored text with these functions, and the window highlights the query's
 * words in the message it lands on with the same ones, so a word the index
 * matched is the word the window marks.
 *
 * - Normalization: NFKC, default-ignorable code points dropped, case folded
 *   (upper then lower, the `inboxThreadNameKey` rule), then Latin, Greek and
 *   Cyrillic accents dropped (NFD, U+0300 to U+036F), so `resume` finds
 *   `résumé`. Matching only: every offset this module hands out points into
 *   the ORIGINAL text.
 * - Tokens: maximal runs of letters, digits and combining marks, cut further
 *   where `Intl.Segmenter` (word granularity) puts a word boundary, so
 *   Japanese and Chinese split into words without spaces. A run of plain
 *   ASCII takes a fast path that gives the same tokens. A token under 2
 *   characters is dropped unless it is CJK.
 * - A query is at most 200 characters and 8 terms; every term must match,
 *   the last one as a prefix.
 */

import type { InboxSectionId } from './inbox-types';

export const INBOX_SEARCH_QUERY_MAX = 200;
export const INBOX_SEARCH_TERMS_MAX = 8;

/** One token of a text: its folded form and where it sits in the original (UTF-16 offsets). */
export interface InboxSearchToken {
  token: string;
  start: number;
  end: number;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const ACCENTS = /[̀-ͯ]/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Scripts written without spaces between words: only these need the segmenter. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const NON_ASCII = /[^\x00-\x7f]/;
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;

let wordSegmenter: Intl.Segmenter | null | undefined;
function segmenter(): Intl.Segmenter | null {
  if (wordSegmenter === undefined) {
    wordSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  }
  return wordSegmenter;
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;
function graphemes(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return graphemeSegmenter;
}

/** The folded form of one piece of text (matching only). */
export function foldInboxSearchText(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  return text.normalize('NFKC').replace(IGNORABLE, '').toUpperCase().toLowerCase().normalize('NFD').replace(ACCENTS, '').normalize('NFC');
}

export function isCjkToken(token: string): boolean {
  return CJK.test(token);
}

/** Visits each token: its folded form and where it sits in the original. */
export type InboxSearchTokenVisitor = (token: string, start: number, end: number) => void;

function visitRun(text: string, start: number, end: number, visit: InboxSearchTokenVisitor): void {
  const token = foldInboxSearchText(text.slice(start, end));
  if (token.length >= 2 || (token.length > 0 && CJK.test(token))) visit(token, start, end);
}

/** A chunk with a character outside ASCII: word runs, cut where the segmenter cuts in scripts written without spaces. */
function visitRich(text: string, from: number, to: number, visit: InboxSearchTokenVisitor): void {
  const part = text.slice(from, to);
  const words = NO_SPACES.test(part) ? segmenter() : null;
  if (!words) {
    for (const match of part.matchAll(WORD_RUN)) visitRun(text, from + match.index!, from + match.index! + match[0].length, visit);
    return;
  }
  for (const segment of words.segment(part)) {
    if (!segment.isWordLike) continue;
    const base = from + segment.index;
    for (const match of segment.segment.matchAll(WORD_RUN)) visitRun(text, base + match.index!, base + match.index! + match[0].length, visit);
  }
}

/** JavaScript's `\s`: where a word always ends. */
function isSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0x85) return false;
  return c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Every token of a text, in order. Whitespace always breaks a word, so each
 * whitespace-separated chunk is read by itself: plain ASCII by a character
 * scan (maximal runs of letters and digits, which is what the segmenter gives
 * there once its words are cut at punctuation), anything else as word runs of
 * letters, digits and marks, through `Intl.Segmenter` when the chunk holds a
 * script written without spaces (Chinese, Japanese, Korean, Thai, Lao, Khmer,
 * Myanmar).
 */
export function forEachInboxSearchToken(text: string, visit: InboxSearchTokenVisitor): void {
  scanInboxSearchTokens(text, (start, end, upper) => {
    const raw = text.slice(start, end);
    visit(upper ? raw.toLowerCase() : raw, start, end);
  }, visit);
}

/**
 * The scan under `forEachInboxSearchToken`, for a caller that can look an
 * ASCII token up without a string: `ascii(start, end, upper)` gets the span of
 * a plain ASCII token (letters and digits, 2 or more; `upper` when it holds
 * a capital, so its folded form is the span lower-cased); every other token
 * comes folded through `other`.
 */
export function scanInboxSearchTokens(text: string, ascii: (start: number, end: number, upper: boolean) => void, other: InboxSearchTokenVisitor): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (isSpace(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    let plain = true;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c > 0x7f) {
        if (isSpace(c)) break;
        plain = false;
      } else if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) break;
    }
    if (plain) {
      let start = -1;
      let upper = false;
      for (let k = i; k <= j; k++) {
        const c = k < j ? text.charCodeAt(k) : 0;
        const lower = c >= 0x61 && c <= 0x7a;
        const up = c >= 0x41 && c <= 0x5a;
        if (lower || up || (c >= 0x30 && c <= 0x39)) {
          if (start < 0) {
            start = k;
            upper = false;
          }
          if (up) upper = true;
        } else if (start >= 0) {
          if (k - start >= 2) ascii(start, k, upper);
          start = -1;
        }
      }
    } else {
      visitRich(text, i, j, other);
    }
    i = j;
  }
}

/** A text's tokens with their places (see `forEachInboxSearchToken`). */
export function tokenizeInboxSearchText(text: string): InboxSearchToken[] {
  const out: InboxSearchToken[] = [];
  if (text) forEachInboxSearchToken(text, (token, start, end) => out.push({ token, start, end }));
  return out;
}

/** The terms a query searches for: its tokens, in order, duplicates kept once, at most 8. */
export function inboxSearchTerms(query: string): string[] {
  const q = query.trim().slice(0, INBOX_SEARCH_QUERY_MAX);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { token } of tokenizeInboxSearchText(q)) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= INBOX_SEARCH_TERMS_MAX) break;
  }
  return out;
}

/**
 * Where in an original token a folded prefix of `length` characters ends: the
 * smallest original end whose folded form is at least that long.
 */
function prefixEnd(text: string, start: number, end: number, length: number): number {
  let folded = 0;
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    folded += foldInboxSearchText(text.slice(i, i + width)).length;
    i += width;
    if (folded >= length) return i;
  }
  return end;
}

/**
 * The ranges ([start, end), original offsets) where the terms occur in a
 * text: a token equal to a term, or (`prefixLast`, the default) one that
 * starts with the last term, which then marks only the typed part. Sorted,
 * never overlapping.
 */
export function inboxSearchRanges(text: string, terms: readonly string[], options: { prefixLast?: boolean; prefixAll?: boolean } = {}): [number, number][] {
  if (!text || terms.length === 0) return [];
  const prefixLast = options.prefixLast ?? true;
  const last = terms[terms.length - 1]!;
  const exact = new Set(terms);
  const out: [number, number][] = [];
  for (const t of tokenizeInboxSearchText(text)) {
    if (exact.has(t.token)) {
      out.push([t.start, t.end]);
      continue;
    }
    const prefix = options.prefixAll ? terms.find((term) => t.token.startsWith(term)) : prefixLast && t.token.startsWith(last) ? last : undefined;
    if (prefix) out.push([t.start, prefixEnd(text, t.start, t.end, prefix.length)]);
  }
  return out;
}

/** Every term occurs in the text (the last one as a prefix). */
export function inboxSearchMatchesAll(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const tokens = tokenizeInboxSearchText(text).map((t) => t.token);
  const last = terms.length - 1;
  return terms.every((term, i) => tokens.some((token) => token === term || (i === last && token.startsWith(term))));
}

// ─────────────────────────────── Snippets ───────────────────────────────

export interface InboxSearchSnippet {
  text: string;
  /** [start, length] pairs, UTF-16 offsets into `text`. */
  marks: [number, number][];
}

/** The longest unbroken run a snippet keeps whole (a URL, a hash) unless it holds a mark. */
export const INBOX_SEARCH_LONG_TOKEN = 48;
const LONG_RUN = /[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}]+/gu;

/** Grapheme starts of a text (every UTF-16 offset where a grapheme begins), plus its length. */
function graphemeStarts(text: string): number[] {
  const g = graphemes();
  if (!g) {
    const out: number[] = [];
    for (let i = 0; i < text.length; ) {
      out.push(i);
      i += text.codePointAt(i)! > 0xffff ? 2 : 1;
    }
    out.push(text.length);
    return out;
  }
  const out = [...g.segment(text)].map((s) => s.index);
  out.push(text.length);
  return out;
}

/** The last grapheme start at or before `at`. */
function snapDown(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo]!;
}

/** The first grapheme start at or after `at`. */
function snapUp(starts: readonly number[], at: number): number {
  for (const s of starts) if (s >= at) return s;
  return starts[starts.length - 1]!;
}

/**
 * A line of a longer text around its matches: from about `before`
 * characters ahead of the first match (moved forward to a word start), to a
 * word end about `after` characters past the last shown match, cut on
 * grapheme boundaries so an emoji or an accented letter is never split. An
 * ellipsis marks each cut end. An unbroken run over 48 characters that holds
 * no mark keeps its head and tail around an ellipsis; runs of Chinese,
 * Japanese, Korean, Arabic or Hebrew are never cut that way. Whitespace runs
 * read as one space.
 */
export function inboxSearchSnippet(source: string, ranges: readonly [number, number][], options: { before?: number; after?: number } = {}): InboxSearchSnippet {
  const before = options.before ?? 40;
  const after = options.after ?? 110;
  // A long text is first narrowed to a window around the matches (with room
  // to spare), so a 100 KB log costs what a paragraph does.
  const first = ranges[0]?.[0] ?? 0;
  const slack = before + after + 400;
  if (source.length > slack * 3) {
    let from = Math.max(0, first - before - 200);
    if (from > 0) {
      // Start the window after a space, so it never begins mid-word.
      while (from < first && !isSpace(source.charCodeAt(from - 1))) from++;
    }
    const reach = ranges.filter(([a]) => a < first + before + after + 40).at(-1)?.[1] ?? first;
    let to = Math.min(source.length, Math.max(reach, first) + after + 200);
    // Never end inside a surrogate pair.
    if (to < source.length && to > 0 && source.charCodeAt(to - 1) >= 0xd800 && source.charCodeAt(to - 1) <= 0xdbff) to++;
    if (from > 0 || to < source.length) {
      const inner = snippetOf(source.slice(from, to), ranges.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - from, b - from] as [number, number]), before, after, from > 0, to < source.length);
      return inner;
    }
  }
  return snippetOf(source, ranges, before, after, false, false);
}

function snippetOf(source: string, ranges: readonly [number, number][], before: number, after: number, headCut: boolean, tailCut: boolean): InboxSearchSnippet {
  // Collapse whitespace first, keeping a map back to the source offsets.
  let text = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (isSpace(source.charCodeAt(i))) {
      if (!space && text.length > 0) {
        text += ' ';
        map.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    text += ch;
    map.push(i);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  map.push(source.length);
  const toText = (offset: number): number => {
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const marks = ranges.map(([a, b]) => [toText(a), toText(b)] as [number, number]).filter(([a, b]) => b > a);
  const starts = graphemeStarts(text);
  const first = marks[0]?.[0] ?? 0;
  let start = first <= before ? 0 : snapDown(starts, first - before);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  const lastShown = marks.filter(([a]) => a < start + before + after + 40).at(-1)?.[1] ?? first;
  let end = Math.min(text.length, Math.max(lastShown, first) + after);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    // A word end close by; inside a long unbroken run (a URL) the cut stays where it is, on a grapheme.
    end = space > lastShown && end - space <= 30 ? space : snapUp(starts, end);
  }
  let out = text.slice(start, end);
  let shown = marks.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start, b - start] as [number, number]);
  const lead = start > 0 || headCut ? '…' : '';
  if (lead) shown = shown.map(([a, b]) => [a + 1, b + 1] as [number, number]);
  out = lead + out;
  // Long unbroken runs: head and tail around an ellipsis, unless a mark is in
  // them. Right to left, so a cut never moves a run still to be cut.
  const runs = [...out.matchAll(LONG_RUN)].filter((match) => {
    const runStart = match.index!;
    const runEnd = runStart + match[0].length;
    return match[0].length > INBOX_SEARCH_LONG_TOKEN && !shown.some(([a, b]) => a < runEnd && b > runStart);
  });
  for (let i = runs.length - 1; i >= 0; i--) {
    const match = runs[i]!;
    const runStart = match.index!;
    const runEnd = runStart + match[0].length;
    const runStarts = graphemeStarts(match[0]);
    const head = snapDown(runStarts, 30);
    const tail = snapUp(runStarts, match[0].length - 12);
    if (tail <= head + 1) continue;
    out = out.slice(0, runStart) + match[0].slice(0, head) + '\u2026' + match[0].slice(tail) + out.slice(runEnd);
    const removed = tail - head - 1;
    shown = shown.map(([a, b]) => (a >= runEnd ? [a - removed, b - removed] : [a, b]) as [number, number]);
  }
  const trail = end < text.length || tailCut ? '…' : '';
  return { text: out + trail, marks: shown.map(([a, b]) => [a, b - a]) };
}

/**
 * A file name too long for its line, cut in the middle so the extension and
 * the date or version at its end stay: `SPIKE-claude-…-20261012.md`. Cut by
 * grapheme. `marks` ([start, length]) follow the cut; a mark inside the cut
 * is dropped.
 */
export function middleCutInboxName(name: string, max: number, marks: readonly [number, number][] = []): { text: string; marks: [number, number][] } {
  const starts = graphemeStarts(name);
  const count = starts.length - 1;
  if (count <= max) return { text: name, marks: marks.map(([a, l]) => [a, l]) };
  const tailCount = Math.round(max * 0.45);
  const headEnd = starts[max - tailCount - 1]!;
  const tailStart = starts[count - tailCount]!;
  const text = `${name.slice(0, headEnd)}…${name.slice(tailStart)}`;
  const removed = tailStart - headEnd - 1;
  const out: [number, number][] = [];
  for (const [a, l] of marks) {
    const b = a + l;
    if (b <= headEnd) out.push([a, l]);
    else if (a >= tailStart) out.push([a - removed, l]);
  }
  return { text, marks: out };
}

// ─────────────────────────────── Wire (GET /api/inbox/search) ───────────────────────────────

export type InboxSearchGroupId = 'threads' | 'messages' | 'files' | 'projects';
export const INBOX_SEARCH_GROUPS: readonly InboxSearchGroupId[] = ['threads', 'messages', 'files', 'projects'];
/** Rows per group in a first answer (the brief's section 7). */
export const INBOX_SEARCH_CAPS: Readonly<Record<InboxSearchGroupId, number>> = { threads: 5, messages: 8, files: 5, projects: 3 };
/** The most rows one group answers at a time ('Show all', 'Show 50 more'). */
export const INBOX_SEARCH_LIMIT_MAX = 50;
/** Threads listed for filters with no words. */
export const INBOX_SEARCH_BROWSE_LIMIT = 20;
/** Threads under 'Recent' with an empty query. */
export const INBOX_SEARCH_RECENT_THREADS = 6;

export type InboxSearchStatus = 'waiting' | 'new' | 'sent' | 'quiet' | 'archived';
export const INBOX_SEARCH_STATUSES: readonly InboxSearchStatus[] = ['waiting', 'new', 'sent', 'quiet', 'archived'];
export type InboxSearchFrom = 'agent' | 'me';

export interface InboxSearchQuery {
  q: string;
  project?: string | null;
  status?: InboxSearchStatus | null;
  from?: InboxSearchFrom | null;
  /** One group only ('Show all'), from `offset`. */
  group?: InboxSearchGroupId | null;
  offset?: number;
  /** Rows per group (default: the caps, or 50 for one group). */
  limit?: number | null;
  /** The project open in the list: a tie boost, never a filter. */
  current?: string | null;
}

export interface InboxSearchProjectRef {
  id: string;
  /** The project's name, with its parent folder when two projects share one ('api · work'). */
  name: string;
}

interface RowBase {
  project: InboxSearchProjectRef;
  /** The thread's section, and whether it is archived (resolved and not come back). */
  section: InboxSectionId | null;
  archived: boolean;
  /** ISO time: a message's, or a thread's latest message's. */
  at: string;
}

export interface InboxSearchThreadRow extends RowBase {
  type: 'thread';
  id: string;
  thread_id: string;
  title: string;
  /** [start, length] in `title`. */
  title_marks: [number, number][];
  thread_name: string | null;
}

export interface InboxSearchMessageRow extends RowBase {
  type: 'message';
  id: string;
  thread_id: string;
  /**
   * Who wrote it. `host` (additive): an agent's host as the store has it
   * (`claude-code`, `codex`, ...; null when unknown), so the window draws
   * that agent's mark; null for the person. An older Inbox omits it.
   */
  author: { kind: 'agent' | 'me'; name: string; host?: string | null };
  /** The thread's subject. */
  title: string;
  /** The thread's name (`thread_name`), null for an unnamed thread. Additive. */
  thread_name?: string | null;
  snippet: InboxSearchSnippet;
  /** The match is in a question (its prompt, choices or answer): the 'Question' chip. */
  question: { key: string; replaced: boolean } | null;
}

export interface InboxSearchFileRow extends RowBase {
  type: 'file' | 'guide';
  /** An attachment's id, or for a guide the message that carries it. */
  id: string;
  thread_id: string;
  message_id: string;
  name: string;
  name_marks: [number, number][];
  /** The folder the file sits in (the last segment before its name), or null for a guide. */
  folder: string | null;
  /** The attachment's kind or the file's extension (`md`, `pdf`, `png`), or `guide`. */
  kind: string;
  /** The thread's subject. */
  title: string;
  /** The thread's name (`thread_name`), null for an unnamed thread. Additive. */
  thread_name?: string | null;
}

export interface InboxSearchProjectRow {
  type: 'project';
  id: string;
  project: InboxSearchProjectRef;
  name: string;
  name_marks: [number, number][];
  root: string;
  at: string;
}

export type InboxSearchRow = InboxSearchThreadRow | InboxSearchMessageRow | InboxSearchFileRow | InboxSearchProjectRow;

export interface InboxSearchAnswer {
  q: string;
  /** The terms searched for (the window highlights them where it lands). */
  terms: string[];
  took_ms: number;
  /** The index is still being built: no groups yet; ask again. */
  indexing: boolean;
  /** Threads the index covers (or is building over), for 'Indexing 4,212 threads…'. */
  threads: number;
  totals: Record<InboxSearchGroupId, number> | null;
  groups: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> | null;
  /** An empty query with no filters: the threads the person looked at last. */
  recent: InboxSearchThreadRow[] | null;
}
