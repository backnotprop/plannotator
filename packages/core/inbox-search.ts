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
 * - Tokens: maximal runs of letters, digits and combining marks (a soft
 *   hyphen between two of them does not end the run), cut further
 *   where `Intl.Segmenter` (word granularity) puts a word boundary, so
 *   Japanese and Chinese split into words without spaces. A run of plain
 *   ASCII takes a fast path that gives the same tokens. A token under 2
 *   characters is dropped unless it is CJK.
 * - A query is at most 200 characters and 8 terms; every term must match,
 *   the last one as a prefix. Words in double quotes are an exact phrase
 *   (`parseInboxSearchQuery`): the index finds candidates, then the text
 *   confirms it with every token, one-letter ones too, inside one block
 *   (`inboxSearchPhrasesHold`).
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
const WORD_RUN = /[\p{L}\p{N}\p{M}]+(?:\u00ad+[\p{L}\p{N}\p{M}]+)*/gu;

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

function visitRun(text: string, start: number, end: number, visit: InboxSearchTokenVisitor, short: boolean): void {
  const token = foldInboxSearchText(text.slice(start, end));
  if (token.length >= 2 || (token.length > 0 && (short || CJK.test(token)))) visit(token, start, end);
}

/** A chunk with a character outside ASCII: word runs, cut where the segmenter cuts in scripts written without spaces. */
function visitRich(text: string, from: number, to: number, visit: InboxSearchTokenVisitor, short: boolean): void {
  const part = text.slice(from, to);
  const words = NO_SPACES.test(part) ? segmenter() : null;
  if (!words) {
    for (const match of part.matchAll(WORD_RUN)) visitRun(text, from + match.index!, from + match.index! + match[0].length, visit, short);
    return;
  }
  for (const segment of words.segment(part)) {
    if (!segment.isWordLike) continue;
    const base = from + segment.index;
    for (const match of segment.segment.matchAll(WORD_RUN)) visitRun(text, base + match.index!, base + match.index! + match[0].length, visit, short);
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
  scanTokens(text, ascii, other, 2);
}

/** The scan, keeping tokens of `min` characters or more (2 for the index; 1 for an exact phrase, `phraseUnitsOf`). */
function scanTokens(text: string, ascii: (start: number, end: number, upper: boolean) => void, other: InboxSearchTokenVisitor, min: number): void {
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
          if (k - start >= min) ascii(start, k, upper);
          start = -1;
        }
      }
    } else {
      visitRich(text, i, j, other, min < 2);
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
 * The quote marks that open or close a phrase: the straight one, the curly ones a phone types, and the German and
 * French ones (`„…“`, `«…»`). Each one toggles: the next one closes what it opened.
 */
const QUOTE_MARKS = /["“”„«»]/;

/** The query holds a quote mark (any of `QUOTE_MARKS`): it asks for an exact phrase, or is typing one. */
export function inboxSearchQuoted(q: string): boolean {
  return QUOTE_MARKS.test(q);
}

/** A phrase to confirm in text: its tokens as typed (folded, one-letter tokens kept), and whether its last token is a prefix (a quote not closed yet). */
export interface InboxSearchPhrase {
  tokens: string[];
  open: boolean;
}

/**
 * A query as the index reads it. Without a quote mark it is `inboxSearchTerms`
 * with the last term as a prefix, exactly as before quotes. Words in double
 * quotes are a phrase: its tokens next to each other, in order, in one block
 * of one field. A quoted word is that whole word. A quote not yet closed is a
 * phrase of what is typed so far, its last token the start of a word (so
 * results do not vanish while the person types). Empty quotes are ignored.
 * Only the query's very last token may be a prefix: a word after every
 * phrase, or the last token of a phrase left open.
 */
export interface InboxSearchParsedQuery {
  /** What the index looks up: distinct tokens in order, at most 8; with `prefixLast`, the last is a prefix (it may repeat an earlier term). */
  terms: string[];
  prefixLast: boolean;
  /** Each phrase of two index terms or more, as the index of its term at each position: the index's candidate filter. */
  phrases: number[][];
  /**
   * What the text must confirm (`inboxSearchPhrasesHold`) on the index's
   * candidates: each phrase of two tokens or more, and a quoted one-letter
   * word, with every token (one-letter ones too, which the index drops). A
   * quoted word of two letters or more needs no text: the index matches it
   * whole.
   */
  exact: InboxSearchPhrase[];
  /**
   * What an answer's `terms` carries for the marks: the words, and each phrase
   * as `"tok tok"` (closed) or `"tok tok` (open, its last token a prefix), in
   * the query's order. `inboxSearchRanges` reads these. The same as `terms`
   * for a query with no quote mark.
   */
  marks: string[];
  quoted: boolean;
}

/** A token the index keeps (`visitRun`): two characters or more, or CJK. */
const indexed = (token: string): boolean => token.length >= 2 || CJK.test(token);

/** Every token of a text, one-letter ones too, in order. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  scanTokens(text, (start, end, upper) => out.push(upper ? text.slice(start, end).toLowerCase() : text.slice(start, end)), (token) => out.push(token), 1);
  return out;
}

export function parseInboxSearchQuery(query: string): InboxSearchParsedQuery {
  const q = query.trim().slice(0, INBOX_SEARCH_QUERY_MAX);
  if (!QUOTE_MARKS.test(q)) {
    const terms = inboxSearchTerms(q);
    return { terms, prefixLast: true, phrases: [], exact: [], marks: terms, quoted: false };
  }
  // The text between quote marks, in turn outside and inside a phrase; inside, every token, one-letter ones too.
  const parts: { tokens: string[]; quoted: boolean; closed: boolean }[] = [];
  let inside = false;
  let from = 0;
  for (let i = 0; i <= q.length; i++) {
    const end = i === q.length;
    if (!end && !QUOTE_MARKS.test(q[i]!)) continue;
    const piece = q.slice(from, i);
    const tokens = inside ? wordsOf(piece) : tokenizeInboxSearchText(piece).map((t) => t.token);
    if (tokens.length > 0) parts.push({ tokens, quoted: inside, closed: !end });
    if (!end) inside = !inside;
    from = i + 1;
  }
  const lastPart = parts[parts.length - 1];
  const prefixOn = lastPart !== undefined && (!lastPart.quoted || !lastPart.closed);
  const terms: string[] = [];
  const termAt = new Map<string, number>();
  const phrases: number[][] = [];
  const exact: InboxSearchPhrase[] = [];
  const marks: string[] = [];
  let prefixLast = false;
  let full = false;
  for (let p = 0; p < parts.length && !full; p++) {
    const part = parts[p]!;
    const at: number[] = [];
    const kept: string[] = [];
    for (let k = 0; k < part.tokens.length; k++) {
      const token = part.tokens[k]!;
      const prefix = prefixOn && p === parts.length - 1 && k === part.tokens.length - 1;
      // A one-letter token in a phrase: no index term (the index never holds one), only the text confirms it.
      if (!indexed(token)) {
        kept.push(token);
        continue;
      }
      // The prefix has a term of its own, even when the same word is also wanted whole.
      const key = prefix ? `${token}*` : token;
      let index = termAt.get(key);
      if (index === undefined) {
        if (terms.length >= INBOX_SEARCH_TERMS_MAX) {
          full = true;
          break;
        }
        index = terms.length;
        terms.push(token);
        termAt.set(key, index);
      }
      if (prefix) prefixLast = true;
      at.push(index);
      kept.push(token);
      if (!part.quoted) marks.push(token);
    }
    if (!part.quoted || kept.length === 0) continue;
    // Cut by the term cap, a phrase ends on its last whole token: nothing in it is a prefix.
    const open = !full && prefixOn && p === parts.length - 1;
    if (at.length >= 2) phrases.push(at);
    if (kept.length >= 2 || at.length === 0) exact.push({ tokens: kept, open });
    marks.push(`"${kept.join(" ")}${open ? "" : '"'}`);
  }
  return { terms, prefixLast, phrases, exact, marks, quoted: true };
}

/** A phrase as `marks` writes it: its tokens, and whether its last token is a prefix (no closing quote). */
export function inboxSearchPhraseOf(mark: string): InboxSearchPhrase | null {
  if (!mark.startsWith('"')) return null;
  const open = mark.length < 2 || !mark.endsWith('"');
  const tokens = mark.slice(1, open ? undefined : -1).split(" ").filter(Boolean);
  return tokens.length > 0 ? { tokens, open } : null;
}

/**
 * A text as an exact phrase reads it, in units: every token, one-letter ones
 * too, folded as the index folds; a token holding CJK is one unit per CJK
 * character (the runs between them whole), so a quoted CJK phrase is its
 * literal characters whatever the segmenter cut. `block` counts the blank
 * lines passed: a phrase never crosses one. `start`/`end` are original
 * offsets (a CJK unit's own character when folding kept the token's length,
 * else the whole token).
 */
interface PhraseUnits {
  units: string[];
  starts: number[];
  ends: number[];
  blocks: number[];
}

/** Whether the text between two tokens holds a blank line (two line breaks with only spaces between them). */
function blankLineIn(text: string, from: number, to: number): boolean {
  let lineBreak = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      if (lineBreak) return true;
      lineBreak = true;
    } else if (!isSpace(c)) lineBreak = false;
  }
  return false;
}

