/**
 * Filter by typing's rule (listTitleFilter.ts): which threads a typed query keeps.
 *
 * What this catches: a match that minds case or accents; words that must come in the title's order or next to each
 * other; spaces typed around or between the words that change the answer; a thread renamed in the list that its
 * subject no longer finds (or the other way round); a linked computer's thread left out or always kept; a group whose
 * rows are not narrowed; nothing typed that still builds new sections (the list would draw again for nothing).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { filterRowsByTitle, filterSectionsByTitle, rowMatchesTitle, titleWords } from './listTitleFilter';

function row(id: string, subject: string | null, extra: Partial<InboxListRow> = {}): InboxListRow {
  return { thread_id: id, subject, thread_name: null, project: { id: 'prj_web', name: 'web' }, ...extra } as unknown as InboxListRow;
}
const keeps = (r: InboxListRow, query: string) => rowMatchesTitle(r, titleWords(query));

describe('a thread matches', () => {
  test('ignoring case and accents, either way round', () => {
    expect(keeps(row('a', 'Résumé export for Ada Novak'), 'resume')).toBe(true);
    expect(keeps(row('a', 'Resume export'), 'RÉSUMÉ')).toBe(true);
    expect(keeps(row('a', 'Invoice PDF export'), 'pdf')).toBe(true);
    expect(keeps(row('a', 'Invoice PDF export'), 'csv')).toBe(false);
  });

  test('on every word typed, in any order, spaces only separating them', () => {
    const r = row('a', 'Search results page layout');
    expect(keeps(r, 'page layout')).toBe(true);
    expect(keeps(r, '  layout   page ')).toBe(true);
    expect(keeps(r, 'pag lay')).toBe(true);
    expect(keeps(r, 'page billing')).toBe(false);
    // Nothing but spaces is nothing typed.
    expect(titleWords('   ')).toEqual([]);
    expect(keeps(r, '   ')).toBe(true);
  });

  test('on the name the list shows and on the subject its agent gave it', () => {
    const renamed = row('a', 'Retry worker on a 409', { thread_name: 'Charlie Dunn: conflicts' });
    expect(keeps(renamed, 'charlie')).toBe(true);
    expect(keeps(renamed, 'retry 409')).toBe(true);
    expect(keeps(renamed, 'bob')).toBe(false);
    // No subject at all: only the name can match.
    expect(keeps(row('b', null, { thread_name: 'Bob Tully' }), 'tully')).toBe(true);
    expect(keeps(row('c', null), 'tully')).toBe(false);
  });

  test("a linked computer's thread like this computer's", () => {
    const rows = [row('here', 'Webhook signature check'), row('there', 'Webhook retries', { machine: 'mch_other' }), row('other', 'Pricing page', { machine: 'mch_other' })];
    expect(filterRowsByTitle(rows, 'webhook').map((r) => r.thread_id)).toEqual(['here', 'there']);
  });
});

describe('the list', () => {
  const sections: InboxListSection[] = [
    { id: 'stopped', label: 'Stopped on you', threads: [row('s1', 'Trash for deleted pages'), row('s2', 'Retry worker on a 409')] },
    { id: 'new', label: 'New since you looked', threads: [row('n1', 'Page history: restore a version'), row('n2', 'Webhook signature check', { machine: 'mch_other' })] },
    { id: 'quiet', label: 'Quiet', threads: [row('q1', 'Rename the Spaces menu')] },
  ] as InboxListSection[];

  test('each group keeps its matches, in order; a group with none is left empty', () => {
    const shown = filterSectionsByTitle(sections, 'page');
    expect(shown.map((s) => [s.id, s.threads.map((r) => r.thread_id)])).toEqual([
      ['stopped', ['s1']],
      ['new', ['n1']],
      ['quiet', []],
    ]);
    // The sections given are not changed.
    expect(sections[0]!.threads).toHaveLength(2);
  });

  test('nothing typed: the same sections and rows, not copies', () => {
    expect(filterSectionsByTitle(sections, '')).toBe(sections);
    expect(filterSectionsByTitle(sections, '  ')).toBe(sections);
    const rows = sections[0]!.threads;
    expect(filterRowsByTitle(rows, '')).toBe(rows);
  });
});
