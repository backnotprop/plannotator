/** DOM-gated coverage for compact file-row control preferences. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTreeNodeItem } from './FileTreeNode';
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
});
