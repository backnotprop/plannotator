/**
 * The find fields of the list's filter menu (components/ListFilter.tsx, listFilterSections.tsx): the rule that narrows
 * one long section's rows.
 *
 * - A section (Agent, Tag, Project) gets its own field only when it has more than `FILTER_SEARCH_AT` rows. A section
 *   of eight rows or fewer is as it always was: no field, no cap.
 * - A query keeps the rows whose words contain it, ignoring case and accents, and marks where (`hit`, drawn bold).
 *   "Accents" are the Latin, Greek and Cyrillic diacritics, Arabic harakat, Hebrew points and emoji variation
 *   selectors; a mark that makes another letter (Japanese voicing marks, Indic vowel signs, Thai marks) is kept, so
 *   か never matches が. Dotless ı and final ς match i and σ.
 * - Typing narrows only that section. Its pinned rows (ticked when the field last changed) stay above its scroll
 *   whatever is typed, so a ticked row can always be unticked; the rest keep the rows that match.
 */

/** A section longer than this gets its own field and a capped, scrolling list. */
export const FILTER_SEARCH_AT = 8;

export const sectionIsLong = (size: number): boolean => size > FILTER_SEARCH_AT;

/** The marks matching ignores: Latin/Greek/Cyrillic diacritics, Arabic harakat, Hebrew points, variation selectors. */
const IGNORED_MARKS = /[\u0300-\u036F\u0483-\u0489\u0591-\u05C7\u064B-\u065F\u0670\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/gu;

/** Text as matching sees it: lower case, the ignored marks gone, ı as i, ς as σ. The list's title filter reads it too. */
export const fold = (text: string) =>
  text.normalize('NFD').toLowerCase().normalize('NFD').replace(IGNORED_MARKS, '').replace(/ı/g, 'i').replace(/ς/g, 'σ');

/** The Japanese voicing marks (dakuten, handakuten): each makes another letter of the one before it (か, が). */
const VOICING = /[\u3099\u309A]/;

/**
 * Where `query` sits in `label` (start and end in `label`'s own characters), ignoring case and accents; null: absent.
 * A match never takes a letter's base without the voicing mark that makes it another letter (か in が, or in か followed
 * by its mark). Any other mark after the match (an Indic vowel sign, a Thai mark, an accent) is drawn bold with it, so
 * typing letter by letter keeps finding the name (क finds किताब).
 */
export function searchHit(label: string, query: string): readonly [number, number] | null {
  const q = fold(query.trim());
  if (q === '') return null;
  // The folded label, and for each of its characters the original character it came from.
  let folded = '';
  const from: number[] = [];
  let at = 0;
  for (const char of label) {
    const f = fold(char);
    folded += f;
    for (let i = 0; i < f.length; i += 1) from.push(at);
    at += char.length;
  }
  for (let start = folded.indexOf(q); start >= 0; start = folded.indexOf(q, start + 1)) {
    const stop = start + q.length;
    // Not from the middle of a character's fold.
    if (start > 0 && from[start - 1] === from[start]) continue;
    // Ending inside a character's fold: only a voicing mark left out of it makes it another letter.
    if (stop < folded.length && from[stop] === from[stop - 1]) {
      let rest = '';
      for (let i = stop; i < folded.length && from[i] === from[stop - 1]; i += 1) rest += folded[i];
      if (VOICING.test(rest)) continue;
    }
    const last = from[stop - 1]!;
    let end = last + (label.codePointAt(last)! > 0xffff ? 2 : 1);
    // A mark written as its own character after the match stays inside the bold with its letter; a voicing mark there
    // means the match took only part of that letter.
    while (end < label.length && /\p{M}/u.test(label[end]!) && !VOICING.test(label[end]!)) end += 1;
    if (end < label.length && VOICING.test(label[end]!)) continue;
    return [from[start]!, end];
  }
  return null;
}

/** About as many narrow characters as a row shows before its end is cut with "…" (300 px menu, a phone's sheet). */
const ROW_FITS = 26;
/** How many narrow characters stay before a match when the label's start is dropped. */
const LEAD = 8;

/** A character drawn about twice as wide as a Latin letter: CJK, Hangul, full-width forms, emoji. */
const WIDE = /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const width = (grapheme: string) => (WIDE.test(grapheme) ? 2 : 1);

/** One grapheme splitter for every call; none where the browser has no `Intl.Segmenter` (Firefox before 125). */
let segmenter: Intl.Segmenter | null = null;
function graphemeSplitter(): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter;
}

