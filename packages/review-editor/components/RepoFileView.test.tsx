/**
 * DOM coverage for opening any file of the repository (approved design record
 * "review-explorer", step 2): the file a review does not change, whole and
 * read-only, and the Changes | Whole file switch.
 *
 * Regressions guarded:
 *  - an unchanged file not saying it is outside the review, or at which
 *    revision it was read;
 *  - a file with no text (too large, binary, gone) showing an empty pane
 *    instead of why;
 *  - the preview tab's hint missing, or shown on a kept tab;
 *  - the switch letting Whole file open where the file has none.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RepoFileView } from './RepoFileView';
import { FileViewSwitch } from './FileViewSwitch';
import { __clearRepoFileTextCache } from '../hooks/useRepoFileText';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
const realFetch = globalThis.fetch;

function answer(body: unknown, status = 200) {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return host;
}

beforeEach(() => __clearRepoFileTextCache());
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const view = (props: Partial<React.ComponentProps<typeof RepoFileView>> = {}) => (
  <RepoFileView
    filePath="packages/ui/utils/diffFileTree.ts"
    snapshotId="snap-1"
    preview
    annotations={[]}
    selectedAnnotationId={null}
    onAddAnnotation={() => {}}
    onEditAnnotation={() => {}}
    onDeleteAnnotation={() => {}}
    onSelectAnnotation={() => {}}
    {...props}
  />
);

describe.skipIf(!hasDom)('RepoFileView: a file the review does not change', () => {
  test('says it is not in the review and at which revision; reads it once per snapshot and path', async () => {
    answer({ path: 'packages/ui/utils/diffFileTree.ts', revision: { kind: 'commit', label: 'a1b2c3d' }, content: 'export const x = 1;\n' });
    const el = await mount(view());
    expect(el.querySelector('[data-not-in-review]')?.textContent).toBe('Not in this review');
    expect(el.querySelector('[data-repo-file-revision]')?.textContent).toBe('at a1b2c3d');
    expect(el.textContent).toContain('packages/ui/utils/');
    expect(el.textContent).toContain('diffFileTree.ts');
    expect(el.querySelector('[data-preview-hint]')?.textContent).toBe('Double-click the tab to keep it');
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/repo-file?snapshot=snap-1&path=packages%2Fui%2Futils%2FdiffFileTree.ts');
  });

  test('a kept tab has no preview hint', async () => {
    answer({ path: 'a.ts', revision: { kind: 'worktree', label: 'working tree' }, content: 'a\n' });
    const el = await mount(view({ filePath: 'a.ts', preview: false }));
    expect(el.querySelector('[data-preview-hint]')).toBeNull();
    expect(el.querySelector('[data-repo-file-revision]')?.textContent).toBe('at working tree');
  });

  test('says why a file has no text', async () => {
    answer({ path: 'big.bin', revision: { kind: 'worktree', label: 'working tree' }, content: null, reason: 'too-large', size: 7 * 1024 * 1024 });
    const el = await mount(view({ filePath: 'big.bin' }));
    expect(el.querySelector('[data-repo-file-state]')?.textContent).toBe('Too large to show (7.0 MB; the limit is 5 MB).');
  });

  test('a binary file', async () => {
    answer({ path: 'logo.png', revision: { kind: 'worktree', label: 'working tree' }, content: null, reason: 'binary' });
    const el = await mount(view({ filePath: 'logo.png' }));
    expect(el.querySelector('[data-repo-file-state]')?.textContent).toBe('A binary file: nothing to show as text.');
  });

  test('a snapshot that moved on asks for Refresh', async () => {
    answer({ error: 'stale', reason: 'stale' }, 409);
    const el = await mount(view({ filePath: 'old.ts' }));
    expect(el.querySelector('[data-repo-file-state]')?.textContent).toBe('The diff changed since this tab opened. Refresh to read the file again.');
  });
});

describe.skipIf(!hasDom)('FileViewSwitch', () => {
  test('Changes | Whole file, and Whole file disabled with the reason where there is none', async () => {
    const onSelect = mock((_view: string) => {});
    const el = await mount(<FileViewSwitch view="changes" onSelect={onSelect} />);
    const whole = el.querySelector<HTMLButtonElement>('[data-file-view="whole"]')!;
    expect(el.querySelector('[data-file-view="changes"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => whole.click());
    expect(onSelect).toHaveBeenCalledWith('whole');

    await act(async () => root?.render(<FileViewSwitch view="changes" onSelect={onSelect} wholeUnavailableReason="The diff deletes this file" />));
    const disabled = el.querySelector<HTMLButtonElement>('[data-file-view="whole"]')!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toBe('The diff deletes this file');
  });
});
