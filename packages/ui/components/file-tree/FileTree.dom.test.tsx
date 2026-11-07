/**
 * FileTree in a DOM (DOM_TESTS=1): what a keyboard and screen reader user
 * meets. The tree is one tab stop pointing at the focused row with
 * aria-activedescendant; the keys are VS Code's tree keys; type-ahead finds
 * names; revealPath opens the folders above a path and scrolls to it; the open
 * file stays the selected row while folders above it open and close; only a
 * window of rows is ever mounted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree, type FileTreeHandle, type FileTreeProps } from './FileTree';
import { FileTreeStore } from './store';

const hasDom = typeof document !== 'undefined';

const PATHS = [
  'src/components/Button.tsx',
  'src/components/deep/Widget.tsx',
  'src/index.ts',
  'src/beta.ts',
  'src/bravo.ts',
  'docs/guide.md',
  'README.md',
  'babel.config.js',
  'bun.lock',
];
// Folders first, natural order: docs/, src/, babel.config.js, bun.lock, README.md

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(props: Partial<FileTreeProps> & { tree: FileTreeStore }, handle?: React.Ref<FileTreeHandle>) {
  host = document.createElement('div');
  host.style.height = '400px';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<FileTree ref={handle} {...props} />));
}

async function rerender(props: Partial<FileTreeProps> & { tree: FileTreeStore }) {
  await act(async () => root!.render(<FileTree {...props} />));
}

const treeEl = () => document.querySelector<HTMLElement>('[role="tree"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row));
const shown = () => items().map((el) => el.dataset.path);
const item = (path: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
const focusedPath = () => {
  const id = treeEl().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.dataset.path ?? null : null;
};

async function press(key: string) {
  await act(async () => {
    treeEl().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

async function focusTree() {
  await act(async () => treeEl().focus());
}

describe.if(hasDom)('FileTree', () => {
  test('rows carry level, set size, position and expanded state', async () => {
    const tree = new FileTreeStore(PATHS, { expanded: ['src'] });
    await mount({ tree });
    expect(shown()).toEqual(['docs', 'src', 'src/components', 'src/beta.ts', 'src/bravo.ts', 'src/index.ts', 'babel.config.js', 'bun.lock', 'README.md']);
    const src = item('src')!;
    expect([src.getAttribute('aria-level'), src.getAttribute('aria-setsize'), src.getAttribute('aria-posinset'), src.getAttribute('aria-expanded')]).toEqual(['1', '5', '2', 'true']);
    const beta = item('src/beta.ts')!;
    expect([beta.getAttribute('aria-level'), beta.getAttribute('aria-setsize'), beta.getAttribute('aria-posinset'), beta.hasAttribute('aria-expanded')]).toEqual(['2', '4', '2', false]);
    expect(item('docs')!.getAttribute('aria-expanded')).toBe('false');
    expect(treeEl().tabIndex).toBe(0);
  });

  test('Up and Down move focus; Right opens a folder then enters it; Left closes it then goes to the parent', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree });
    await focusTree();
    expect(focusedPath()).toBe('docs');
    await press('ArrowDown');
    expect(focusedPath()).toBe('src');
    await press('ArrowRight');
    expect(item('src')!.getAttribute('aria-expanded')).toBe('true');
    expect(focusedPath()).toBe('src');
    await press('ArrowRight');
    expect(focusedPath()).toBe('src/components');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(focusedPath()).toBe('src/components/deep');
    await press('ArrowLeft');
    expect(focusedPath()).toBe('src/components');
    await press('ArrowLeft');
    expect(item('src/components')!.getAttribute('aria-expanded')).toBe('false');
    await press('ArrowLeft');
    expect(focusedPath()).toBe('src');
    await press('ArrowUp');
    expect(focusedPath()).toBe('docs');
    await press('ArrowUp');
    expect(focusedPath()).toBe('docs');
  });

  test('Home, End, PageDown and PageUp', async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`);
    const tree = new FileTreeStore(paths);
    await mount({ tree, rowHeight: 20 });
    await focusTree();
    await press('End');
    expect(focusedPath()).toBe('f199.ts');
    await press('Home');
    expect(focusedPath()).toBe('f000.ts');
    await press('PageDown');
    const after = Number(document.getElementById(treeEl().getAttribute('aria-activedescendant')!)!.dataset.row);
    expect(after).toBeGreaterThan(1);
    await press('PageUp');
    expect(focusedPath()).toBe('f000.ts');
  });

  test('Enter and Space open a file and toggle a folder; a click does the same', async () => {
    const opened: string[] = [];
    const tree = new FileTreeStore(PATHS);
    await mount({ tree, onOpen: (p) => opened.push(p) });
    await focusTree();
    await press('Enter');
    expect(item('docs')!.getAttribute('aria-expanded')).toBe('true');
    await press('ArrowDown');
    await press(' ');
    expect(opened).toEqual(['docs/guide.md']);
    await act(async () => item('README.md')!.click());
    expect(opened).toEqual(['docs/guide.md', 'README.md']);
    expect(focusedPath()).toBe('README.md');
    await act(async () => item('src')!.click());
    expect(item('src')!.getAttribute('aria-expanded')).toBe('true');
  });

  test('type-ahead: a prefix finds the next name, one letter again and again cycles', async () => {
    const tree = new FileTreeStore(PATHS, { expanded: ['src'] });
    await mount({ tree });
    await focusTree();
    await press('b');
    expect(focusedPath()).toBe('src/beta.ts');
    await press('b');
    expect(focusedPath()).toBe('src/bravo.ts');
    await press('b');
    expect(focusedPath()).toBe('babel.config.js');
    await new Promise((r) => setTimeout(r, 750));
    await press('b');
    await press('u');
    expect(focusedPath()).toBe('bun.lock');
    await new Promise((r) => setTimeout(r, 750));
    await press('r');
    expect(focusedPath()).toBe('README.md');
    await press('x');
    expect(focusedPath()).toBe('README.md');
  });

  test('revealPath opens the folders above a path, scrolls to it and focuses it', async () => {
    const paths = [...Array.from({ length: 500 }, (_, i) => `a/f${i}.ts`), 'z/deep/er/target.ts'];
    const tree = new FileTreeStore(paths, { expanded: ['a'] });
    const handle = createRef<FileTreeHandle>();
    await mount({ tree, rowHeight: 20 }, handle);
    expect(item('z/deep/er/target.ts')).toBeNull();
    await act(async () => {
      expect(handle.current!.revealPath('z/deep/er/target.ts')).toBe(true);
    });
    const target = item('z/deep/er/target.ts');
    expect(target).not.toBeNull();
    expect(tree.isExpanded('z/deep/er')).toBe(true);
    expect(treeEl().scrollTop).toBeGreaterThan(0);
    await focusTree();
    expect(focusedPath()).toBe('z/deep/er/target.ts');
    expect(handle.current!.revealPath('nope/missing.ts')).toBe(false);
  });

  test('the open file stays the one selected row while folders above it open and close', async () => {
    const tree = new FileTreeStore(PATHS, { expanded: ['src'] });
    await mount({ tree, selectedPath: 'src/index.ts' });
    const selected = () => [...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map((el) => (el as HTMLElement).dataset.path);
    expect(selected()).toEqual(['src/index.ts']);
    await act(async () => { tree.expand('docs'); });
    expect(selected()).toEqual(['src/index.ts']);
    expect(item('src/index.ts')!.dataset.row).toBe('6');
    await act(async () => { tree.expand('src/components'); });
    expect(selected()).toEqual(['src/index.ts']);
    await act(async () => { tree.collapse('docs'); });
    expect(selected()).toEqual(['src/index.ts']);
    // docs closed (-1), components open (+2: deep/ and Button.tsx)
    expect(item('src/index.ts')!.dataset.row).toBe('7');
    await rerender({ tree, selectedPath: 'README.md' });
    expect(selected()).toEqual(['README.md']);
  });

  test('focus inside a folder that closes moves to that folder', async () => {
    const tree = new FileTreeStore(PATHS, { expanded: ['src', 'src/components'] });
    await mount({ tree });
    await focusTree();
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(focusedPath()).toBe('src/components/deep');
    await act(async () => { tree.collapseAll(); });
    expect(focusedPath()).toBe('src');
  });

  test('a large expanded tree mounts only a window of rows', async () => {
    const paths = Array.from({ length: 20000 }, (_, i) => `d${i % 50}/sub${i % 7}/file${i}.ts`);
    const tree = new FileTreeStore(paths);
    await act(async () => { tree.expandAll(); });
    await mount({ tree, rowHeight: 22 });
    expect(tree.model.rowCount).toBe(20000 + 50 + 350);
    expect(items().length).toBeLessThanOrEqual(30 + 2 * 10 + 1);
    await focusTree();
    await press('End');
    expect(focusedPath()).toBe('d49/sub6/file19949.ts');
    expect(items().length).toBeLessThanOrEqual(30 + 2 * 10 + 1);
  });

  test('live adds and removes show at once; a folder holding a change shows a dot while collapsed', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree, labels: { markedBelow: 'has changes' } });
    await act(async () => { tree.add('src/zeta.ts'); tree.remove('docs'); });
    expect(item('docs')).toBeNull();
    await act(async () => { tree.setBadges(new Map([['src/zeta.ts', { letter: 'U', tone: 'untracked' as const }]])); });
    expect(item('src')!.querySelector('[role="img"][aria-label="has changes"]')).not.toBeNull();
    await act(async () => { tree.expand('src'); });
    expect(item('src')!.querySelector('[role="img"][aria-label="has changes"]')).toBeNull();
    expect(item('src/zeta.ts')!.textContent).toContain('U');
  });

  test('focus is kept by path: a removed row hands focus to its neighbour, and a later add does not take it', async () => {
    const tree = new FileTreeStore(PATHS, { expanded: ['src'] });
    await mount({ tree });
    await focusTree();
    await press('End');
    expect(focusedPath()).toBe('README.md');
    await act(async () => { tree.remove('README.md'); });
    expect(focusedPath()).toBe('bun.lock');
    // The freed id is reused by the next node made: focus must not follow it.
    await act(async () => { tree.add('src/zzz-new.ts'); });
    expect(focusedPath()).toBe('bun.lock');
    await act(async () => { tree.add('README.md'); });
    expect(focusedPath()).toBe('bun.lock');
  });

  test('under a filter, a live add does not move focus', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree });
    await act(async () => { tree.setFilter('b'); });
    await focusTree();
    await press('b');
    await press('r');
    expect(focusedPath()).toBe('src/bravo.ts');
    await act(async () => { tree.add('a-new/ab.ts'); });
    expect(shown()).toContain('a-new/ab.ts');
    expect(focusedPath()).toBe('src/bravo.ts');
    await act(async () => { tree.remove('src/beta.ts'); });
    expect(focusedPath()).toBe('src/bravo.ts');
  });

  test('the focused row stays in the DOM when it is scrolled far out of view', async () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `f${String(i).padStart(4, '0')}.ts`);
    const tree = new FileTreeStore(paths);
    await mount({ tree, rowHeight: 20 });
    await focusTree();
    expect(focusedPath()).toBe('f0000.ts');
    await act(async () => {
      treeEl().scrollTop = 30000;
      treeEl().dispatchEvent(new Event('scroll'));
    });
    expect(item('f0000.ts')).not.toBeNull();
    expect(focusedPath()).toBe('f0000.ts');
    expect(item('f1500.ts')).not.toBeNull();
  });

  test('a sliced build shows the top-level rows first, then the whole tree; reveal waits for it', async () => {
    const paths = [...Array.from({ length: 120_000 }, (_, i) => `big/d${i % 60}/f${i}.ts`), 'small/a.ts', 'top.md'];
    const tree = new FileTreeStore(paths, { sliced: true });
    expect(tree.loading).toBe(true);
    const handle = createRef<FileTreeHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<FileTree ref={handle} tree={tree} />));
    expect(tree.loading).toBe(true);
    expect(shown()).toEqual(['big', 'small', 'top.md']);
    act(() => {
      expect(handle.current!.revealPath('big/d7/f5947.ts')).toBe(true);
    });
    await act(async () => { await tree.whenReady(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(tree.loading).toBe(false);
    expect(tree.isExpanded('big/d7')).toBe(true);
    expect(item('big/d7/f5947.ts')).not.toBeNull();
    await focusTree();
    expect(focusedPath()).toBe('big/d7/f5947.ts');
  });

  test('folders show the +/- sums of their files and the filter keeps matches fully open', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree });
    await act(async () => {
      tree.setBadges(new Map([
        ['src/index.ts', { additions: 3, deletions: 1, count: 2 }],
        ['src/components/Button.tsx', { additions: 4, count: 1 }],
      ]));
    });
    expect(item('src')!.textContent).toContain('+7');
    expect(item('src')!.textContent).toContain('-1');
    await act(async () => { tree.setFilter('widget'); });
    expect(shown()).toEqual(['src', 'src/components', 'src/components/deep', 'src/components/deep/Widget.tsx']);
    await act(async () => { tree.setFilter(''); });
    expect(item('src')!.getAttribute('aria-expanded')).toBe('false');
  });

  test('removing the folder that holds the focused row keeps focus inside the nearest folder left', async () => {
    const paths = ['src/a/one.ts', 'src/a/two.ts', 'src/zz.ts', 'src/b.ts', 'zz-after.md', 'aa-before.md'];
    const tree = new FileTreeStore(paths, { expanded: ['src', 'src/a'] });
    await mount({ tree });
    await focusTree();
    await press('o');
    expect(focusedPath()).toBe('src/a/one.ts');
    // The row now in src/a/one.ts's place is still inside src: it gets focus.
    await act(async () => { tree.remove('src/a'); });
    expect(focusedPath()).toBe('src/zz.ts');
  });

  test('removing the folder of the focused row, with nothing left below it in the parent, focuses the parent', async () => {
    const tree = new FileTreeStore(['src/', 'src/a/one.ts', 'zz.md'], { expanded: ['src', 'src/a'] });
    await mount({ tree });
    await focusTree();
    await press('o');
    expect(focusedPath()).toBe('src/a/one.ts');
    // The row now in its place is zz.md, outside src: src, the nearest folder left, takes focus.
    await act(async () => { tree.remove('src/a'); });
    expect(focusedPath()).toBe('src');
  });

  test('revealPath refuses a path the filter hides, and opens nothing', async () => {
    const tree = new FileTreeStore(PATHS);
    const handle = createRef<FileTreeHandle>();
    await mount({ tree }, handle);
    await act(async () => { tree.setFilter('guide'); });
    let result = true;
    await act(async () => { result = handle.current!.revealPath('src/components/deep/Widget.tsx'); });
    expect(result).toBe(false);
    await act(async () => { tree.setFilter(''); });
    expect(tree.isExpanded('src')).toBe(false);
  });

  test('a filter set while the index builds shows "Indexing" and no rows, then the matches', async () => {
    const paths = [...Array.from({ length: 60_000 }, (_, i) => `big/d${i % 60}/f${i}.ts`), 'docs/guide.md', 'top.md'];
    const tree = new FileTreeStore(paths, { sliced: true });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<FileTree tree={tree} labels={{ indexing: 'Indexing the folder' }} />));
    act(() => { tree.setFilter('guide'); });
    expect(items()).toHaveLength(0);
    const busy = treeEl();
    expect(busy.getAttribute('aria-busy')).toBe('true');
    const described = document.getElementById(busy.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe('Indexing the folder');
    await act(async () => { await tree.whenReady(); });
    expect(shown()).toEqual(['docs', 'docs/guide.md']);
    expect(treeEl().hasAttribute('aria-describedby')).toBe(false);
    expect(treeEl().hasAttribute('aria-busy')).toBe(false);
  });

  test('file and folder icons start at the same inline offset, and indent is logical', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree });
    const dir = item('src')!;
    const file = item('README.md')!;
    expect(dir.style.paddingInlineStart).toBe(file.style.paddingInlineStart);
    expect(dir.style.paddingLeft).toBe('');
    // Both rows hold a 12 px twistie column before the icon: a chevron, or an empty span.
    expect(dir.children[0]!.tagName.toLowerCase()).toBe('svg');
    expect(file.children[0]!.className).toContain('w-3');
  });

  test('a locked row shows a lock, takes focus, and Enter or a click calls onBlocked, never onOpen', async () => {
    const opened: string[] = [];
    const blocked: string[] = [];
    const tree = new FileTreeStore(['.env', 'app/', 'app/x.ts', 'z.md']);
    tree.setBadges(new Map([
      ['.env', { locked: 'Secrets are not shown' }],
      ['app', { locked: 'Outside the project' }],
    ]));
    await mount({ tree, onOpen: (p) => opened.push(p), onBlocked: (p) => blocked.push(p) });
    const env = item('.env')!;
    expect(env.dataset.locked).toBeDefined();
    expect(env.getAttribute('aria-disabled')).toBe('true');
    expect(env.textContent).toContain('Secrets are not shown');
    await focusTree();
    await press('ArrowDown');
    expect(focusedPath()).toBe('.env');
    await press('Enter');
    await act(async () => env.click());
    // A locked folder stays shut, by Enter, ArrowRight or *.
    await press('ArrowUp');
    expect(focusedPath()).toBe('app');
    await press('Enter');
    await press('ArrowRight');
    await press('*');
    expect(tree.isExpanded('app')).toBe(false);
    expect(opened).toEqual([]);
    expect(blocked).toEqual(['.env', '.env', 'app', 'app']);
    await act(async () => item('z.md')!.click());
    expect(opened).toEqual(['z.md']);
  });

  test('a dimmed row is marked dimmed; a renderIcon that returns null draws no icon', async () => {
    const tree = new FileTreeStore(['dist/out.js', 'a.ts']);
    tree.setBadges(new Map([['dist', { dimmed: true }]]));
    await mount({ tree, renderIcon: () => null });
    expect(item('dist')!.dataset.dimmed).toBeDefined();
    expect(item('a.ts')!.dataset.dimmed).toBeUndefined();
    // The twistie column, then the name: nothing between.
    const file = item('a.ts')!;
    expect(file.children[0]!.className).toContain('w-3');
    expect(file.children[1]!.textContent).toBe('a.ts');
  });

  test('a lazy folder shows a spinner only once its load is slow, then its children', async () => {
    let answer: (v: string[]) => void = () => {};
    const tree = new FileTreeStore(['src/'], {
      loadChildren: () => new Promise<string[]>((r) => { answer = r; }),
      loadingDelayMs: 30,
    });
    await mount({ tree, labels: { loading: 'Loading' } });
    await focusTree();
    await press('ArrowRight');
    expect(document.querySelector('[data-ft-loading]')).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(item('src')!.querySelector('[data-ft-loading]')?.getAttribute('aria-label')).toBe('Loading');
    await act(async () => { answer(['src/a.ts']); await new Promise((r) => setTimeout(r, 0)); });
    expect(document.querySelector('[data-ft-loading]')).toBeNull();
    expect(shown()).toEqual(['src', 'src/a.ts']);
  });

  test('the keys the tree uses are taken on the tree, so a page shortcut (j, k, /) does not also fire', async () => {
    const tree = new FileTreeStore(PATHS);
    await mount({ tree });
    await focusTree();
    const seen: string[] = [];
    const onDoc = (e: KeyboardEvent) => { if (!e.defaultPrevented) seen.push(e.key); };
    document.addEventListener('keydown', onDoc);
    try {
      for (const key of ['j', 'k', '/', 'ArrowDown', '*']) await press(key);
    } finally {
      document.removeEventListener('keydown', onDoc);
    }
    expect(seen).toEqual([]);
  });

  test('a coarse pointer gets 44 px rows', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === '(pointer: coarse)',
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const tree = new FileTreeStore(PATHS);
      await mount({ tree });
      expect(item('src')!.style.height).toBe('44px');
      expect(item('README.md')!.style.top).toBe(`${4 * 44}px`);
    } finally {
      window.matchMedia = real;
    }
  });
});