function pushUnits(out: PhraseUnits, token: string, start: number, end: number, block: number): void {
  if (!CJK.test(token)) {
    out.units.push(token);
    out.starts.push(start);
    out.ends.push(end);
    out.blocks.push(block);
    return;
  }
  const sameLength = token.length === end - start;
  let run = '';
  let runAt = 0;
  const flush = (to: number) => {
    if (!run) return;
    out.units.push(run);
    out.starts.push(sameLength ? start + runAt : start);
    out.ends.push(sameLength ? start + to : end);
    out.blocks.push(block);
    run = '';
  };
  let i = 0;
  for (const ch of token) {
    if (CJK.test(ch)) {
      flush(i);
      out.units.push(ch);
      out.starts.push(sameLength ? start + i : start);
      out.ends.push(sameLength ? start + i + ch.length : end);
      out.blocks.push(block);
    } else {
      if (!run) runAt = i;
      run += ch;
    }
    i += ch.length;
  }
  flush(i);
}

function phraseUnitsOf(text: string): PhraseUnits {
  const out: PhraseUnits = { units: [], starts: [], ends: [], blocks: [] };
  let block = 0;
  let last = -1;
  const visit = (token: string, start: number, end: number) => {
    if (last >= 0 && blankLineIn(text, last, start)) block += 1;
    last = end;
    pushUnits(out, token, start, end, block);
  };
  scanTokens(text, (start, end, upper) => visit(upper ? text.slice(start, end).toLowerCase() : text.slice(start, end), start, end), visit, 1);
  return out;
}

