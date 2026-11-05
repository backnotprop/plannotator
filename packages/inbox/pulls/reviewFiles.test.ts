import { describe, expect, test } from 'bun:test';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { COLLIDING_PATHS_DIFF } from '../../../tests/helpers/colliding-paths-diff';
import { reviewFiles } from './reviewFiles';

describe('reviewFiles', () => {
  const parsed = parseDiffToFiles(COLLIDING_PATHS_DIFF);

  test('a file the tree has no row for stays in the review, after the tree', () => {
    const { files, loose, tree } = reviewFiles(COLLIDING_PATHS_DIFF);
    expect(files.length).toBe(parsed.length);
    expect(files.map((file) => file.path).sort()).toEqual(parsed.map((file) => file.path).sort());
    expect(loose.map((file) => file.path).sort()).toEqual(['a-link', 'docs/guide/intro.md', 'docs/index.md']);
    expect(files.slice(-loose.length)).toEqual(loose);
    // The folder comes first in the tree, though git has the root files ahead of it.
    expect(tree[0]).toMatchObject({ type: 'folder', path: 'src' });
    expect(files[0]!.path.startsWith('src/')).toBe(true);
    expect(parsed[0]!.path).toBe('README.md');
  });

  test('the rebuilt diff holds every file, each path where the rail first has it', () => {
    const { files, patch } = reviewFiles(COLLIDING_PATHS_DIFF);
    const rebuilt = parseDiffToFiles(patch);
    expect(rebuilt.length).toBe(parsed.length);
    expect([...new Set(rebuilt.map((file) => file.path))]).toEqual([...new Set(files.map((file) => file.path))]);
  });

  test('a path\'s two halves keep git\'s order, so the viewer, which draws a path\'s last, draws the new file', () => {
    const halves = parseDiffToFiles(reviewFiles(COLLIDING_PATHS_DIFF).patch).filter((file) => file.path === 'a-link');
    expect(halves.map((file) => file.status)).toEqual(['deleted', 'added']);
  });

  test('nothing lost when the tree places every file, and an empty diff is empty', () => {
    const one = 'diff --git a/a.ts b/a.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a\n';
    expect(reviewFiles(one).loose).toEqual([]);
    expect(reviewFiles(one).files.length).toBe(1);
    expect(reviewFiles('')).toMatchObject({ files: [], loose: [], patch: '' });
  });
});
