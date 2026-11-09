/**
 * Go to File (approved design record "review-explorer", step 3).
 *
 * Regressions guarded:
 *  - a listing the browser holds searched on the server (or not at all);
 *  - a lazy listing (too large to send) not searched on the server;
 *  - a changed file not marked, or Enter / Alt+Enter not opening the
 *    highlighted file (preview vs a tab beside);
 *  - nothing typed showing nothing instead of the files opened last;
 *  - a review with no repository to list pretending it searched one.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GoToFile, type GoToFileProps } from './GoToFile';
import type { DiffFile } from '../types';
import type { RepoFilesState } from '../hooks/useRepoFiles';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const files: DiffFile[] = [
  { path: 'packages/review-editor/utils/fileKindTree.ts', patch: '', additions: 2, deletions: 0, status: 'modified' },
];
const ready = (paths: string[]): RepoFilesState => ({
  status: 'ready',
  revision: { kind: 'worktree', label: 'working tree' },
  total: paths.length,
  live: true,
  truncated: false,
  paths,
  dirs: new Map(),
  onDisk: {},
  updatedAt: 0,
  liveVersion: 0,
});
const paths = [
  'packages/ui/utils/diffFileTree.ts',
  'packages/ui/components/DiffFileTree.tsx',
  'packages/review-editor/utils/fileKindTree.ts',
  'README.md',
];

async function mount(props: Partial<GoToFileProps> = {}) {
  const onOpen = mock((_path: string, _options: { side: boolean }) => {});
  const onClose = mock(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <GoToFile onOpen={onOpen} onClose={onClose} files={files} repo={ready(paths)} repoSupported recentPaths={[]} snapshotId="snap" {...props} />,
  ));
  return { onOpen, onClose };
}

const input = () => document.querySelector<HTMLInputElement>('[data-go-to-file-input]')!;
const rowPaths = () => [...document.querySelectorAll('[data-goto-path]')].map((el) => el.getAttribute('data-goto-path'));
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(name: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe.skipIf(!hasDom)('GoToFile', () => {
  test('searches the listing it holds; the changed file is marked; Enter opens, Alt+Enter beside', async () => {
    const fetchImpl = mock(async () => new Response('{}'));
    const { onOpen } = await mount({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(document.activeElement).toBe(input());
    await type('tree');
    expect(rowPaths()).toContain('packages/ui/utils/diffFileTree.ts');
    expect(rowPaths()).not.toContain('README.md');
    const changedRow = document.querySelector('[data-goto-path="packages/review-editor/utils/fileKindTree.ts"]')!;
    expect(changedRow.querySelector('[data-goto-status]')?.textContent).toBe('M');
    expect(changedRow.textContent).toContain('+2');
    expect(fetchImpl).not.toHaveBeenCalled();

    await key('ArrowDown');
    const second = rowPaths()[1]!;
    await key('Enter');
    expect(onOpen).toHaveBeenLastCalledWith(second, { side: false });
    await key('Enter', { altKey: true });
    expect(onOpen).toHaveBeenLastCalledWith(second, { side: true });
    expect(document.querySelector('[data-go-to-file-scope]')?.textContent).toBe('4 files · changed ones marked');
  });

  test('nothing typed: the files opened last, then the changed files', async () => {
    await mount({ recentPaths: ['README.md'] });
    expect(rowPaths()).toEqual(['README.md', 'packages/review-editor/utils/fileKindTree.ts']);
    expect(document.body.textContent).toContain('Recently opened');
    expect(document.body.textContent).toContain('Changed files');
  });

  test('a lazy listing is searched on the server', async () => {
    const fetchImpl = mock(async (url: string) => new Response(JSON.stringify({
      query: 'kind',
      total: 300000,
      matches: [{ path: 'src/kind.ts', score: 10, positions: [4, 5, 6, 7] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const lazy: RepoFilesState = { ...(ready([]) as Extract<RepoFilesState, { status: 'ready' }>), paths: null, total: 300000 };
    await mount({ repo: lazy, fetchImpl: fetchImpl as unknown as typeof fetch });
    await type('kind');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/repo-files/search?snapshot=snap&q=kind&limit=50');
    expect(rowPaths()).toEqual(['src/kind.ts']);
  });

  test('no repository to list: changed files only, and it says so; Escape closes and focus goes back', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = await mount({ repoSupported: false, repo: { status: 'idle' } });
    expect(document.activeElement).toBe(input());
    await type('kind');
    expect(rowPaths()).toEqual(['packages/review-editor/utils/fileKindTree.ts']);
    expect(document.querySelector('[data-go-to-file-scope]')?.textContent).toContain('Changed files only');
    await key('Escape');
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
