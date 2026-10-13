import { describe, expect, test } from 'bun:test';
import {
  buildDiffFileTree,
  getAllFolderPaths,
  getAncestorPaths,
  getVisualFileOrder,
  type DiffFileTreeFile,
  type DiffFileTreeNode,
} from './diffFileTree';

const f = (path: string, overrides: Partial<DiffFileTreeFile> = {}): DiffFileTreeFile => ({
  path,
  status: 'modified',
  additions: 0,
  deletions: 0,
  ...overrides,
});

/** Compact "depth:type:name" outline so a shape regression shows as one diff. */
function outline(nodes: DiffFileTreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(`${n.depth}:${n.type === 'folder' ? 'd' : 'f'}:${n.name}`);
    if (n.children) outline(n.children, out);
  }
  return out;
}

describe('buildDiffFileTree', () => {
  test('merges single-child folder chains at every level and fixes depths', () => {
    const tree = buildDiffFileTree([
      f('packages/app/src/components/deep/nested/Widget.tsx'),
      f('packages/app/src/components/Button.tsx'),
      f('packages/app/src/index.ts'),
      f('README.md'),
    ]);
    expect(outline(tree)).toEqual([
      '0:d:packages/app/src',
      '1:d:components',
      '2:d:deep/nested',
      '3:f:Widget.tsx',
      '2:f:Button.tsx',
      '1:f:index.ts',
      '0:f:README.md',
    ]);
    // A merged folder keeps its full path, which is what expansion state keys on.
    expect(tree[0].path).toBe('packages/app/src');
    expect(tree[0].children![0].children![0].path).toBe('packages/app/src/components/deep/nested');
  });

  test('folders sort before files, each group by name', () => {
    const tree = buildDiffFileTree([f('z.ts'), f('b/x.ts'), f('a.ts'), f('a/y.ts'), f('b/w.ts')]);
    expect(outline(tree)).toEqual(['0:d:a', '1:f:y.ts', '0:d:b', '1:f:w.ts', '1:f:x.ts', '0:f:a.ts', '0:f:z.ts']);
  });

  test('unwraps a lone root folder that holds only files', () => {
    expect(outline(buildDiffFileTree([f('src/lib/a.ts'), f('src/lib/b.ts')]))).toEqual(['0:f:a.ts', '0:f:b.ts']);
    // ...but not when that folder also holds a folder.
    expect(outline(buildDiffFileTree([f('src/a.ts'), f('src/sub/b.ts')]))).toEqual([
      '0:d:src',
      '1:d:sub',
      '2:f:b.ts',
      '1:f:a.ts',
    ]);
  });

  test('folder counts sum every file beneath them', () => {
    const tree = buildDiffFileTree([
      f('a/b/one.ts', { additions: 3, deletions: 1 }),
      f('a/two.ts', { additions: 2, deletions: 4 }),
      f('c.ts', { additions: 7 }),
    ]);
    const a = tree.find((n) => n.name === 'a')!;
    expect([a.additions, a.deletions]).toEqual([5, 5]);
    expect([a.children![0].additions, a.children![0].deletions]).toEqual([3, 1]);
  });

  test('file nodes carry the caller object and its input index', () => {
    const files = [f('b.ts', { status: 'binary' }), f('a.ts', { status: 'renamed', oldPath: 'old.ts' })];
    const tree = buildDiffFileTree(files);
    expect(tree.map((n) => [n.name, n.fileIndex])).toEqual([['a.ts', 1], ['b.ts', 0]]);
    expect(tree[0].file).toBe(files[1]);
    expect(getVisualFileOrder(tree)).toEqual([1, 0]);
  });

  test('empty input is an empty tree', () => {
    expect(buildDiffFileTree([])).toEqual([]);
  });
});

describe('tree helpers', () => {
  test('ancestor paths cover merged folder paths, so expanding them reveals a file', () => {
    const tree = buildDiffFileTree([f('x/y/z/file.ts'), f('x/other.ts')]);
    const folders = getAllFolderPaths(tree);
    const ancestors = new Set(getAncestorPaths('x/y/z/file.ts'));
    for (const folder of folders) expect(ancestors.has(folder)).toBe(true);
  });
});
