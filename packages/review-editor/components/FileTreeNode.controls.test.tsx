/** DOM-gated coverage for compact file-row control preferences. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTreeNodeItem, alignedTreeIndent, maxTreeIndent } from './FileTreeNode';
import type { FileTreeNode } from '../utils/buildFileTree';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const node: FileTreeNode = {
  type: 'file',
  name: 'example.ts',
  path: 'src/example.ts',
  depth: 0,
  fileIndex: 0,
  additions: 2,
  deletions: 1,
  file: {
    path: 'src/example.ts',
    patch: '',
    additions: 2,
    deletions: 1,
    status: 'modified',
  },
};

function Row({ compact }: { compact: boolean }) {
  return (
    <FileTreeNodeItem
      node={node}
      expandedFolders={new Set()}
      onToggleFolder={() => {}}
      activeFileIndex={0}
      onSelectFile={() => {}}
      viewedFiles={new Set()}
      onToggleViewed={() => {}}
      showViewedControls={!compact}
      hideViewedFiles={false}
      getAnnotationCount={() => 0}
      stagedFiles={new Set()}
      getSectionEntry={() => ({ group: 'changes', staged: false })}
      onStageFile={() => {}}
      showStageControls={!compact}
    />
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('FileTreeNodeItem compact controls', () => {
  test.skipIf(!hasDom)('removes viewed and Git add controls without removing the file row', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(<Row compact={false} />));
    expect(host.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Stage file"]')).not.toBeNull();

    await act(async () => root?.render(<Row compact />));
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    expect(host.querySelector('[aria-label="Stage file"]')).toBeNull();
    expect(host.textContent).toContain('example.ts');
  });

  test.skipIf(!hasDom)('a cut name keeps its full path on hover', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Row compact={false} />));
    expect(host.querySelector('.file-tree-item')?.getAttribute('title')).toBe('src/example.ts');
  });
});

describe('the Changes tree indent', () => {
  test('12 px a level from the 8 px row edge, so a level lines its chevron up with the label above', () => {
    expect([0, 1, 2].map((depth) => alignedTreeIndent(depth))).toEqual([8, 20, 32]);
  });

  test('every deeper level sits strictly further right, at any width', () => {
    for (const width of [160, 200, 256, 400]) {
      const cap = maxTreeIndent(width);
      for (let depth = 0; depth < 12; depth += 1) {
        // A child never lines up with its parent's siblings.
        expect(alignedTreeIndent(depth + 1, cap)).toBeGreaterThan(alignedTreeIndent(depth, cap));
      }
    }
  });

  test('a deep tree steps less past the cap, so names keep room', () => {
    const cap = maxTreeIndent(256);
    // Full 12 px steps up to the cap (56 px at 256: four levels), then 4 px.
    expect(alignedTreeIndent(4, cap)).toBe(8 + 48);
    expect(alignedTreeIndent(5, cap)).toBe(8 + 48 + 4);
    expect(alignedTreeIndent(9, cap) - alignedTreeIndent(8, cap)).toBe(4);
    // A wide panel keeps the full step deeper.
    expect(alignedTreeIndent(9, maxTreeIndent(400))).toBe(8 + 108);
  });
});
