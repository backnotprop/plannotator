import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import type { DiffFile } from '../types';
import type { SinceBaseSections } from '@plannotator/shared/types';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const file = (path: string, additions = 1, deletions = 0, status: DiffFile['status'] = 'modified'): DiffFile => ({
  path,
  patch: '@@ -1 +1 @@\n-old\n+new',
  additions,
  deletions,
  status,
});

const mixed: DiffFile[] = [
  file('bun.lock', 5, 1),
  file('src/sync/__tests__/retry.test.ts', 20),
  file('src/sync/retry.ts', 19),
  file('README.md', 1, 1),
  file('tests/e2e/sync.spec.ts', 4, 3),
];

const working: DiffFile[] = [
  file('src/committed.ts'),
  file('src/staged.ts'),
  file('src/edited.ts', 3, 2),
  file('src/new.ts', 4, 0, 'added'),
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

type TreeProps = Partial<React.ComponentProps<typeof FileTree>>;

function Tree(props: TreeProps) {
  return (
    <FileTree
      files={mixed}
      activeFileIndex={2}
      onSelectFile={() => {}}
      annotations={[]}
      viewedFiles={new Set()}
      stagedFiles={new Set()}
      {...props}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  await settle();
  return host;
}

async function rerender(element: React.ReactElement) {
  await act(async () => root?.render(element));
  await settle();
}

const shadow = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-changes-tree]')!.shadowRoot!;
const rowEls = (el: HTMLElement) => [...shadow(el).querySelectorAll<HTMLElement>('[data-type="item"]')];
const rows = (el: HTMLElement) => rowEls(el).map((row) => row.dataset.itemPath);
const row = (el: HTMLElement, path: string) => rowEls(el).find((r) => r.dataset.itemPath === path)!;
const part = (el: HTMLElement, path: string, id: string) => row(el, path).querySelector<HTMLElement>(`[data-item-part-id="${id}"]`)!;
const trail = (el: HTMLElement, path: string) =>
  [...row(el, path).querySelectorAll('[data-item-section="trail"] > span')].map((cell) => cell.textContent);
const selected = (el: HTMLElement) => rowEls(el).filter((r) => r.dataset.itemSelected === 'true').map((r) => r.dataset.itemPath);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('The Changes tree on Pierre trees', () => {
  test('group by kind: Code, Tests, Docs, Generated in that order, Generated folded, folder sums beside folders', async () => {
    const el = await mount(<Tree groupByKind />);
    expect(rows(el)).toEqual([
      'Code/',
      'Code/retry.ts',
      'Tests/',
      'Tests/src\u2215sync\u2215__tests__/',
      'Tests/src\u2215sync\u2215__tests__/retry.test.ts',
      'Tests/tests\u2215e2e/',
      'Tests/tests\u2215e2e/sync.spec.ts',
      'Docs/',
      'Docs/README.md',
      'Generated/',
    ]);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('false');
    expect(trail(el, 'Code/')).toEqual(['0/1', '+19']);
    expect(trail(el, 'Code/retry.ts')).toEqual(['+19']);
    expect(selected(el)).toEqual(['Code/retry.ts']);
  });

  test('j/k follow the grouped order and open the folded group they land in', async () => {
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(<Tree groupByKind activeFileIndex={3} onSelectFile={onSelectFile} />);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(onSelectFile).toHaveBeenLastCalledWith(0);
    await rerender(<Tree groupByKind activeFileIndex={0} onSelectFile={onSelectFile} />);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('true');
    expect(selected(el)).toEqual(['Generated/bun.lock']);
  });

  test('the viewed circle and the git add button act on their file and leave the selection alone', async () => {
    const onToggleViewed = mock((_path: string) => {});
    const onStageFile = mock((_path: string) => {});
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(
      <Tree
        files={working}
        activeFileIndex={0}
        sinceBaseSections={sections}
        stagedFiles={new Set(['src/staged.ts'])}
        onToggleViewed={onToggleViewed}
        onStageFile={onStageFile}
        onSelectFile={onSelectFile}
      />,
    );
    await act(async () => part(el, 'edited.ts', 'viewed').click());
    expect(onToggleViewed).toHaveBeenCalledWith('src/edited.ts');
    await act(async () => part(el, 'edited.ts', 'stage').click());
    expect(onStageFile).toHaveBeenCalledWith('src/edited.ts');
    await act(async () => part(el, 'staged.ts', 'unstage').click());
    expect(onStageFile).toHaveBeenLastCalledWith('src/staged.ts');
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(row(el, 'committed.ts').querySelector('[data-item-part-id="stage"]')).toBeNull();
    await rerender(
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} stagedFiles={new Set(['src/staged.ts'])} viewedFiles={new Set(['src/edited.ts'])} onStageFile={onStageFile} />,
    );
    expect(part(el, 'edited.ts', 'viewed').getAttribute('aria-pressed')).toBe('true');
    expect(row(el, 'edited.ts').dataset.itemMuted).toBe('true');
  });

  test('group by git status: staging a file from its row moves it to Staged', async () => {
    const tree = (staged: string[]) => (
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} stagedFiles={new Set(staged)} groupBy="status" onSelectGroupBy={() => {}} statusGroupingAvailable onStageFile={() => {}} />
    );
    const el = await mount(tree(['src/staged.ts']));
    expect(rows(el).filter((path) => path?.endsWith('/') && !path.slice(0, -1).includes('/'))).toEqual(['Committed/', 'Staged/', 'Unstaged/', 'Untracked/']);
    await rerender(tree(['src/staged.ts', 'src/edited.ts']));
    expect(rows(el)).toContain('Staged/edited.ts');
    expect(rows(el)).not.toContain('Unstaged/');
  });

  test('arrow keys inside the tree open the next file', async () => {
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(<Tree files={working} activeFileIndex={0} onSelectFile={onSelectFile} />);
    const first = row(el, 'committed.ts');
    await act(async () => first.focus());
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })));
    await settle();
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(rows(el).slice(0, 2)).toEqual(['committed.ts', 'edited.ts']);
    expect(onSelectFile).toHaveBeenCalledWith(2);
  });

  test('picking another file keeps every drawn row element and draws only the rows in view', async () => {
    const many: DiffFile[] = Array.from({ length: 400 }, (_, i) => file(`src/area-${i % 4}/file-${String(i).padStart(3, '0')}.ts`));
    const el = await mount(<Tree files={many} activeFileIndex={0} />);
    const before = rowEls(el);
    expect(before.length).toBeLessThan(80);
    await rerender(<Tree files={many} activeFileIndex={4} />);
    const after = rowEls(el);
    expect(after.length).toBe(before.length);
    expect(after.every((row, i) => row === before[i])).toBe(true);
  });

  test('grouping turned on after the first draw still starts Generated folded', async () => {
    const el = await mount(<Tree />);
    await rerender(<Tree groupByKind />);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('false');
    expect(row(el, 'Code/').getAttribute('aria-expanded')).toBe('true');
  });

  test('a diff that loads on a generated file keeps Generated folded; moving to it later opens it', async () => {
    const el = await mount(<Tree groupByKind activeFileIndex={0} />);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('false');
    await rerender(<Tree groupByKind activeFileIndex={2} />);
    await rerender(<Tree groupByKind activeFileIndex={0} />);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('true');
  });

  test('a file name is a stem cut at whole letters and a tail that always shows: the last three letters and the extension', async () => {
    const el = await mount(<Tree files={[file('src/an-extremely-long-file-name-for-the-tree.ts'), file('legacy/step0.py'), file('legacy/step1.py'), file('src/a.ts')]} activeFileIndex={0} />);
    const name = (path: string) => row(el, rows(el).find((p) => p?.endsWith(path))!).querySelector<HTMLElement>('[data-item-name]')!;
    const long = name('an-extremely-long-file-name-for-the-tree.ts');
    expect(long.querySelector('[data-item-name-stem]')!.textContent).toBe('an-extremely-long-file-name-for-the-t');
    expect(long.querySelector('[data-item-name-tail]')!.textContent).toBe('ree.ts');
    expect(long.textContent).toBe('an-extremely-long-file-name-for-the-tree.ts');
    expect(name('step0.py').querySelector('[data-item-name-tail]')!.textContent).toBe('ep0.py');
    expect(name('step1.py').querySelector('[data-item-name-tail]')!.textContent).toBe('ep1.py');
    expect(name('a.ts').querySelector('[data-item-name-stem]')).toBeNull();
    const target = row(el, rows(el).find((p) => p?.endsWith('tree.ts'))!);
    expect(target.getAttribute('title') ?? target.querySelector('[title]')?.getAttribute('title')).toContain('src/an-extremely-long-file-name-for-the-tree.ts');
  });

  test('each row carries its own tight counts: nothing reserved from other rows, a huge count reads 12.3k with the exact number in its tooltip', async () => {
    const el = await mount(<Tree groupByKind files={[file('src/huge.ts', 12345, 9876), file('src/small.ts', 7, 0), file('README.md', 1, 1)]} activeFileIndex={0} />);
    const host = el.querySelector<HTMLElement>('[data-changes-tree]')!;
    expect(host.style.getPropertyValue('--trees-row-trail-columns')).toBe('');
    const path = (name: string) => rows(el).find((p) => p?.endsWith(name))!;
    expect(trail(el, path('huge.ts'))).toEqual(['+12.3k', '-9,876']);
    expect(trail(el, path('small.ts'))).toEqual(['+7']);
    const added = row(el, path('huge.ts')).querySelector<HTMLElement>('[data-item-section="trail"] > span')!;
    expect(added.getAttribute('title') ?? added.querySelector('[title]')?.getAttribute('title')).toBe('12,345 lines added');
  });
});