/** A phrase's units (`PhraseUnits`' rule, on the typed tokens). */
function unitsOfPhrase(phrase: InboxSearchPhrase): string[] {
  const out: PhraseUnits = { units: [], starts: [], ends: [], blocks: [] };
  for (const token of phrase.tokens) pushUnits(out, token, 0, token.length, 0);
  return out.units;
}

/** Each place the phrase stands in the text's units: its first and last unit, in order; `first` stops at the first. */
function phraseRuns(text: PhraseUnits, want: readonly string[], open: boolean, first: boolean): [number, number][] {
  const n = want.length;
  const out: [number, number][] = [];
  if (n === 0) return out;
  const { units, blocks } = text;
  for (let at = 0; at + n <= units.length; at++) {
    let k = 0;
    for (; k < n; k++) {
      const unit = units[at + k]!;
      if (k > 0 && blocks[at + k] !== blocks[at]) break;
      if (unit === want[k] || (open && k === n - 1 && unit.startsWith(want[k]!))) continue;
      break;
    }
    if (k < n) continue;
    out.push([at, at + n - 1]);
    if (first) break;
  }
  return out;
}

/**
 * Whether every phrase stands in one of the texts: its tokens one after
 * another with only separators between them (spaces, punctuation, a single
 * line break), never across a blank line or from one text to the next; the
 * last token whole unless the phrase is open, then its start. The texts are
 * a document's fields as the index read them, each block ended by a blank
 * line (`inboxSearchBlockText` on the server).
 */
