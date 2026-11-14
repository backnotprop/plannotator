/**
 * DOM coverage for the tree's All files list (approved design record
 * "review-explorer", step 1) and the header the tree draws above it (the
 * header itself is covered by ReviewPanelHeader.test.tsx).
 *
 * Regressions guarded:
 *  - All files losing the changed files' own rows (viewed circle, letter,
 *    +/-), or a changed file the new side deletes dropping out of the tree;
 *  - folders opening anything but the paths that lead to changes;
 *  - the list rendering every row of a big repository (it must be virtual);
 *  - a lazy listing never asking for a folder that is opened;
 *  - files changed on disk since the snapshot showing no mark.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import type { DiffFile } from '../types';
import type { RepoFiles, RepoFilesState } from '../hooks/useRepoFiles';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const file = (path: string, status: DiffFile['status'] = 'modified', additions = 2): DiffFile => ({
  path,
  patch: '@@ -1 +1 @@\n-old\n+new',
  additions,
  deletions: 0,
  status,
});

const changed: DiffFile[] = [
  file('packages/review-editor/utils/fileKindTree.ts'),
  file('packages/review-editor/utils/explorerTree.ts', 'added', 12),
  file('packages/shared/old.ts', 'deleted', 0),
];

const LISTING = [
  '.gitignore',
  'README.md',
  'apps/hook/index.ts',
  'packages/review-editor/utils/buildFileTree.ts',
  'packages/review-editor/utils/explorerTree.ts',
  'packages/review-editor/utils/fileKindTree.ts',
  'packages/shared/review-core.ts',
  'packages/ui/a.ts',
];

function ready(overrides: Partial<Extract<RepoFilesState, { status: 'ready' }>> = {}): Extract<RepoFilesState, { status: 'ready' }> {
  return {
    status: 'ready',
    revision: { kind: 'worktree', label: 'working tree' },
    total: LISTING.length,
    live: true,
    truncated: false,
    paths: LISTING,
    dirs: new Map(),
    onDisk: {},
    updatedAt: Date.now(),
    liveVersion: 0,
    ...overrides,
  };
}

function repo(state: RepoFilesState, loadDir = mock(() => {})): RepoFiles {
  return { state, loadDir, reload: () => {} };
}

type TreeProps = Partial<React.ComponentProps<typeof FileTree>>;

function Tree(props: TreeProps) {
  return (
    <FileTree
      files={changed}
      activeFileIndex={0}
      onSelectFile={() => {}}
      annotations={[]}
      viewedFiles={new Set()}
      stagedFiles={new Set()}
      treeScope="all"
      repoFiles={repo(ready())}
      {...props}
    />
  );
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
const repoShadow = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-repo-file-tree]')!.shadowRoot!;
const repoRow = (el: HTMLElement, path: string) => repoShadow(el).querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
const visibleRows = (el: HTMLElement) =>
  [...repoShadow(el).querySelectorAll<HTMLElement>('[data-type="item"]')].map((row) => {
    const path = row.dataset.itemPath!;
    if (row.dataset.itemType === 'folder') return `dir:${path.replace(/\/$/, '')}`;
    return `${row.querySelector('[data-item-part-id="viewed"]') ? 'changed' : 'file'}:${path}`;
  });

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe.skipIf(!hasDom)('FileTree: Changes | All files', () => {
  test('the tree draws the shared header and the scope leads its sticky tools; Changes is the changed tree', async () => {
    const onScope = mock((_scope: string) => {});
    const header = {
      view: 'tree' as const,
      showSections: true,
      showCommits: false,
      onSelectView: () => {},
      scope: { value: 'changes' as const, onSelect: onScope, changed: changed.length, all: LISTING.length },
    };
    const el = await mount(<Tree header={header} treeScope="changes" repoFiles={repo(ready())} />);
    expect(el.querySelector('[data-review-panel-header]')).not.toBeNull();
    // The scope stays in view while the list scrolls: it is in the sticky block.
    const all = el.querySelector<HTMLButtonElement>('[data-review-sticky-tools] [data-tree-scope="all"]')!;
    expect(all.textContent).toBe('All files8');
    // Changes is today's tree: no repository list.
    expect(el.querySelector('[data-repo-file-tree]')).toBeNull();
    await act(async () => all.click());
    expect(onScope).toHaveBeenCalledWith('all');
  });

  test('no header without a model (a host that draws its own)', async () => {
    const el = await mount(<Tree />);
    expect(el.querySelector('[data-review-panel-header]')).toBeNull();
    expect(el.querySelector('[data-repo-file-tree]')).not.toBeNull();
  });

  test('All files opens on the paths that lead to changes; changed rows keep their controls', async () => {
    const el = await mount(<Tree />);
    await settle();
    expect(visibleRows(el)).toEqual([
      'dir:apps',
      'dir:packages',
      'dir:packages/review-editor',
      'dir:packages/review-editor/utils',
      'file:packages/review-editor/utils/buildFileTree.ts',
      'changed:packages/review-editor/utils/explorerTree.ts',
      'changed:packages/review-editor/utils/fileKindTree.ts',
      'dir:packages/shared',
      'changed:packages/shared/old.ts',
      'file:packages/shared/review-core.ts',
      'dir:packages/ui',
      'file:.gitignore',
      'file:README.md',
    ]);
    expect(repoRow(el, 'packages/review-editor/utils/fileKindTree.ts').textContent).toContain('+2');
  });

  test('folders open and close; a changed row selects its diff, an unchanged one opens the file', async () => {
    const onSelectFile = mock((_index: number) => {});
    const onOpenRepoFile = mock((_path: string, _options: { pin: boolean }) => {});
    const el = await mount(<Tree onSelectFile={onSelectFile} onOpenRepoFile={onOpenRepoFile} />);
    await settle();
    await act(async () => repoRow(el, 'apps/').click());
    await settle();
    expect(visibleRows(el)).toContain('dir:apps/hook');
    await act(async () => repoRow(el, 'packages/').click());
    await settle();
    expect(visibleRows(el).filter((row) => row.includes('packages/'))).toEqual([]);
    await act(async () => repoRow(el, 'packages/').click());
    await settle();

    await act(async () => repoRow(el, 'packages/review-editor/utils/explorerTree.ts').click());
    expect(onSelectFile).toHaveBeenCalledWith(1);
    await act(async () => repoRow(el, 'README.md').click());
    expect(onOpenRepoFile).toHaveBeenLastCalledWith('README.md', { pin: false });
    await act(async () => repoRow(el, 'README.md').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onOpenRepoFile).toHaveBeenLastCalledWith('README.md', { pin: true });
  });

  test('files changed on disk since the diff was taken carry a mark', async () => {
    const el = await mount(
      <Tree repoFiles={repo(ready({ onDisk: { 'packages/review-editor/utils/fileKindTree.ts': 'M', 'packages/shared/review-core.ts': 'A' } }))} />,
    );
    await settle();
    expect(repoRow(el, 'packages/shared/review-core.ts').dataset.itemGitStatus).toBe('untracked');
    expect(repoRow(el, 'packages/shared/review-core.ts').querySelector('[title^="Added on disk"]')).not.toBeNull();
  });

  test('a big repository renders only a window of rows', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `packages/review-editor/utils/f${String(i).padStart(5, '0')}.ts`);
    const el = await mount(<Tree repoFiles={repo(ready({ paths: [...many, ...LISTING].sort(), total: many.length + LISTING.length }))} />);
    await settle();
    const rendered = repoShadow(el).querySelectorAll('[data-type="item"]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(100);
  });

  test('a lazy listing asks for a folder when it opens and shows its children when they come', async () => {
    const loadDir = mock((_dir: string) => {});
    const rootEntries = [
      { name: 'packages', path: 'packages', type: 'dir' as const, files: 4 },
      { name: 'README.md', path: 'README.md', type: 'file' as const },
    ];
    const state = ready({ paths: null, total: 400_000, dirs: new Map([['', rootEntries]]) });
    const el = await mount(<Tree repoFiles={repo(state, loadDir)} />);
    await settle();
    expect(loadDir).toHaveBeenCalledWith('packages');
    expect(visibleRows(el)).toContain('file:packages/Loading\u2026');
    const next = ready({
      paths: null,
      total: 400_000,
      dirs: new Map([
        ['', rootEntries],
        ['packages', [{ name: 'ui', path: 'packages/ui', type: 'dir' as const, files: 1 }]],
      ]),
    });
    await act(async () => root?.render(<Tree repoFiles={repo(next, loadDir)} />));
    await settle();
    expect(visibleRows(el)).toContain('dir:packages/ui');
    expect(visibleRows(el)).not.toContain('file:packages/Loading\u2026');
    await act(async () => repoRow(el, 'packages/ui/').click());
    await settle();
    expect(loadDir).toHaveBeenLastCalledWith('packages/ui');
  });

  test('going to Changes and back keeps All files as it was left', async () => {
    const el = await mount(<Tree />);
    await settle();
    await act(async () => repoRow(el, 'packages/').click());
    await settle();
    expect(repoRow(el, 'packages/').getAttribute('aria-expanded')).toBe('false');
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => root?.render(<Tree treeScope="changes" />));
    await settle();
    await act(async () => root?.render(<Tree treeScope="all" />));
    await settle();
    expect(repoRow(el, 'packages/').getAttribute('aria-expanded')).toBe('false');
    expect(visibleRows(el)).toContain('dir:apps');
    elsewhere.remove();
  });

  test('arrow keys in All files open each file as they reach it', async () => {
    const onOpenRepoFile = mock((_path: string, _options: { pin: boolean }) => {});
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(<Tree onOpenRepoFile={onOpenRepoFile} onSelectFile={onSelectFile} />);
    await settle();
    const start = repoRow(el, 'packages/review-editor/utils/buildFileTree.ts');
    await act(async () => start.focus());
    await settle();
    expect(onOpenRepoFile).toHaveBeenLastCalledWith('packages/review-editor/utils/buildFileTree.ts', { pin: false });
    await act(async () => start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await settle();
    expect(onSelectFile).toHaveBeenLastCalledWith(1);
    const changed = repoRow(el, 'packages/review-editor/utils/explorerTree.ts');
    await act(async () => changed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await act(async () => repoRow(el, 'packages/review-editor/utils/fileKindTree.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await settle();
    expect(onOpenRepoFile).toHaveBeenCalledTimes(1);
    await act(async () => repoRow(el, 'packages/shared/').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await act(async () => repoRow(el, 'packages/shared/old.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await settle();
    expect(onOpenRepoFile).toHaveBeenLastCalledWith('packages/shared/review-core.ts', { pin: false });
  });

  test('says why when the session cannot list the repository', async () => {
    const el = await mount(
      <Tree repoFiles={repo({ status: 'unavailable', reason: 'no-checkout', message: 'All files needs the local checkout.' })} />,
    );
    expect(el.querySelector('[data-repo-files-unavailable="no-checkout"]')?.textContent).toBe('All files needs the local checkout.');
  });
});
