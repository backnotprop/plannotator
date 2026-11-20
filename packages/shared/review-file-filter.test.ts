import { expect, test } from 'bun:test';
import { compileReviewFileFilter } from './review-file-filter';

test('include globs are alternatives and exclusions win', () => {
  const matches = compileReviewFileFilter({
    include: 'src/**, **/*.{md,mdx}',
    exclude: '**/*.test.ts, docs/private/**',
  })!;
  expect([
    'src/one.ts', 'src/one.test.ts', 'README.md', 'docs/help.mdx',
    'docs/private/help.mdx', 'images/icon.svg', 'docs/.draft.md',
  ].filter(matches)).toEqual(['src/one.ts', 'README.md', 'docs/help.mdx', 'docs/.draft.md']);
});

test('root globs stay at the root and bracket groups can contain commas', () => {
  const matches = compileReviewFileFilter({ include: '*.md, data/file[0,1].txt', exclude: '' })!;
  expect(['root.md', 'docs/guide.md', 'data/file0.txt', 'data/file,.txt', 'data/file2.txt'].filter(matches))
    .toEqual(['root.md', 'data/file0.txt', 'data/file,.txt']);
});

test('exclusions alone start with every file and clearing restores the unfiltered path', () => {
  const matches = compileReviewFileFilter({ include: '', exclude: '**/*.md' })!;
  expect(['a.ts', 'root.md', 'docs/guide.md'].filter(matches)).toEqual(['a.ts']);
  expect(compileReviewFileFilter({ include: ' , ', exclude: '' })).toBeNull();
});