export function inboxSearchPhrasesHold(texts: readonly string[], phrases: readonly InboxSearchPhrase[]): boolean {
  if (phrases.length === 0) return true;
  const fast = phrases.map(phrasePattern);
  let wants: string[][] | null = null;
  const held = new Array<boolean>(phrases.length).fill(false);
  let left = phrases.length;
  for (const text of texts) {
    if (!text) continue;
    let units: PhraseUnits | null = null;
    for (let p = 0; p < phrases.length; p++) {
      if (held[p]) continue;
      const pattern = fast[p];
      // The pattern's yes is the rule's; its no is too unless the text holds a character that folds into a letter or
      // digit, or a script the segmenter cuts words in (it may cut a word off its neighbour).
      let holds = pattern ? pattern.test(text) : false;
      if (!holds && (!pattern || FOLDS_TO_ASCII.test(text) || NO_SPACES.test(text))) {
        wants ??= phrases.map(unitsOfPhrase);
        units ??= phraseUnitsOf(text);
        holds = phraseRuns(units, wants[p]!, phrases[p]!.open, true).length > 0;
      }
      if (!holds) continue;
      held[p] = true;
      left -= 1;
    }
    if (left === 0) return true;
  }
  return false;
}

/** A word character as the tokens read them (a soft hyphen joins two). */
const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}\\u00ad]';
/** Between two tokens of a phrase: characters that are no word character, holding no blank line. */
const PHRASE_GAP = '(?:(?!\\n\\s*\\n)[^\\p{L}\\p{N}\\p{M}\\u00ad])+';
/**
 * Characters that may fold (NFKC, case, accents, ignorables) into an ASCII
 * letter or digit, or join one: Latin-1 and Latin Extended, combining
 * marks, modifier and phonetic letters, zero-width and other ignorables,
 * super- and subscripts, letterlike and number forms, enclosed and squared
 * forms, ligatures, variation selectors, full width forms, mathematical
 * letters. Without one, a phrase of ASCII words reads the same in the raw text.
 */
const FOLDS_TO_ASCII = /[ -ͯᴀ-ỿ​-‏⁠-⁯⁰-₟℀-↏①-⓿㈀-㏿ﬀ-ﭏ︀-️︰-﹯﻿＀-￯\u{1d400}-\u{1d7ff}\u{1f100}-\u{1f1ff}\u{e0000}-\u{e0fff}]/u;
const PHRASE_PATTERNS = new WeakMap<InboxSearchPhrase, RegExp | null>();

/**
 * A phrase of ASCII words (letters and digits) as one pattern over the raw
 * text, case-insensitive: each word whole (an open phrase's last one its
 * start), only non-word characters between, never a blank line. Where it
 * matches, the tokens hold the phrase; null for a phrase with any other
 * token (CJK, Cyrillic), which reads the tokens.
 */
function phrasePattern(phrase: InboxSearchPhrase): RegExp | null {
  let pattern = PHRASE_PATTERNS.get(phrase);
  if (pattern !== undefined) return pattern;
  pattern = phrase.tokens.every((token) => /^[a-z0-9]+$/.test(token))
    ? new RegExp(`(?<!${WORD_CHAR})${phrase.tokens.join(PHRASE_GAP)}${phrase.open ? '' : `(?!${WORD_CHAR})`}`, 'iu')
    : null;
  PHRASE_PATTERNS.set(phrase, pattern);
  return pattern;
}

/** The ranges where a phrase stands in a text (`inboxSearchPhrasesHold`'s rule); an open phrase's last token marks only its typed part. */
function phraseRanges(text: string, units: PhraseUnits, phrase: InboxSearchPhrase): [number, number][] {
  const want = unitsOfPhrase(phrase);
  const lastWant = want[want.length - 1]!;
  return phraseRuns(units, want, phrase.open, false).map(([a, b]) => {
    const end = units.units[b] === lastWant ? units.ends[b]! : prefixEnd(text, units.starts[b]!, units.ends[b]!, lastWant.length);
    return [units.starts[a]!, end];
  });
}

