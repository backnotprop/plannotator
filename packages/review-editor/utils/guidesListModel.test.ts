import { describe, expect, test } from 'bun:test';
import type { SavedGuideListEntry } from '@plannotator/shared/guide';
import { groupSavedGuides, guideMismatchText, guideProgressText, newestGuideForThisDiff, resumeFile } from './guidesListModel';

const entry = (id: string, where: SavedGuideListEntry['where'], savedAt: number, extra: Partial<SavedGuideListEntry> = {}): SavedGuideListEntry => ({
  id,
  label: 'PR #12',
  title: `Guide ${id}`,
  savedAt,
  progress: { reviewed: 0, total: 4 },
  moved: where !== 'diff',
  where,
  ...extra,
});

describe('guides list grouping', () => {
  test('this diff, then this PR, then earlier, newest first inside each, empty groups dropped', () => {
    const groups = groupSavedGuides(
      [entry('a', 'other', 5), entry('b', 'diff', 1), entry('c', 'target', 2), entry('d', 'diff', 9), entry('e', undefined, 7)],
      { prMode: true },
    );
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ['This diff', ['d', 'b']],
      ['This PR', ['c']],
      ['Earlier', ['e', 'a']],
    ]);
    expect(groupSavedGuides([entry('c', 'target', 2)], { prMode: false })[0].label).toBe('This branch');
  });

  test('search matches the title or the label and keeps the grouping', () => {
    const list = [entry('a', 'diff', 1, { title: 'Auth rewrite' }), entry('b', 'other', 2, { title: 'Billing', label: 'feature/auth' })];
    const groups = groupSavedGuides(list, { prMode: true, query: ' AUTH ' });
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([['a'], ['b']]);
    expect(groupSavedGuides(list, { prMode: true, query: 'zzz' })).toEqual([]);
  });
});

describe('guide rows', () => {
  test('progress reads how far the reader got', () => {
    expect(guideProgressText({ reviewed: 3, total: 9 })).toBe('3 of 9 read');
    expect(guideProgressText({ reviewed: 0, total: 9 })).toBe('9 chapters, not started');
    expect(guideProgressText({ reviewed: 9, total: 9 })).toBe('All 9 chapters read');
  });

  test('a guide for another head of this review says it was written for an earlier version', () => {
    expect(guideMismatchText({ where: 'diff', moved: false })).toBeNull();
    expect(guideMismatchText({ where: 'target', moved: true })).toBe('Written for an earlier version of this diff');
    expect(guideMismatchText({ where: 'other', moved: true })).toBeNull();
  });

  test('resume lands on the first unread chapter whose file is still in the diff', () => {
    const sections = [{ diffs: [{ file: 'a.ts' }] }, { diffs: [{ file: 'gone.ts' }] }, { diffs: [{ file: 'gone.ts' }, { file: 'c.ts' }] }];
    const files = new Set(['a.ts', 'c.ts']);
    expect(resumeFile(sections, [true, false, false], files)).toBe('c.ts');
    expect(resumeFile(sections, [false, false, false], files)).toBeNull();
    expect(resumeFile(sections, [true, true, true], files)).toBeNull();
  });
});

describe('the Guide button', () => {
  test('opens the newest guide written for this diff, never one for another push or target', () => {
    expect(newestGuideForThisDiff([entry('old', 'diff', 1), entry('new', 'diff', 5), entry('pr', 'target', 9), entry('x', 'other', 10)])).toBe('saved:new');
    expect(newestGuideForThisDiff([entry('pr', 'target', 9), entry('x', undefined, 10)])).toBeNull();
    expect(newestGuideForThisDiff(null)).toBeNull();
  });
});
