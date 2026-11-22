/**
 * DOM coverage for the tree's All files list (approved design record
 * "review-explorer", step 1) and the header the tree draws above it (the
 * header itself is covered by ReviewPanelHeader.test.tsx).
 *
 * Regressions guarded:
 *  - All files losing the changed files' own rows (letter, +/-, folder
 *    totals), or a changed file the new side deletes dropping out of the tree;
 *  - folders opening anything but the paths that lead to changes;
 *  - the list rendering every row of a big repository (it must be virtual);
 *  - a lazy listing never asking for a folder that is opened;
 *  - files changed on disk since the snapshot showing no mark.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import { markFirstCodePainted } from '../utils/firstCodePaint';
import { useReviewFileFilter } from '../hooks/useReviewFileFilter';
import { compileReviewFileFilter } from '@plannotator/shared/review-file-filter';
import type { DiffFile } from '../types';
import type { RepoFiles, RepoFilesState } from '../hooks/useRepoFiles';
import { key, searchInput, typeInSearch } from './treeKeys.testing';

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
    const onDisk = row.querySelector('[title*="on disk since"]');
    return `${onDisk ? 'disk' : row.dataset.itemGitStatus ? 'changed' : 'file'}:${path}`;
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

  test('the filtered Changes tree keeps original selection indexes and full progress', async () => {
    const onSelectFile = mock((_index: number) => {});
    const shown = changed[1].path;
    markFirstCodePainted();
    const el = await mount(
      <Tree
        treeScope="changes"
        header={{ view: 'tree', showCommits: false, onSelectView: () => {} }}
        visiblePaths={new Set([shown])}
        onSelectFile={onSelectFile}
      />,
    );
    await settle();
    const tree = el.querySelector<HTMLElement>('[data-changes-tree]')!.shadowRoot!;
    expect(tree.querySelector('[data-item-path$="fileKindTree.ts"]')).toBeNull();
    const row = tree.querySelector<HTMLElement>('[data-item-path$="explorerTree.ts"]')!;
    await act(async () => row.click());
    expect(onSelectFile).toHaveBeenCalledWith(1);
    expect(el.querySelector('[data-review-progress-caption]')?.textContent).toContain('0 of 3 viewed');
  });

  test('the filtered All files tree adds matching deleted paths and keeps the original selection index', async () => {
    const onSelectFile = mock((_index: number) => {});
    const filteredPath = changed[2].path;
    const el = await mount(
      <Tree
        visiblePaths={new Set([filteredPath])}
        repoFiles={repo(ready({ paths: ['packages/shared/review-core.ts'] }))}
        onSelectFile={onSelectFile}
      />,
    );
    await settle();
    expect(visibleRows(el)).toContain(`changed:${filteredPath}`);
    expect(repoRow(el, changed[0].path)).toBeNull();
    await act(async () => repoRow(el, filteredPath).click());
    expect(onSelectFile).toHaveBeenCalledWith(2);
  });

  test('filter controls follow the search between Changes, All files, and diff search', async () => {
    function Harness({ treeScope, isSearchOpen = false, empty = false }: {
      treeScope: 'changes' | 'all';
      isSearchOpen?: boolean;
      empty?: boolean;
    }) {
      const { input } = useReviewFileFilter();
      return (
        <Tree
          header={{ view: 'tree', showCommits: false, onSelectView: () => {}, fileFilterInput: input }}
          treeScope={treeScope}
          isSearchOpen={isSearchOpen}
          visiblePaths={empty ? new Set() : undefined}
          onSearchChange={() => {}}
        />
      );
    }

    markFirstCodePainted();
    const el = await mount(<Harness treeScope="changes" />);
    const toggle = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Filter files"]')!;
    expect(toggle().closest('[data-changes-tree]')).not.toBeNull();
    expect(el.querySelector('[data-review-panel-header]')?.contains(toggle())).toBe(false);
    await act(async () => toggle().click());
    const exclude = el.querySelector('[name="exclude"]');
    await act(async () => root?.render(<Harness treeScope="changes" empty />));
    expect(el.querySelector('[name="exclude"]')).toBe(exclude);
    expect(el.querySelector('[data-changes-tree] [role="status"]')?.textContent).toBe('No files match');

    await act(async () => root?.render(<Harness treeScope="all" />));
    expect(toggle().closest('[data-repo-file-tree]')).not.toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    await act(async () => root?.render(<Harness treeScope="all" isSearchOpen />));
    expect(toggle().parentElement?.querySelector('[data-panel-search-field]')).not.toBeNull();
    expect(el.querySelectorAll('input[name="exclude"]')).toHaveLength(1);
  });

  test('an active filter says how many files it keeps with the boxes closed, and Clear brings every file back', async () => {
    function Harness() {
      const { applied, input } = useReviewFileFilter();
      const matches = compileReviewFileFilter(applied);
      return (
        <Tree
          header={{ view: 'tree', showCommits: false, onSelectView: () => {}, fileFilterInput: input, fileFilterActive: !!matches }}
          treeScope="changes"
          visiblePaths={matches ? new Set(changed.filter((f) => matches(f.path)).map((f) => f.path)) : undefined}
        />
      );
    }

    markFirstCodePainted();
    const el = await mount(<Harness />);
    const toggle = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Filter files"]')!;
    const summary = () => el.querySelector('[data-review-file-filter-summary]');
    expect(summary()).toBeNull();
    await act(async () => toggle().click());
    const field = el.querySelector<HTMLInputElement>('input[name="include"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(field, 'explorerTree.ts');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await Bun.sleep(150); });
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('input[name="include"]')).toBeNull();
    expect(summary()?.textContent).toContain('1 of 3 files');

    await act(async () => summary()!.querySelector('button')!.click());
    await settle();
    expect(summary()).toBeNull();
    expect(toggle().getAttribute('aria-label')).toBe('Filter files');
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
    expect(repoRow(el, 'packages/').querySelector('[data-item-section="trail"]')?.textContent).toBe('+14');
  });

  test('a staged changed file carries the Staged mark in All files too (#3683)', async () => {
    const staged = 'packages/review-editor/utils/fileKindTree.ts';
    const el = await mount(<Tree stagedFiles={new Set([staged])} />);
    await settle();
    expect(repoRow(el, staged).querySelector('[data-item-section="trail"] [title="Staged"]')).not.toBeNull();
    expect(repoRow(el, 'packages/review-editor/utils/explorerTree.ts').querySelector('[title="Staged"]')).toBeNull();
  });

  test('grouped by git status, All files still shows the Staged mark: it has no Staged group to say it (#3683)', async () => {
    const staged = 'packages/review-editor/utils/fileKindTree.ts';
    const sections = {
      base: 'origin/main',
      mergeBase: 'abc',
      files: {
        [staged]: { group: 'changes' as const, staged: true },
        'packages/review-editor/utils/explorerTree.ts': { group: 'untracked' as const, staged: false },
      },
    };
    // One viewed set, annotations array and listing across the rerender, so the
    // rows must redraw for the staged set alone.
    const viewedFiles = new Set<string>();
    const annotations: NonNullable<TreeProps['annotations']> = [];
    const repoFiles = repo(ready());
    const tree = (extra: TreeProps = {}) => (
      <Tree viewedFiles={viewedFiles} annotations={annotations} repoFiles={repoFiles} stagedFiles={new Set([staged])} sinceBaseSections={sections} groupBy="status" onSelectGroupBy={() => {}} statusGroupingAvailable {...extra} />
    );
    const hasMark = (el: HTMLElement) => repoRow(el, staged).querySelector('[data-item-section="trail"] [title="Staged"]') !== null;
    const el = await mount(tree());
    await settle();
    expect(hasMark(el)).toBe(true);
    // Still off with the header's Git add button.
    await act(async () => root?.render(tree({ showStageControls: false })));
    await settle();
    expect(hasMark(el)).toBe(false);
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
    expect(visibleRows(el)).toContain('disk:packages/shared/review-core.ts');
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

  test('the files next to the one opened are read ahead', async () => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://x');
      asked.push(url.searchParams.get('path') ?? '');
      return new Response(JSON.stringify({ content: 'x', revision: { kind: 'worktree', label: 'working tree' } }), { status: 200 });
    }) as typeof fetch;
    try {
      const el = await mount(<Tree snapshotId="snap-1" />);
      await settle();
      expect(repoRow(el, 'README.md')).toBeTruthy();
      await act(async () => root?.render(<Tree snapshotId="snap-1" activeRepoPath="README.md" />));
      await settle();
      expect(asked).toContain('.gitignore');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the search box filters All files as you type and opens nothing; a letter on a row starts no search', async () => {
    const onOpenRepoFile = mock((_path: string, _options: { pin: boolean }) => {});
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(<Tree onOpenRepoFile={onOpenRepoFile} onSelectFile={onSelectFile} />);
    await settle();
    const row = repoRow(el, 'README.md');
    await act(async () => row.focus());
    onOpenRepoFile.mockClear();
    await act(async () => key(row, 'r'));
    await settle();
    const box = repoShadow(el).querySelector<HTMLElement>('[data-file-tree-search-container]')!;
    expect(box.dataset.open).toBe('false');
    const host = el.querySelector('[data-repo-file-tree]')!;
    await typeInSearch(host, 'readme');
    await settle();
    expect(searchInput(host).value).toBe('readme');
    expect(visibleRows(el)).toEqual(['file:README.md']);
    expect(onOpenRepoFile).not.toHaveBeenCalled();
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  test('a file clicked twice opens once; after another file it opens again', async () => {
    const onOpenRepoFile = mock((_path: string, _options: { pin: boolean }) => {});
    const el = await mount(<Tree onOpenRepoFile={onOpenRepoFile} />);
    await settle();
    await act(async () => repoRow(el, 'README.md').click());
    await act(async () => repoRow(el, 'README.md').click());
    await settle();
    expect(onOpenRepoFile.mock.calls.filter(([path]) => path === 'README.md')).toHaveLength(1);
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => root?.render(<Tree onOpenRepoFile={onOpenRepoFile} activeRepoPath=".gitignore" />));
    await settle();
    elsewhere.remove();
    await act(async () => repoRow(el, 'README.md').click());
    await settle();
    expect(onOpenRepoFile.mock.calls.filter(([path]) => path === 'README.md')).toHaveLength(2);
  });

  test('says why when the session cannot list the repository', async () => {
    const el = await mount(
      <Tree repoFiles={repo({ status: 'unavailable', reason: 'no-checkout', message: 'All files needs the local checkout.' })} />,
    );
    expect(el.querySelector('[data-repo-files-unavailable="no-checkout"]')?.textContent).toBe('All files needs the local checkout.');
  });

  test('an empty review lists "All changes" once: the nav row waits for files', async () => {
    const empty = await mount(<Tree files={[]} treeScope="changes" onSelectAllFiles={() => {}} />);
    expect([...empty.querySelectorAll('[data-nav-row]')].some((row) => row.textContent?.includes('All changes'))).toBe(false);
    await act(async () => root?.unmount());
    root = null;
    const some = await mount(<Tree treeScope="changes" onSelectAllFiles={() => {}} />);
    expect([...some.querySelectorAll('[data-nav-row]')].some((row) => row.textContent?.includes('All changes'))).toBe(true);
  });
});

