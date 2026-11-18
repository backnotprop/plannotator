/**
 * The search at the top of the list's filter menu (components/ListFilter.tsx): the rule that narrows the menu's rows.
 *
 * - The field shows only when a section of the menu has more than `FILTER_SEARCH_AT` rows. With short lists the menu
 *   is as it always was: no field.
 * - A query keeps the rows whose words contain it, ignoring case and accents, and marks where (`hit`, drawn bold).
 *   "Accents" are the Latin, Greek and Cyrillic diacritics, Arabic harakat, Hebrew points and emoji variation
 *   selectors; a mark that makes another letter (Japanese voicing marks, Indic vowel signs, Thai marks) is kept, so
 *   か never matches が. Dotless ı and final ς match i and σ.
 * - A ticked row always stays, so it can be unticked, after the matches of its section.
 * - A section with nothing left goes. Sections with a match come first, in their usual order, then the sections that
 *   only hold ticked rows: when anything matches, the menu's first row is a match, so "type, Enter" acts on a row the
 *   person typed. That row may itself be ticked, and Enter then unticks it like any other; a row kept only because it
 *   is ticked is never first while something matches, and with nothing matching nothing is highlighted
 *   (ListFilter.tsx).
 */

/** A section longer than this shows the field. */
export const FILTER_SEARCH_AT = 8;

export const filterSearchShown = (sizes: readonly number[]): boolean => sizes.some((size) => size > FILTER_SEARCH_AT);

/** The marks matching ignores: Latin/Greek/Cyrillic diacritics, Arabic harakat, Hebrew points, variation selectors. */
const IGNORED_MARKS = /[\u0300-\u036F\u0483-\u0489\u0591-\u05C7\u064B-\u065F\u0670\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/gu;
const ignored = (char: string) => char.replace(IGNORED_MARKS, '') === '';

/** Text as matching sees it: lower case, the ignored marks gone, ı as i, ς as σ. */
const fold = (text: string) =>
  text.normalize('NFD').toLowerCase().normalize('NFD').replace(IGNORED_MARKS, '').replace(/ı/g, 'i').replace(/ς/g, 'σ');

/**
 * Where `query` sits in `label` (start and end in `label`'s own characters), ignoring case and accents; null: absent.
 * A match starts and ends on whole characters: it never takes a letter's base without the mark that makes it another
 * letter (か in が, or in か followed by its voicing mark).
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
    // Both ends on a character's edge in the folded text.
    if (start > 0 && from[start - 1] === from[start]) continue;
    if (stop < folded.length && from[stop] === from[stop - 1]) continue;
    const last = from[stop - 1]!;
    let end = last + (label.codePointAt(last)! > 0xffff ? 2 : 1);
    // A mark written as its own character after the match: an ignored one stays inside the bold with its letter; one
    // that makes another letter means the match took only part of that letter.
    while (end < label.length && /\p{M}/u.test(label[end]!) && ignored(label[end]!)) end += 1;
    if (end < label.length && /\p{M}/u.test(label[end]!)) continue;
    return [from[start]!, end];
  }
  return null;
}

/** About as many narrow characters as a row shows before its end is cut with "…" (300 px menu, a phone's sheet). */
const ROW_FITS = 26;
/** How many narrow characters stay before a match when the label's start is dropped. */
const LEAD = 8;

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
/** A character drawn about twice as wide as a Latin letter: CJK, Hangul, full-width forms, emoji. */
const WIDE = /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const width = (grapheme: string) => (WIDE.test(grapheme) ? 2 : 1);

/**
 * Where a row's label starts when drawn: 0, or past its start when the match would sit in the part the row cuts off
 * (an 80-character project name matched near its end), so the bold always shows. Always on a grapheme's edge (never
 * inside a flag, a skin tone, a family emoji or a letter and its accent); wide characters count twice.
 */
export function labelStart(label: string, hit: readonly [number, number] | null): number {
  if (!hit) return 0;
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
  /** The match in the row's label; null: kept because it is ticked, or no query. */
  hit: readonly [number, number] | null;
}

export interface FilterSearchResult<S, R> {
  sections: { section: S; rows: FilterSearchRow<R>[] }[];
  /** Rows that match the query (ticked rows kept without a match do not count); every row with no query. */
  matches: number;
  /** A query is typed (blank does not count). */
  searching: boolean;
}

/** The menu's sections narrowed by `query`. */
export function searchFilterSections<S extends { rows: readonly R[] }, R extends { label: string; on: boolean }>(
  sections: readonly S[],
  query: string,
): FilterSearchResult<S, R> {
  if (query.trim() === '') {
    const all = sections.filter((s) => s.rows.length > 0).map((section) => ({ section, rows: section.rows.map((row) => ({ row, hit: null })) }));
    return { sections: all, matches: all.reduce((n, s) => n + s.rows.length, 0), searching: false };
  }
  const withHits: FilterSearchResult<S, R>['sections'] = [];
  const keptOnly: FilterSearchResult<S, R>['sections'] = [];
  let matches = 0;
  for (const section of sections) {
    const hits: FilterSearchRow<R>[] = [];
    const kept: FilterSearchRow<R>[] = [];
    for (const row of section.rows) {
      const hit = searchHit(row.label, query);
      if (hit) hits.push({ row, hit });
      else if (row.on) kept.push({ row, hit: null });
    }
    matches += hits.length;
    if (hits.length > 0) withHits.push({ section, rows: [...hits, ...kept] });
    else if (kept.length > 0) keptOnly.push({ section, rows: kept });
  }
  return { sections: [...withHits, ...keptOnly], matches, searching: true };
}
