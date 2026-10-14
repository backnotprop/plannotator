import { describe, expect, test } from 'bun:test';
import type { DiffFile } from '../types';
import { buildFileKindBlocks, getFileKindOrder } from './fileKindTree';
import { buildFileTree, getAllFolderPaths, getVisualFileOrder } from './buildFileTree';

const file = (path: string): DiffFile => ({ path, patch: '', additions: 1, deletions: 0, status: 'modified' });

describe('file kind tree', () => {
  const files = [file('yarn.lock'), file('src/a.test.ts'), file('src/a.ts'), file('src/b.ts')];

  test('all-files order is code, then tests, then generated, each in tree order', () => {
    expect(getFileKindOrder(files).map((i) => files[i].path)).toEqual(['src/a.ts', 'src/b.ts', 'src/a.test.ts', 'yarn.lock']);
  });

  test('a single kind keeps the plain tree order', () => {
    const code = [file('z.ts'), file('src/a.ts')];
    expect(buildFileKindBlocks(code)).toBeNull();
    expect(getFileKindOrder(code)).toEqual(getVisualFileOrder(buildFileTree(code)));
  });

  test('the same folder in two blocks has its own path; file indexes point into the full list', () => {
    const blocks = buildFileKindBlocks([file('src/x/a.ts'), file('src/y/b.ts'), file('src/x/a.test.ts'), file('src/y/b.test.ts')])!;
    const folders = blocks.flatMap((block) => getAllFolderPaths(block.tree));
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toContain('code:src');
    expect(folders).toContain('test:src');
    expect(getVisualFileOrder(blocks[1].tree)).toEqual([2, 3]);
  });

  test("the host's generated set decides the Generated block", () => {
    const blocks = buildFileKindBlocks(files, new Set(['src/b.ts']))!;
    expect(blocks.map((b) => [b.kind, b.paths])).toEqual([
      ['code', ['yarn.lock', 'src/a.ts']],
      ['test', ['src/a.test.ts']],
      ['generated', ['src/b.ts']],
    ]);
  });
});
