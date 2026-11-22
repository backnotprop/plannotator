import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import { ChangesTreeView, type ChangesTreeHandle } from './ChangesTreeView';
import { buildFileTree } from '../utils/buildFileTree';
import { markFirstCodePainted } from '../utils/firstCodePaint';

markFirstCodePainted();
import type { DiffFile } from '../types';
import type { SinceBaseSections } from '@plannotator/shared/types';
import { key, searchInput, typeInSearch } from './treeKeys.testing';

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
  test('group by kind: Code, Docs, Tests, Generated in that order, Generated folded, folder sums beside folders', async () => {
    const el = await mount(<Tree groupByKind />);
    expect(rows(el)).toEqual([
      'Code/',
      'Code/retry.ts',
      'Docs/',
      'Docs/README.md',
      'Tests/',
      'Tests/src\u2215sync\u2215__tests__/',
      'Tests/src\u2215sync\u2215__tests__/retry.test.ts',
      'Tests/tests\u2215e2e/',
      'Tests/tests\u2215e2e/sync.spec.ts',
      'Generated/',
    ]);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('false');
    expect(trail(el, 'Code/')).toEqual(['0/1', '+19']);
    expect(trail(el, 'Code/retry.ts')).toEqual(['+19']);
    expect(selected(el)).toEqual(['Code/retry.ts']);
  });

  test('j/k follow the grouped order and open the folded group they land in', async () => {
    const onSelectFile = mock((_index: number) => {});
    const el = await mount(<Tree groupByKind activeFileIndex={4} onSelectFile={onSelectFile} />);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(onSelectFile).toHaveBeenLastCalledWith(0);
    await rerender(<Tree groupByKind activeFileIndex={0} onSelectFile={onSelectFile} />);
    expect(row(el, 'Generated/').getAttribute('aria-expanded')).toBe('true');
    expect(selected(el)).toEqual(['Generated/bun.lock']);
  });

  test('rows carry no viewed or git add button; a viewed file is dimmed and its group counts it', async () => {
    const el = await mount(
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} stagedFiles={new Set(['src/staged.ts'])} viewedFiles={new Set(['src/edited.ts'])} groupBy="status" onSelectGroupBy={() => {}} statusGroupingAvailable />,
    );
    expect(rowEls(el).some((r) => r.querySelector('[data-item-part-id]'))).toBe(false);
    expect(row(el, 'Unstaged/edited.ts').dataset.itemMuted).toBe('true');
    expect(row(el, 'Staged/staged.ts').dataset.itemMuted).toBeUndefined();
    expect(trail(el, 'Unstaged/')[0]).toBe('1/1');
  });

  test('a file row reads name, its comment count, its numbers and its status letter at the right edge', async () => {
    const annotations = [{ filePath: 'src/edited.ts' }, { filePath: 'src/edited.ts' }] as React.ComponentProps<typeof FileTree>['annotations'];
    const el = await mount(<Tree files={working} activeFileIndex={0} sinceBaseSections={sections} annotations={annotations} />);
    const sectionsOf = (path: string) =>
      [...row(el, path).querySelectorAll<HTMLElement>('[data-item-section]')]
        .map((section) => section.dataset.itemSection)
        .filter((name) => name === 'lead' || name === 'content' || name === 'trail' || name === 'git');
    expect(sectionsOf('edited.ts')).toEqual(['content', 'trail', 'git']);
    expect(row(el, 'edited.ts').querySelector('[data-item-section="git"]')?.textContent).toBe('M');
    expect(row(el, 'new.ts').querySelector('[data-item-section="git"]')?.textContent).toBe('U');
    expect(trail(el, 'edited.ts')).toEqual(['2', '+3', '−2']);
    expect(row(el, 'edited.ts').querySelector('[title="2 comments"]')).not.toBeNull();
    expect(trail(el, 'committed.ts')).toEqual(['+1']);
  });

  test('a staged file carries a Staged mark before its numbers, redrawn as it is staged and unstaged (#3683)', async () => {
    // One viewed set and one annotations array across the rerenders, so only
    // the staged set changes: the rows must redraw for it alone.
    const viewedFiles = new Set<string>();
    const annotations: NonNullable<TreeProps['annotations']> = [];
    const tree = (staged: string[], extra: TreeProps = {}) => (
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} viewedFiles={viewedFiles} annotations={annotations} stagedFiles={new Set(staged)} {...extra} />
    );
    const mark = (el: HTMLElement, path: string) => row(el, path).querySelector<HTMLElement>('[data-item-section="trail"] [title="Staged"]');
    const el = await mount(tree(['src/staged.ts']));
    expect(mark(el, 'staged.ts')).not.toBeNull();
    // A mark, not a button.
    expect(mark(el, 'staged.ts')!.getAttribute('role')).toBeNull();
    expect(trail(el, 'staged.ts')).toEqual(['\u25cf', '+1']);
    expect(mark(el, 'edited.ts')).toBeNull();
    await rerender(tree(['src/edited.ts']));
    expect(mark(el, 'edited.ts')).not.toBeNull();
    expect(mark(el, 'staged.ts')).toBeNull();
    // Off with the header's Git add button, as dimming is off with the Viewed button.
    await rerender(tree(['src/edited.ts'], { showStageControls: false }));
    expect(mark(el, 'edited.ts')).toBeNull();
  });

  test('grouped by git status, the Staged group says it and its rows carry no mark', async () => {
    const el = await mount(
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} stagedFiles={new Set(['src/staged.ts'])} groupBy="status" onSelectGroupBy={() => {}} statusGroupingAvailable />,
    );
    expect(rows(el)).toContain('Staged/staged.ts');
    expect(row(el, 'Staged/staged.ts').querySelector('[title="Staged"]')).toBeNull();
  });

  test('a renamed file names its old path then its new path on hover', async () => {
    const el = await mount(<Tree files={[{ ...file('docs/setup.md'), status: 'renamed', oldPath: 'docs/old-setup.md' }, file('src/a.ts')]} activeFileIndex={1} />);
    const path = rows(el).find((p) => p?.endsWith('setup.md'))!;
    expect(row(el, path).getAttribute('title')).toBe('docs/old-setup.md → docs/setup.md');
  });

  test('hide viewed files drops viewed rows but keeps the open one', async () => {
    const files = [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')];
    const el = await mount(<Tree files={files} activeFileIndex={0} viewedFiles={new Set(['src/a.ts', 'src/b.ts'])} hideViewedFiles />);
    const names = rows(el).filter((p) => !p?.endsWith('/')).map((p) => p?.split('/').pop());
    expect(names).toEqual(['a.ts', 'c.ts']);
  });

  test('double-click keeps a file open; right-click offers the copy items', async () => {
    const onDoubleClickFile = mock((_index: number) => {});
    const el = await mount(<Tree files={[file('src/a.ts'), file('src/b.ts')]} activeFileIndex={0} onDoubleClickFile={onDoubleClickFile} repoRoot="/repo" />);
    const b = rows(el).find((p) => p?.endsWith('b.ts'))!;
    await act(async () => row(el, b).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })));
    expect(onDoubleClickFile).toHaveBeenCalledWith(1);
    await act(async () => row(el, b).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2, clientX: 10, clientY: 10 })));
    await settle();
    const items = [...document.querySelectorAll('.review-tree-menu [role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(['Copy path', 'Copy filename', 'Copy full path']);
  });

  test('typing in the search box filters and opens nothing; Enter opens the match; arrows from the box open as they move', async () => {
    const onSelectFile = mock((_index: number) => {});
    const files = [file('src/alpha.ts'), file('src/beta.ts'), file('src/gamma.ts'), file('src/gamut.ts')];
    const el = await mount(<Tree files={files} activeFileIndex={0} onSelectFile={onSelectFile} />);
    const host = el.querySelector('[data-changes-tree]')!;
    await typeInSearch(host, 'gam');
    expect(searchInput(host).value).toBe('gam');
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(rows(el).some((p) => p?.endsWith('beta.ts'))).toBe(false);
    await act(async () => key(searchInput(host), 'ArrowDown'));
    await settle();
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    await act(async () => key(searchInput(host), 'Enter'));
    await settle();
    expect(onSelectFile.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(2);
  });

  test('search matches the real path: a group label adds nothing, a merged folder path finds its files', async () => {
    const files = [file('src/code/editor.ts'), file('src/app.ts'), file('lib/deep/util.ts'), file('README.md')];
    const el = await mount(<Tree groupByKind files={files} activeFileIndex={3} />);
    const host = el.querySelector('[data-changes-tree]')!;
    const found = () => rows(el).filter((p) => p && !p.endsWith('/')).map((p) => p!.split(/[/\u2215]/).pop());
    const clear = () => act(async () => {
      searchInput(host).value = '';
      searchInput(host).dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    });
    await typeInSearch(host, 'code');
    expect(found()).toEqual(['editor.ts']);
    await clear();
    await typeInSearch(host, 'lib/deep');
    expect(found()).toEqual(['util.ts']);
  });

  test('a letter on a focused row goes to the page, not to a search; Escape in an empty search box stays in the tree', async () => {
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => heard.push(event.key);
    window.addEventListener('keydown', listen);
    try {
      const el = await mount(<Tree files={[file('src/a.ts'), file('src/b.ts')]} activeFileIndex={0} />);
      const host = el.querySelector('[data-changes-tree]')!;
      const first = rowEls(el).find((r) => r.dataset.itemType === 'file')!;
      await act(async () => first.focus());
      await act(async () => key(first, 'v'));
      await settle();
      expect(heard).toEqual(['v']);
      expect(host.shadowRoot!.querySelector<HTMLElement>('[data-file-tree-search-container]')!.dataset.open).toBe('false');
      await act(async () => searchInput(host).focus());
      await act(async () => key(searchInput(host), 'Escape'));
      expect(heard).toEqual(['v']);
      expect(host.shadowRoot!.activeElement).not.toBe(searchInput(host));
    } finally {
      window.removeEventListener('keydown', listen);
    }
  });

  test('Escape clears the search and keeps the box; Escape on the empty box lands on the current row, not the page', async () => {
    const el = await mount(<Tree files={[file('src/a.ts'), file('src/b.ts')]} activeFileIndex={1} />);
    const host = el.querySelector('[data-changes-tree]')!;
    await typeInSearch(host, 'b');
    await act(async () => key(searchInput(host), 'Escape'));
    await settle();
    expect(searchInput(host).value).toBe('');
    expect(shadow(el).activeElement).toBe(searchInput(host));
    await act(async () => key(searchInput(host), 'Escape'));
    await settle();
    expect(document.activeElement === host).toBe(true);
    expect(shadow(el).activeElement?.getAttribute('data-item-path')).toEndWith('b.ts');
  });

  test('after a search is cleared, a click on a row moves focus to it and arrows walk the tree', async () => {
    const el = await mount(<Tree files={[file('src/alpha.ts'), file('src/beta.ts'), file('src/gamma.ts')]} activeFileIndex={0} />);
    const host = el.querySelector('[data-changes-tree]')!;
    await typeInSearch(host, 'beta');
    await act(async () => key(searchInput(host), 'Enter'));
    await settle();
    await act(async () => {
      searchInput(host).value = '';
      searchInput(host).dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    });
    await settle();
    const target = rowEls(el).find((r) => r.dataset.itemPath?.endsWith('alpha.ts'))!;
    await act(async () => {
      const down = new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(down);
      if (!down.defaultPrevented) target.focus();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    });
    await settle();
    expect(shadow(el).activeElement?.getAttribute('data-item-path')).toBe(target.dataset.itemPath!);
    await act(async () => key(shadow(el).activeElement!, 'ArrowDown'));
    await settle();
    expect(shadow(el).activeElement?.getAttribute('data-item-path')).toEndWith('beta.ts');
  });

  test('group by git status: a file staged from its header moves to Staged', async () => {
    const tree = (staged: string[]) => (
      <Tree files={working} activeFileIndex={0} sinceBaseSections={sections} stagedFiles={new Set(staged)} groupBy="status" onSelectGroupBy={() => {}} statusGroupingAvailable />
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
    expect(onSelectFile.mock.calls[0]?.[0]).toBe(2);
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

  test('a huge count reads 12.3k with the exact number in its tooltip', async () => {
    const el = await mount(<Tree groupByKind files={[file('src/huge.ts', 12345, 9876), file('src/small.ts', 7, 0), file('README.md', 1, 1)]} activeFileIndex={0} />);
    const path = (name: string) => rows(el).find((p) => p?.endsWith(name))!;
    expect(trail(el, path('huge.ts'))).toEqual(['+12.3k', '\u22129,876']);
    expect(trail(el, path('small.ts'))).toEqual(['+7']);
    const added = row(el, path('huge.ts')).querySelector<HTMLElement>('[data-item-section="trail"] > span')!;
    expect(added.getAttribute('title') ?? added.querySelector('[title]')?.getAttribute('title')).toBe('12,345 lines added');
  });

  test('clicking the file that is already selected opens it, as any other row would', async () => {
    const opened: number[] = [];
    const files = [file('src/a.ts'), file('src/b.ts')];
    function Live() {
      const [active, setActive] = React.useState(0);
      return <Tree files={files} activeFileIndex={active} onSelectFile={(index: number) => { opened.push(index); setActive(index); }} />;
    }
    const el = await mount(<Live />);
    const path = rows(el).find((p) => p?.endsWith('a.ts'))!;
    expect(row(el, path).dataset.itemSelected).toBe('true');
    await act(async () => row(el, path).click());
    expect(opened).toEqual([0]);
    const other = rows(el).find((p) => p?.endsWith('b.ts'))!;
    await act(async () => row(el, other).click());
    expect(opened.at(-1)).toBe(1);
  });
});


describe.skipIf(!hasDom)('The Changes tree outside the review app', () => {
  const plain = (files: DiffFile[], props: Partial<React.ComponentProps<typeof ChangesTreeView>> = {}) => (
    <ChangesTreeView
      tree={buildFileTree(files)}
      groups={null}
      activePath={null}
      viewedFiles={new Set()}
      hiddenFiles={new Set()}
      hideViewedFiles={false}
      showViewedControls={false}
      annotationCounts={new Map()}
      onSelectFile={() => {}}
      {...props}
    />
  );

  test('files the tree cannot place get rows of their own after it, each opening its own index', async () => {
    const onSelectFile = mock((_index: number) => {});
    const files = [file('docs/index.md'), file('src/a.ts'), file('docs'), file('src/a.ts', 0, 1, 'deleted')];
    const el = await mount(plain(files.slice(0, 2), { onSelectFile, extraFiles: [{ file: files[2]!, index: 2 }, { file: files[3]!, index: 3 }] }));
    const paths = rows(el);
    expect(paths.slice(-2).map((p) => p?.replace(/\u200b/g, ''))).toEqual(['docs', 'src\u2215a.ts']);
    await act(async () => row(el, paths.at(-1)!).click());
    expect(onSelectFile.mock.calls.at(-1)?.[0]).toBe(3);
    await act(async () => row(el, paths.at(-2)!).click());
    expect(onSelectFile.mock.calls.at(-1)?.[0]).toBe(2);
  });

  test('arrowing to a row picks it as a focus move; a click picks it outright; focus() lands on the open row', async () => {
    const picks: unknown[][] = [];
    const handle = React.createRef<ChangesTreeHandle>();
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const el = await mount(plain(files, { onSelectFile: (...args: unknown[]) => void picks.push(args), handleRef: handle, activePath: 'b.ts' }));
    await act(async () => handle.current!.focus());
    await settle();
    expect(shadow(el).activeElement).toBe(row(el, 'b.ts'));
    expect(picks).toEqual([]);
    await act(async () => key(row(el, 'b.ts'), 'ArrowDown'));
    await settle();
    expect(picks).toEqual([[2, { via: 'focus' }]]);
    await act(async () => row(el, 'a.ts').click());
    await settle();
    expect(picks.slice(1)).toEqual([[0]]);
  });
});
