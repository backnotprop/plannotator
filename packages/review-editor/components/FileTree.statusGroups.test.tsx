import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import type { DiffFile } from '../types';
import type { SinceBaseSections } from '@plannotator/shared/types';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const file = (path: string, status: DiffFile['status'] = 'modified'): DiffFile => ({
  path,
  patch: '@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 1,
  status,
});

const files: DiffFile[] = [
  file('src/committed.ts'),
  file('src/staged.ts'),
  file('src/edited.ts'),
  file('src/new.ts', 'added'),
];

const sections: SinceBaseSections = {
  base: 'origin/main',
  mergeBase: 'abc',
  files: {
    'src/staged.ts': { group: 'changes', staged: true },
    'src/edited.ts': { group: 'changes', staged: false },
    'src/new.ts': { group: 'untracked', staged: false },
  },
};

function Tree(props: Partial<React.ComponentProps<typeof FileTree>>) {
  return (
    <FileTree
      files={files}
      activeFileIndex={0}
      onSelectFile={() => {}}
      annotations={[]}
      viewedFiles={new Set()}
      stagedFiles={new Set(['src/staged.ts'])}
      sinceBaseSections={sections}
      groupBy="status"
      onSelectGroupBy={() => {}}
      statusGroupingAvailable
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

const blocks = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-file-status-block]')].map((b) => b.dataset.fileStatusBlock);
const names = (el: HTMLElement, status: string) =>
  [...el.querySelectorAll(`[data-file-status-block="${status}"] .file-tree-item`)].map((row) => row.querySelector('.truncate')?.textContent);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('Git status as a grouping of the tree', () => {
  test('the files fall into Committed, Staged, Unstaged and Untracked, each a folded-able group with its counts', async () => {
    const el = await mount(<Tree />);
    expect(blocks(el)).toEqual(['committed', 'staged', 'unstaged', 'untracked']);
    expect(names(el, 'staged')).toEqual(['staged.ts']);
    expect(names(el, 'unstaged')).toEqual(['edited.ts']);
    expect(names(el, 'untracked')).toEqual(['new.ts']);
    const heading = el.querySelector<HTMLButtonElement>('[data-file-status-block="unstaged"] button[aria-expanded]')!;
    expect(heading.textContent).toContain('Unstaged');
    expect(heading.textContent).toContain('0/1');
  });

  test('a file can be staged from its row, and staging moves it to Staged', async () => {
    const onStageFile = mock((_path: string) => {});
    const el = await mount(<Tree onStageFile={onStageFile} />);
    const plus = el.querySelector<HTMLElement>('[data-file-status-block="unstaged"] .stage-plus')!;
    await act(async () => plus.click());
    expect(onStageFile).toHaveBeenCalledWith('src/edited.ts');
    await act(async () => root?.render(<Tree onStageFile={onStageFile} stagedFiles={new Set(['src/staged.ts', 'src/edited.ts'])} />));
    expect(names(el, 'staged')).toEqual(['edited.ts', 'staged.ts']);
    expect(el.querySelector('[data-file-status-block="unstaged"]')).toBeNull();
  });

  test('the … menu offers the grouping only when git status can be shown', async () => {
    const onSelectGroupBy = mock((_value: string) => {});
    const el = await mount(<Tree groupBy="kind" onSelectGroupBy={onSelectGroupBy} />);
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="List options"]')!.click());
    const status = document.querySelector<HTMLElement>('[data-review-group-by="status"]');
    expect(status).not.toBeNull();
    await act(async () => status!.click());
    expect(onSelectGroupBy).toHaveBeenCalledWith('status');
    await act(async () => root?.render(<Tree groupBy="kind" onSelectGroupBy={onSelectGroupBy} statusGroupingAvailable={false} />));
    expect(document.querySelector('[data-review-group-by="status"]')).toBeNull();
  });
});
