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

test('patterns read like VS Code search: any depth unless ./, folder names, .ext, any case, backslashes', () => {
  const paths = ['root.md', 'docs/Guide.MD', 'src/a.ts', 'lib/src/b.ts', 'srcx/c.ts', 'data/file0.txt', 'data/file,.txt', 'data/file2.txt'];
  const pick = (include: string) => paths.filter(compileReviewFileFilter({ include, exclude: '' })!);
  expect(pick('*.md')).toEqual(['root.md', 'docs/Guide.MD']);
  expect(pick('.md')).toEqual(['root.md', 'docs/Guide.MD']);
  expect(pick('src')).toEqual(['src/a.ts', 'lib/src/b.ts']);
  expect(pick('src/')).toEqual(['src/a.ts', 'lib/src/b.ts']);
  expect(pick('./src')).toEqual(['src/a.ts']);
  expect(pick('/src/**')).toEqual(['src/a.ts']);
  expect(pick('lib\\src')).toEqual(['lib/src/b.ts']);
  expect(pick('data/file[0,1].txt')).toEqual(['data/file0.txt', 'data/file,.txt']);
});

test('exclusions alone start with every file and clearing restores the unfiltered path', () => {
  const matches = compileReviewFileFilter({ include: '', exclude: '**/*.md' })!;
  expect(['a.ts', 'root.md', 'docs/guide.md'].filter(matches)).toEqual(['a.ts']);
  expect(compileReviewFileFilter({ include: ' , ', exclude: '' })).toBeNull();
});