/** Joins the code point after it into one piece (ZWJ) or belongs to the code point before it (marks, skin tones). */
const JOINS_NEXT = /^\u200D$/;
const JOINS_BEFORE = /^(?:\p{M}|[\u{1F3FB}-\u{1F3FF}]|\u200D)$/u;

/**
 * The label's graphemes, with where each starts. Without `Intl.Segmenter`: code points, a mark, a skin tone or a ZWJ
 * and what follows it kept with the code point before (a flag may still split; the cut is only drawn, never matched).
 */
function graphemes(label: string): { index: number; segment: string }[] {
  const splitter = graphemeSplitter();
  if (splitter) return [...splitter.segment(label)].map(({ index, segment }) => ({ index, segment }));
  const parts: { index: number; segment: string }[] = [];
  let at = 0;
  let joinNext = false;
  for (const point of label) {
    const last = parts[parts.length - 1];
    if (last && (joinNext || JOINS_BEFORE.test(point))) last.segment += point;
    else parts.push({ index: at, segment: point });
    joinNext = JOINS_NEXT.test(point);
    at += point.length;
  }
  return parts;
}

/**
 * Where a row's label starts when drawn: 0, or past its start when the match would sit in the part the row cuts off
 * (an 80-character project name matched near its end), so the bold always shows. Always on a grapheme's edge (never
 * inside a flag, a skin tone, a family emoji or a letter and its accent); wide characters count twice.
 */
export function labelStart(label: string, hit: readonly [number, number] | null): number {
  if (!hit) return 0;
  // Most names fit: counted by code points (never less than by graphemes), the part up to the match's end fits.
  let most = 0;
  for (const point of label.slice(0, hit[1])) most += width(point);
  if (most <= ROW_FITS) return 0;
  const parts = graphemes(label);
  let upToHit = 0;
  for (const part of parts) if (part.index < hit[1]) upToHit += width(part.segment);
  if (upToHit <= ROW_FITS) return 0;
  // Back from the match, whole graphemes, until LEAD narrow characters' width is kept.
  let at = parts.findIndex((part) => part.index + part.segment.length > hit[0]);
  let kept = 0;
  while (at > 0 && kept + width(parts[at - 1]!.segment) <= LEAD) {
    at -= 1;
    kept += width(parts[at]!.segment);
  }
  return parts[at]!.index;
}

export interface FilterSearchRow<R> {
  row: R;
  /** The match in the row's label; null: no query, or a pinned row the query does not match. */
  hit: readonly [number, number] | null;
}

export interface SectionFind<R> {
  /** The rows kept above the section's scroll: those ticked when its field last changed (or the menu opened). */
  pinned: FilterSearchRow<R>[];
  /** The rest, narrowed by the query, in their order. */
  rows: FilterSearchRow<R>[];
  /** Rows of the section that match the query, pinned ones included; every row with no query. */
  matches: number;
  /** A query is typed (blank does not count). */
  searching: boolean;
}

/**
 * One long section narrowed by its own field's query. Pinned rows stay whatever the query, so a ticked row can always
 * be unticked; the rest keep only the rows whose words hold the query. Nothing else in the menu is read.
 */
export function findInSection<R extends { key: string; label: string }>(rows: readonly R[], query: string, pinnedKeys: ReadonlySet<string>): SectionFind<R> {
  const searching = query.trim() !== '';
  const pinned: FilterSearchRow<R>[] = [];
  const rest: FilterSearchRow<R>[] = [];
  let matches = 0;
  for (const row of rows) {
    const hit = searching ? searchHit(row.label, query) : null;
    if (!searching || hit) matches += 1;
    if (pinnedKeys.has(row.key)) pinned.push({ row, hit });
    else if (!searching || hit) rest.push({ row, hit });
  }
  return { pinned, rows: rest, matches, searching };
}
