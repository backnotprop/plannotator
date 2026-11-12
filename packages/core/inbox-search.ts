import type { InboxSectionId } from './inbox-types';

export const INBOX_SEARCH_QUERY_MAX = 200;
export const INBOX_SEARCH_TERMS_MAX = 8;

export interface InboxSearchToken {
  token: string;
  start: number;
  end: number;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const ACCENTS = /[̀-ͯ]/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
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

export function foldInboxSearchText(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  return text.normalize('NFKC').replace(IGNORABLE, '').toUpperCase().toLowerCase().normalize('NFD').replace(ACCENTS, '').normalize('NFC');
}

export function isCjkToken(token: string): boolean {
  return CJK.test(token);
}

export type InboxSearchTokenVisitor = (token: string, start: number, end: number) => void;

function visitRun(text: string, start: number, end: number, visit: InboxSearchTokenVisitor): void {
  const token = foldInboxSearchText(text.slice(start, end));
  if (token.length >= 2 || (token.length > 0 && CJK.test(token))) visit(token, start, end);
}

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

function isSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0x85) return false;
  return c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

export function forEachInboxSearchToken(text: string, visit: InboxSearchTokenVisitor): void {
  scanInboxSearchTokens(text, (start, end, upper) => {
    const raw = text.slice(start, end);
    visit(upper ? raw.toLowerCase() : raw, start, end);
  }, visit);
}

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

export function tokenizeInboxSearchText(text: string): InboxSearchToken[] {
  const out: InboxSearchToken[] = [];
  if (text) forEachInboxSearchToken(text, (token, start, end) => out.push({ token, start, end }));
  return out;
}

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

export function inboxSearchMatchesAll(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const tokens = tokenizeInboxSearchText(text).map((t) => t.token);
  const last = terms.length - 1;
  return terms.every((term, i) => tokens.some((token) => token === term || (i === last && token.startsWith(term))));
}

export interface InboxSearchSnippet {
  text: string;
  marks: [number, number][];
}

export const INBOX_SEARCH_LONG_TOKEN = 48;
const LONG_RUN = /[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}]+/gu;

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

function snapUp(starts: readonly number[], at: number): number {
  for (const s of starts) if (s >= at) return s;
  return starts[starts.length - 1]!;
}

export function inboxSearchSnippet(source: string, ranges: readonly [number, number][], options: { before?: number; after?: number } = {}): InboxSearchSnippet {
  const before = options.before ?? 40;
  const after = options.after ?? 110;
  const first = ranges[0]?.[0] ?? 0;
  const slack = before + after + 400;
  if (source.length > slack * 3) {
    let from = Math.max(0, first - before - 200);
    if (from > 0) {
      while (from < first && !isSpace(source.charCodeAt(from - 1))) from++;
    }
    const reach = ranges.filter(([a]) => a < first + before + after + 40).at(-1)?.[1] ?? first;
    let to = Math.min(source.length, Math.max(reach, first) + after + 200);
    if (to < source.length && to > 0 && source.charCodeAt(to - 1) >= 0xd800 && source.charCodeAt(to - 1) <= 0xdbff) to++;
    if (from > 0 || to < source.length) {
      const inner = snippetOf(source.slice(from, to), ranges.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - from, b - from] as [number, number]), before, after, from > 0, to < source.length);
      return inner;
    }
  }
  return snippetOf(source, ranges, before, after, false, false);
}

function snippetOf(source: string, ranges: readonly [number, number][], before: number, after: number, headCut: boolean, tailCut: boolean): InboxSearchSnippet {
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
    end = space > lastShown && end - space <= 30 ? space : snapUp(starts, end);
  }
  let out = text.slice(start, end);
  let shown = marks.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start, b - start] as [number, number]);
  const lead = start > 0 || headCut ? '…' : '';
  if (lead) shown = shown.map(([a, b]) => [a + 1, b + 1] as [number, number]);
  out = lead + out;
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

export type InboxSearchGroupId = 'threads' | 'messages' | 'files' | 'projects';
export const INBOX_SEARCH_GROUPS: readonly InboxSearchGroupId[] = ['threads', 'messages', 'files', 'projects'];
export const INBOX_SEARCH_CAPS: Readonly<Record<InboxSearchGroupId, number>> = { threads: 5, messages: 8, files: 5, projects: 3 };
export const INBOX_SEARCH_LIMIT_MAX = 50;
export const INBOX_SEARCH_BROWSE_LIMIT = 20;
export const INBOX_SEARCH_RECENT_THREADS = 6;

export type InboxSearchStatus = 'waiting' | 'new' | 'sent' | 'quiet' | 'archived';
export const INBOX_SEARCH_STATUSES: readonly InboxSearchStatus[] = ['waiting', 'new', 'sent', 'quiet', 'archived'];
export type InboxSearchFrom = 'agent' | 'me';
export type InboxSearchSort = 'best' | 'newest';
export const INBOX_SEARCH_SORTS: readonly InboxSearchSort[] = ['best', 'newest'];

export interface InboxSearchQuery {
  q: string;
  project?: string | null;
  status?: InboxSearchStatus | null;
  from?: InboxSearchFrom | null;
  group?: InboxSearchGroupId | null;
  offset?: number;
  limit?: number | null;
  current?: string | null;
  sort?: InboxSearchSort | null;
}

export interface InboxSearchProjectRef {
  id: string;
  name: string;
}

interface RowBase {
  project: InboxSearchProjectRef;
  section: InboxSectionId | null;
  archived: boolean;
  at: string;
}

export interface InboxSearchThreadRow extends RowBase {
  type: 'thread';
  id: string;
  thread_id: string;
  title: string;
  title_marks: [number, number][];
  thread_name: string | null;
}

export interface InboxSearchMessageRow extends RowBase {
  type: 'message';
  id: string;
  thread_id: string;
  author: { kind: 'agent' | 'me'; name: string; host?: string | null };
  title: string;
  thread_name?: string | null;
  snippet: InboxSearchSnippet;
  question: { key: string; replaced: boolean } | null;
}

export interface InboxSearchFileRow extends RowBase {
  type: 'file' | 'guide';
  id: string;
  thread_id: string;
  message_id: string;
  name: string;
  name_marks: [number, number][];
  folder: string | null;
  kind: string;
  title: string;
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
  terms: string[];
  took_ms: number;
  indexing: boolean;
  threads: number;
  totals: Record<InboxSearchGroupId, number> | null;
  groups: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> | null;
  recent: InboxSearchThreadRow[] | null;
}