/** The ranges for marks holding a phrase (`parseInboxSearchQuery`'s `marks`): each phrase as one run where it stands, the words as before. */
function quotedRanges(text: string, marks: readonly string[], prefixLast: boolean, prefixAll: boolean): [number, number][] {
  const words: string[] = [];
  const phrases: InboxSearchPhrase[] = [];
  for (const mark of marks) {
    const phrase = inboxSearchPhraseOf(mark);
    if (phrase) phrases.push(phrase);
    else if (!mark.startsWith('"')) words.push(mark);
  }
  const lastMark = marks[marks.length - 1]!;
  const lastWord = prefixLast && !lastMark.startsWith('"') ? lastMark : null;
  const exact = new Set(words);
  const found: [number, number][] = [];
  if (words.length > 0) {
    for (const t of tokenizeInboxSearchText(text)) {
      if (exact.has(t.token)) found.push([t.start, t.end]);
      else {
        const prefix = prefixAll ? words.find((word) => t.token.startsWith(word)) : lastWord !== null && t.token.startsWith(lastWord) ? lastWord : undefined;
        if (prefix) found.push([t.start, prefixEnd(text, t.start, t.end, prefix.length)]);
      }
    }
  }
  if (phrases.length > 0) {
    const units = phraseUnitsOf(text);
    for (const phrase of phrases) found.push(...phraseRanges(text, units, phrase));
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const range of found) {
    const prev = out[out.length - 1];
    if (prev && range[0] < prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/** How many of a query's marks (`parseInboxSearchQuery`'s `marks`: words and phrases) occur in the text, the last word as a prefix. */
export function inboxSearchMarksFound(text: string, marks: readonly string[]): number {
  const tokens = tokenizeInboxSearchText(text);
  let units: PhraseUnits | null = null;
  let count = 0;
  marks.forEach((mark, i) => {
    const phrase = inboxSearchPhraseOf(mark);
    if (phrase) {
      units ??= phraseUnitsOf(text);
      if (phraseRuns(units, unitsOfPhrase(phrase), phrase.open, true).length > 0) count += 1;
    } else if (!mark.startsWith('"') && tokens.some((t) => t.token === mark || (i === marks.length - 1 && t.token.startsWith(mark)))) count += 1;
  });
  return count;
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
 * starts with the last term, which then marks only the typed part. A term
 * that starts with a quote mark is a phrase (`parseInboxSearchQuery`'s
 * `marks`), marked as one run where its tokens stand together. Sorted,
 * never overlapping.
 */
export function inboxSearchRanges(text: string, terms: readonly string[], options: { prefixLast?: boolean; prefixAll?: boolean } = {}): [number, number][] {
  if (!text || terms.length === 0) return [];
  const prefixLast = options.prefixLast ?? true;
  if (terms.some((term) => term.startsWith('"'))) return quotedRanges(text, terms, prefixLast, options.prefixAll ?? false);
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
/**
 * The results' order (approval "inbox-search-sort"): `best` (the default) ranks by match quality, then newest;
 * `newest` lists each group by its latest message first (a thread's latest message, a message's own time).
 */
export type InboxSearchSort = 'best' | 'newest';
export const INBOX_SEARCH_SORTS: readonly InboxSearchSort[] = ['best', 'newest'];

export interface InboxSearchQuery {
  q: string;
  project?: string | null;
  status?: InboxSearchStatus | null;
  from?: InboxSearchFrom | null;
  /** Tag ids: only threads in any of them, and what is in those threads (no projects). An id this Inbox has no tag for matches nothing. */
  tags?: readonly string[] | null;
  /** One group only ('Show all'), from `offset`. */
  group?: InboxSearchGroupId | null;
  offset?: number;
  /** Rows per group (default: the caps, or 50 for one group). */
  limit?: number | null;
  /** The project open in the list: a tie boost, never a filter. */
  current?: string | null;
  /** The order: best match (default) or newest first. */
  sort?: InboxSearchSort | null;
  /** Each row's rank too (`scores`), so answers of two Inboxes merge in one order (a linked machine's agent search). */
  scores?: boolean;
}

export interface InboxSearchProjectRef {
  id: string;
  /** The project's name, with its parent folder when two projects share one ('api · work'). */
  name: string;
  machine?: string;
}

interface RowBase {
  project: InboxSearchProjectRef;
  /** The thread's section, and whether it is archived (resolved and not come back). */
  section: InboxSectionId | null;
  archived: boolean;
  /** ISO time: a message's, or a thread's latest message's. */
  at: string;
  score?: number;
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
  score?: number;
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
  /** With `scores`: each group's rows' ranks, in the rows' order (higher first). */
  scores?: Partial<Record<InboxSearchGroupId, number[]>>;
  unanswered?: { id: string; name: string }[];
}
