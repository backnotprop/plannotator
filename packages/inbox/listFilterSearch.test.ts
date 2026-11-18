/**
 * The search in the list's filter menu (listFilterSearch.ts): when the field shows, and how a query narrows the rows.
 *
 * What this catches: a field on a short menu (or none on a long one); a match that misses on case or accents, or bolds
 * the wrong letters; a ticked row that goes when it does not match (it could no longer be unticked); a section with
 * nothing left that stays; a ticked-only row or section that comes before a match (Enter, which ticks the first row,
 * would untick it); a kept row counted as a match (a screen reader would hear a wrong count).
 */
import { describe, expect, test } from 'bun:test';
import { FILTER_SEARCH_AT, filterSearchShown, searchFilterSections, searchHit } from './listFilterSearch';

type Row = { label: string; on: boolean };
type Section = { id: string; rows: Row[] };
const r = (label: string, on = false): Row => ({ label, on });

const SECTIONS: Section[] = [
  { id: 'notSeen', rows: [r('Not seen', true)] },
  { id: 'updated', rows: [r('Today'), r('Last 7 days', true), r('Custom range…')] },
  { id: 'tags', rows: [r('billing-v2'), r('design')] },
  { id: 'projects', rows: [r('api'), r('Billing'), r('web', true), r('rebill')] },
];
const view = (query: string) =>
  searchFilterSections<Section, Row>(SECTIONS, query).sections.map((s) => [s.section.id, s.rows.map((x) => x.row.label)] as const);

describe('when the field shows', () => {
  test('only once a section holds more than eight rows', () => {
    expect(FILTER_SEARCH_AT).toBe(8);
    expect(filterSearchShown([1, 5, 8, 8])).toBe(false);
    expect(filterSearchShown([1, 5, 9])).toBe(true);
    expect(filterSearchShown([])).toBe(false);
  });
});

describe('a match', () => {
  test('ignores case and accents and says where it is in the label', () => {
    expect(searchHit('Billing', 'BIL')).toEqual([0, 3]);
    expect(searchHit('rebill', 'bil')).toEqual([2, 5]);
    expect(searchHit('Café menu', 'cafe')).toEqual([0, 4]);
    expect(searchHit('cafe', 'café')).toEqual([0, 4]);
    // A letter written as e plus an accent mark is still one letter of the label.
    expect(searchHit('Cafe\u0301 au lait', 'e au')).toEqual([3, 8]);
    // The mark after a matched letter stays inside the bold with it.
    expect(searchHit('Cafe\u0301 au lait', 'cafe')).toEqual([0, 5]);
    expect(searchHit('Last 7 days', '7 d')).toEqual([5, 8]);
  });

  test('other scripts, emoji and long names: the bold lands on the matched characters', () => {
    expect(searchHit('数据管道', '管道')).toEqual([2, 4]);
    expect(searchHit('ユーザー管理', 'ザー')).toEqual([2, 4]);
    expect(searchHit('لوحة-التحكم', 'التحكم')).toEqual([5, 11]);
    // An emoji is two UTF-16 units: the match after it starts after both, and an emoji itself is found whole.
    expect(searchHit('🚀 launch-pad', 'launch')).toEqual([3, 9]);
    expect(searchHit('🚀 launch-pad', '🚀')).toEqual([0, 2]);
    // A capital whose lower case is longer (İ is i plus a dot mark) still maps back to its one character.
    expect(searchHit('İstanbul ops', 'stan')).toEqual([1, 5]);
    expect(searchHit('Überwachung', 'uber')).toEqual([0, 4]);
    const long = `reports-${'x'.repeat(64)}-quarterly-review`;
    expect(searchHit(long, 'quarterly')).toEqual([long.indexOf('quarterly'), long.indexOf('quarterly') + 9]);
  });

  test('a blank query or an absent one is no match', () => {
    expect(searchHit('Billing', '')).toBeNull();
    expect(searchHit('Billing', '   ')).toBeNull();
    expect(searchHit('Billing', 'zz')).toBeNull();
  });

  test('the query is trimmed, the space inside it is kept', () => {
    expect(searchHit('Last 7 days', '  7 days ')).toEqual([5, 11]);
    expect(searchHit('Last7days', '7 days')).toBeNull();
  });
});

describe('narrowing', () => {
  test('no query: every row, every non-empty section, in order; not searching', () => {
    const all = searchFilterSections<Section, Row>([...SECTIONS, { id: 'empty', rows: [] }], '');
    expect(all.searching).toBe(false);
    expect(all.sections.map((s) => s.section.id)).toEqual(['notSeen', 'updated', 'tags', 'projects']);
    expect(all.sections.every((s) => s.rows.every((x) => x.hit === null))).toBe(true);
  });

  test('a query narrows every section at once, matches first, ticked rows kept after them, sections with only ticks last', () => {
    expect(view('bil')).toEqual([
      ['tags', ['billing-v2']],
      ['projects', ['Billing', 'rebill', 'web']],
      ['notSeen', ['Not seen']],
      ['updated', ['Last 7 days']],
    ]);
  });

  test('the first row is always a match when there is one', () => {
    for (const q of ['bil', 'web', 'day', 'a', 'custom']) {
      const first = searchFilterSections<Section, Row>(SECTIONS, q).sections[0]!.rows[0]!;
      expect(first.hit).not.toBeNull();
    }
  });

  test('the count is the matches only; a kept ticked row is not one', () => {
    const found = searchFilterSections<Section, Row>(SECTIONS, 'bil');
    expect(found.searching).toBe(true);
    expect(found.matches).toBe(3);
    const kept = found.sections.flatMap((s) => s.rows).filter((x) => x.hit === null);
    expect(kept.map((x) => x.row.label)).toEqual(['web', 'Not seen', 'Last 7 days']);
  });

  test('nothing matches: no match counted, only the ticked rows stay', () => {
    const found = searchFilterSections<Section, Row>(SECTIONS, 'zzz');
    expect(found.matches).toBe(0);
    expect(view('zzz')).toEqual([
      ['notSeen', ['Not seen']],
      ['updated', ['Last 7 days']],
      ['projects', ['web']],
    ]);
  });

  test('a ticked row that matches is a match, in its place among the matches', () => {
    expect(view('e')).toEqual([
      ['notSeen', ['Not seen']],
      ['updated', ['Custom range…', 'Last 7 days']],
      ['tags', ['design']],
      ['projects', ['web', 'rebill']],
    ]);
  });
});
