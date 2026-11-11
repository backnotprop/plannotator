import { describe, expect, test } from 'bun:test';
import { filesViewedByTickingSection } from './guideReviewedViewed';

const section = (...files: string[]) => ({ title: 't', overview: '', diffs: files.map((file) => ({ file })) });
const inDiff = new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

describe('filesViewedByTickingSection (#1786)', () => {
  test('ticking a section marks the files only it shows', () => {
    const sections = [section('a.ts', 'b.ts'), section('c.ts')];
    expect(filesViewedByTickingSection(sections, [false, false], 0, inDiff)).toEqual(['a.ts', 'b.ts']);
  });

  test('a file split across chapters waits for its last chapter to be ticked', () => {
    const sections = [section('a.ts', 'b.ts'), section('b.ts', 'c.ts'), section('b.ts')];
    expect(filesViewedByTickingSection(sections, [false, false, false], 0, inDiff)).toEqual(['a.ts']);
    expect(filesViewedByTickingSection(sections, [true, false, false], 1, inDiff)).toEqual(['c.ts']);
    expect(filesViewedByTickingSection(sections, [true, true, false], 2, inDiff)).toEqual(['b.ts']);
    expect(filesViewedByTickingSection(sections, [false, true, true], 0, inDiff)).toEqual(['a.ts', 'b.ts']);
  });

  test('un-ticking marks nothing (viewed marks are left as they are)', () => {
    const sections = [section('a.ts'), section('b.ts')];
    expect(filesViewedByTickingSection(sections, [true, false], 0, inDiff)).toEqual([]);
  });

  test('stale refs, duplicates, prose-only sections and bad indexes', () => {
    const sections = [section('a.ts', 'gone.ts', 'a.ts'), { title: 'prose', overview: 'x', diffs: [] }];
    expect(filesViewedByTickingSection(sections, [false, false], 0, inDiff)).toEqual(['a.ts']);
    expect(filesViewedByTickingSection(sections, [false, false], 1, inDiff)).toEqual([]);
    expect(filesViewedByTickingSection(sections, [false, false], 5, inDiff)).toEqual([]);
  });
});
