/**
 * The tree's filter shows exactly the files the sidebar FileBrowser's filter
 * keeps (its `filterFileTree` over the server's `buildFileTree`), for random
 * path lists and queries, so the new tree can take over FileBrowser's filter
 * without a user seeing a different result. Also: a live add under a filter
 * is incremental and opens the new match's folders, and typing a filter is
 * one pass, fast enough to need no debounce.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { filterFileTree, getFileTreeFilterTokens } from '../sidebar/FileBrowser';
import { buildFileTree } from '../../../shared/reference-common';
import type { VaultNode } from '../../types';
import { FileTreeStore } from './store';

function files(nodes: VaultNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path);
    else files(n.children ?? [], out);
  }
  return out;
}

function shownFiles(store: FileTreeStore): string[] {
  const m = store.model;
  return m
    .rows(0, m.rowCount)
    .filter((r) => !r.isDir)
    .map((r) => m.pathOf(r.id));
}

const SEG = fc.constantFrom('docs', 'Guide.md', 'notes.txt', 'src', 'index.html', 'API', 'api', 'readme.MD', 'a b', 'x\\y', 'deep');
const PATH = fc.array(SEG, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
const QUERY = fc.oneof(
  fc.constantFrom('', ' ', 'guide', 'GUIDE', 'docs/', 'src api', 'md', 'readme', 'x\\y', 'x/y', 'a b', 'index', 'nothing'),
  fc.string({ maxLength: 4 }),
);

describe('the filter matches FileBrowser', () => {
  test('random path lists and queries show the same files', () => {
    fc.assert(
      fc.property(fc.uniqueArray(PATH, { maxLength: 25 }), QUERY, (paths, query) => {
        // buildFileTree keeps a file and a folder of one name apart; the tree merges them. Leave those out.
        const prefixes = new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
        const clean = paths.filter((p) => !prefixes.has(p));
        const want = files(filterFileTree(buildFileTree(clean), getFileTreeFilterTokens(query))).sort();
        const store = new FileTreeStore(clean);
        store.setFilter(query);
        // An empty query is no filter: open everything to list every file.
        if (!store.model.filtered) store.expandAll();
        expect(shownFiles(store).sort()).toEqual(want);
      }),
      { numRuns: 500 },
    );
  });
});

describe('the filter on a large tree', () => {
  const big = Array.from({ length: 150_000 }, (_, i) => `pkg${i % 40}/src/mod${i % 300}/file-${i}.ts`);

  test('a live add under a filter is incremental and opens the new match', () => {
    const store = new FileTreeStore(big);
    store.setFilter('file-149999');
    expect(shownFiles(store)).toEqual(['pkg39/src/mod299/file-149999.ts']);
    store.collapse('pkg39');
    const t0 = performance.now();
    store.add('pkg39/src/mod1/file-1499990.ts');
    const ms = performance.now() - t0;
    expect(shownFiles(store)).toEqual(['pkg39/src/mod1/file-1499990.ts', 'pkg39/src/mod299/file-149999.ts']);
    expect(store.isExpanded('pkg39')).toBe(true);
    // A rebuild of 150k paths is ~100 ms; an incremental add is well under one.
    expect(ms).toBeLessThan(20);
  });

  test('each keystroke of a filter is one pass, under a frame after the first', () => {
    const store = new FileTreeStore(big);
    store.setFilter('f');
    const times: number[] = [];
    for (const q of ['fi', 'fil', 'file', 'file-1', 'file-12', 'file-123']) {
      const t0 = performance.now();
      store.setFilter(q);
      times.push(performance.now() - t0);
    }
    expect(shownFiles(store).every((p) => p.includes('file-123'))).toBe(true);
    expect(Math.max(...times)).toBeLessThan(40);
  });
});
