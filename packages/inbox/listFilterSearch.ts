/**
 * The search at the top of the list's filter menu (components/ListFilter.tsx): the rule that narrows the menu's rows.
 *
 * - The field shows only when a section has more than `FILTER_SEARCH_AT` rows (40 projects, 25 tags). With short lists
 *   the menu is as it always was: no field.
 * - A query keeps the rows whose words contain it, ignoring case and accents, and marks where (`hit`, drawn bold).
 * - A ticked row always stays, so it can be unticked, after the matches of its section.
 * - A section with nothing left goes. Sections with a match come first, in their usual order, then the sections that
 *   only hold ticked rows: the menu's first row is always a match, so "type, Enter" ticks a match and never unticks.
 */

/** A section longer than this shows the field. */
export const FILTER_SEARCH_AT = 8;

export const filterSearchShown = (sizes: readonly number[]): boolean => sizes.some((size) => size > FILTER_SEARCH_AT);

/** One character as matching sees it: no accents, lower case. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Where `query` sits in `label` (start and end in `label`'s own characters), ignoring case and accents; null: absent. */
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
  const start = folded.indexOf(q);
  if (start < 0) return null;
  const last = from[start + q.length - 1]!;
  let end = last + (label.codePointAt(last)! > 0xffff ? 2 : 1);
  // An accent written as its own mark after the letter stays with the letter, inside the bold.
  while (end < label.length && /\p{M}/u.test(label[end]!)) end += 1;
  return [from[start]!, end];
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
