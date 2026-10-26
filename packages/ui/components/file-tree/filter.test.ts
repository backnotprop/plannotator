/**
 * The tree's filter keeps exactly the files the sidebar FileBrowser's filter
 * keeps (its `filterFileTree` over the server's `buildFileTree`), for random
 * path lists and queries, so the new tree can take over FileBrowser's filter
 * without a user seeing a different result.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { filterFileTree, getFileTreeFilterTokens } from '../sidebar/FileBrowser';
import { buildFileTree } from '../../../shared/reference-common';
import type { VaultNode } from '../../types';
import { filterTreePaths } from './filter';

/** FileBrowser strips these from a row's name and matches on the result too. */
const stripExt = (name: string) => name.replace(/\.(mdx?|txt|html?)$/i, '');

function files(nodes: VaultNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path);
    else files(n.children ?? [], out);
  }
  return out;
}

const SEG = fc.constantFrom('docs', 'Guide.md', 'notes.txt', 'src', 'index.html', 'API', 'api', 'readme.MD', 'a b', 'x\\y', 'deep');
const PATH = fc.array(SEG, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
const QUERY = fc.oneof(
  fc.constantFrom('', ' ', 'guide', 'GUIDE', 'docs/', 'src api', 'md', 'readme', 'x\\y', 'x/y', 'a b', 'index', 'nothing'),
  fc.string({ maxLength: 4 }),
);

describe('filterTreePaths matches FileBrowser', () => {
  test('random path lists and queries keep the same files', () => {
    fc.assert(
      fc.property(fc.uniqueArray(PATH, { maxLength: 25 }), QUERY, (paths, query) => {
        // buildFileTree keeps a file and a folder of one name apart; the tree merges them. Leave those out.
        const prefixes = new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
        const clean = paths.filter((p) => !prefixes.has(p));
        const want = files(filterFileTree(buildFileTree(clean), getFileTreeFilterTokens(query))).sort();
        const got = filterTreePaths(clean, query, stripExt).sort();
        expect(got).toEqual(want);
      }),
      { numRuns: 500 },
    );
  });
});
