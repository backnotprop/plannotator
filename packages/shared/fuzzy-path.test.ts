/**
 * Go to File's matcher. Regressions guarded: a file name match losing to a
 * folder match, a changed file not winning a tie, a match out of order
 * accepted, and a scan of a large listing too slow to run per keystroke.
 */
import { describe, expect, test } from 'bun:test';
import { fuzzySearchPaths, scoreFuzzyPath, prepareFuzzyQuery } from './fuzzy-path';

const paths = [
  'packages/ui/utils/diffFileTree.ts',
  'packages/ui/components/DiffFileTree.tsx',
  'packages/ui/utils/diffFileTree.test.ts',
  'packages/review-editor/utils/fileKindTree.ts',
  'packages/ui/hooks/useDiffFileTreeExpansion.ts',
  'packages/review-editor/utils/buildFileTree.ts',
  'docs/tree/diff/README.md',
];

describe('fuzzySearchPaths', () => {
  test('the file name wins over the folders; every term must match in order', () => {
    expect(fuzzySearchPaths(['tree/view/a.ts', 'src/tree.ts'], 'tree')[0].path).toBe('src/tree.ts');
    const results = fuzzySearchPaths(paths, 'difftree');
    expect(results[0].path).toBe('packages/ui/utils/diffFileTree.ts');
    // The name the query covers most wins over a longer name holding it.
    const order = results.map((r) => r.path);
    expect(order.indexOf('packages/ui/components/DiffFileTree.tsx')).toBeLessThan(order.indexOf('packages/ui/hooks/useDiffFileTreeExpansion.ts'));
    expect(results.map((r) => r.path)).not.toContain('docs/tree/diff/README.md');
    expect(scoreFuzzyPath('a/b.ts', prepareFuzzyQuery('ba'))).toBeNull();
  });

  test('positions mark the matched characters', () => {
    const [first] = fuzzySearchPaths(['src/app.ts'], 'app');
    expect(first.positions).toEqual([4, 5, 6]);
  });

  test('a preferred path (a changed file) wins a tie and nothing more', () => {
    const tie = ['a/x/index.ts', 'b/x/index.ts'];
    expect(fuzzySearchPaths(tie, 'index')[0].path).toBe('a/x/index.ts');
    expect(fuzzySearchPaths(tie, 'index', { preferred: new Set(['b/x/index.ts']) })[0].path).toBe('b/x/index.ts');
    // A clearly better match still beats a preferred one.
    const gap = ['src/review.ts', 'src/r/e/v/i/e/w.ts'];
    expect(fuzzySearchPaths(gap, 'review', { preferred: new Set(['src/r/e/v/i/e/w.ts']) })[0].path).toBe('src/review.ts');
  });

  test('an empty query answers nothing; the limit holds', () => {
    expect(fuzzySearchPaths(paths, '   ')).toEqual([]);
    expect(fuzzySearchPaths(paths, 't', { limit: 2 })).toHaveLength(2);
  });

  test('200,000 paths scan fast enough to run on each keystroke', () => {
    const big: string[] = [];
    for (let i = 0; i < 200_000; i += 1) big.push(`packages/module${i % 400}/src/feature${i}/component${i % 37}.tsx`);
    const lower = big.map((p) => p.toLowerCase());
    const started = performance.now();
    const results = fuzzySearchPaths(big, 'feat123comp', { lowerPaths: lower });
    const elapsed = performance.now() - started;
    expect(results.length).toBeGreaterThan(0);
    // Measured about 40 ms on an Apple M-series laptop; generous for CI.
    expect(elapsed).toBeLessThan(1500);
  });
});
