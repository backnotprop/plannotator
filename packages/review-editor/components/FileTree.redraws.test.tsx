/**
 * Picking a file in a long Changes tree draws two file rows (the one that was active and the one that is), not every
 * row with its context menu: the review app hands the tree new callbacks on every draw.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { drawsDuring } from '../../../tests/helpers/react-draws';
import { afterEach, expect, test } from 'bun:test';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

const hasDom = typeof document !== 'undefined';
const React = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { FileTree } = (hasDom ? await import('./FileTree') : {}) as typeof import('./FileTree');

const files: DiffFile[] = Array.from({ length: 40 }, (_, i) => ({
  path: `src/area-${i % 4}/file-${i}.ts`,
  patch: '@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 1,
  status: 'modified',
}));

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (root) await React.act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function tree(active: number, annotations: number) {
  return (
    <FileTree
      files={files}
      activeFileIndex={active}
      onSelectFile={() => {}}
      onToggleViewed={() => {}}
      annotations={Array.from({ length: annotations }, (_, i): CodeAnnotation => ({ id: `a${i}`, type: 'comment', filePath: files[3]!.path, lineStart: 1, lineEnd: 1, side: 'new', text: 'x', createdAt: 0 }))}
      viewedFiles={new Set()}
      stagedFiles={new Set()}
    />
  );
}

test.skipIf(!hasDom)('picking a file draws the old and the new active rows only', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => root!.render(tree(0, 0)));
  expect(host.querySelectorAll('.file-tree-item').length).toBe(files.length);

  const draws = await drawsDuring(() => React.act(async () => root!.render(tree(7, 0))));
  expect(draws.get('FileTreeFileRow')).toBe(2);
  expect(host.querySelector('.file-tree-item.active')?.getAttribute('title')).toBe(files[7]!.path);
});

test.skipIf(!hasDom)('a comment on one file draws that file row only', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => root!.render(tree(0, 0)));

  const draws = await drawsDuring(() => React.act(async () => root!.render(tree(0, 1))));
  expect(draws.get('FileTreeFileRow')).toBe(1);
  expect(host.querySelector(`.file-tree-item[title="${files[3]!.path}"]`)?.classList.contains('has-annotations')).toBe(true);
});
