import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import { EllipsisName } from './EllipsisName';
import { BranchName } from './BranchName';
import type { DiffFile } from '../types';
import { installFakeTextLayout, type FakeTextLayout } from '../../../tests/helpers/fake-text-layout';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let layout: FakeTextLayout | null = null;

beforeAll(() => {
  if (hasDom) layout = installFakeTextLayout();
});
afterAll(() => layout?.restore());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const files: DiffFile[] = Array.from({ length: 200 }, (_, i) => ({
  path: `src/feature-${i % 10}/a-rather-long-component-file-name-${i}.tsx`,
  patch: '@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 0,
  status: 'modified',
}));

const FIT_CODE = /textFit|useFittedText|EllipsisName|BranchName|observeTreeName|TailKeptName/;

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe.skipIf(!hasDom)('fitting names to their room', () => {
  test('200 tree rows, 20 tab titles and the header fit their names without one layout read', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <div>
        <header>
          <BranchName branch="feature/PLAT-12345/billing-reconciliation/v2-final" />
          <EllipsisName text="packages/review-editor/components/a-rather-long-component-file-name.tsx" />
        </header>
        <nav>{Array.from({ length: 20 }, (_, i) => <EllipsisName key={i} text={`a-rather-long-tab-title-number-${i}.tsx`} />)}</nav>
        <FileTree files={files} activeFileIndex={0} onSelectFile={() => {}} annotations={[]} viewedFiles={new Set()} stagedFiles={new Set()} />
      </div>,
    ));
    await settle();
    const mounted = layout!.layoutReads(FIT_CODE);
    const afterMount = layout!.layoutReads();
    for (const width of [60, 90, 400]) {
      await act(async () => layout!.resize((element) => (element.matches('[data-item-name], [data-ellipsis-name], [data-branch-name]') ? width : undefined)));
      await settle();
    }
    const tree = host.querySelector<HTMLElement>('[data-changes-tree]')!.shadowRoot!;
    const names = [...tree.querySelectorAll<HTMLElement>('[data-item-name]')].filter((name) => name.textContent?.endsWith('.tsx'));
    const tabs = [...host.querySelectorAll<HTMLElement>('nav [data-ellipsis-name]')];
    expect(names.length).toBeGreaterThan(0);
    expect(tabs).toHaveLength(20);
    expect(mounted).toBe(0);
    expect(layout!.layoutReads() - afterMount).toBe(0);
    await act(async () => layout!.resize((element) => (element.matches('[data-item-name], [data-ellipsis-name], [data-branch-name]') ? 90 : undefined)));
    await settle();
    expect(names[0]!.textContent).toBe('a-ra…e-0.tsx');
    expect(tabs[0]!.textContent).toBe('…umber-0.tsx');
    expect(host.querySelector('[data-branch-shown]')!.textContent).toBe('fea…v2-final');
  });
});
