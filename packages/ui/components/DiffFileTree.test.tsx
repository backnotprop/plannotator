/**
 * DiffFileTree: the embeddable read-only diff tree (DOM_TESTS=1).
 *
 * Guards the host-facing contract: selection is controlled and reported by
 * path, the keyboard walks files in tree order the way the review does (and
 * only while focus is in the tree), folders open/close with ARIA state, the
 * selected file's folders open themselves, and a host re-rendering with an
 * equal file list does not reset what the reader collapsed.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffFileTree, type DiffFileTreeFile, type DiffFileTreeProps } from './DiffFileTree';

const hasDom = typeof document !== 'undefined';

const FILES: DiffFileTreeFile[] = [
  { path: 'src/components/deep/Widget.tsx', status: 'modified', additions: 1, deletions: 0 },
  { path: 'src/components/Button.tsx', status: 'added', additions: 2, deletions: 0 },
  { path: 'src/index.ts', status: 'deleted', additions: 0, deletions: 4 },
  { path: 'README.md', status: 'renamed', oldPath: 'README.old', additions: 0, deletions: 0 },
];
// Tree order: src/{components/{deep/Widget, Button}, index.ts}, README.md
const ORDER = ['src/components/deep/Widget.tsx', 'src/components/Button.tsx', 'src/index.ts', 'README.md'];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Harness(props: Partial<DiffFileTreeProps> & { initial?: string | null; onSelectSpy?: (p: string) => void }) {
  const [selected, setSelected] = useState<string | null>(props.initial ?? null);
  return (
    <DiffFileTree
      files={props.files ?? FILES}
      selectedPath={selected}
      onSelect={(p) => {
        props.onSelectSpy?.(p);
        setSelected(p);
      }}
      defaultExpanded={props.defaultExpanded}
    />
  );
}

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

const tree = () => document.querySelector<HTMLElement>('[role="tree"]')!;
const row = (path: string) => document.querySelector<HTMLButtonElement>(`[role="treeitem"][data-path="${path}"]`);
const selectedPath = () => document.querySelector('[role="treeitem"][aria-selected="true"]')?.getAttribute('data-path') ?? null;

async function key(k: string, target: HTMLElement = (document.activeElement as HTMLElement) ?? tree()): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe.if(hasDom)('DiffFileTree', () => {
  test('renders merged folders with ARIA levels and reports clicks by path', async () => {
    const spy = mock((_p: string) => undefined);
    await mount(<Harness onSelectSpy={spy} />);
    expect(row('src/components/deep')?.getAttribute('aria-level')).toBe('3');
    expect(row('src/components/deep')?.getAttribute('aria-expanded')).toBe('true');
    expect(row('README.md')?.getAttribute('aria-level')).toBe('1');

    await act(async () => row('src/index.ts')!.click());
    expect(spy).toHaveBeenCalledWith('src/index.ts');
    expect(selectedPath()).toBe('src/index.ts');
    expect(row('src/index.ts')!.className).toContain('active');
  });

  test('j/k and arrows walk files in tree order; Home/End jump; focus follows', async () => {
    await mount(<Harness initial={ORDER[0]} />);
    await act(async () => row(ORDER[0])!.focus());
    await key('j');
    expect(selectedPath()).toBe(ORDER[1]);
    await key('ArrowDown');
    expect(selectedPath()).toBe(ORDER[2]);
    expect(document.activeElement).toBe(row(ORDER[2]));
    await key('k');
    expect(selectedPath()).toBe(ORDER[1]);
    await key('End');
    expect(selectedPath()).toBe(ORDER[3]);
    await key('ArrowDown'); // already last: stays
    expect(selectedPath()).toBe(ORDER[3]);
    await key('Home');
    expect(selectedPath()).toBe(ORDER[0]);
  });

  test('ArrowDown with nothing selected picks the first file', async () => {
    await mount(<Harness />);
    await act(async () => tree().querySelector<HTMLElement>('[tabindex="0"]')!.focus());
    await key('ArrowDown');
    expect(selectedPath()).toBe(ORDER[0]);
  });

  test('keys pressed outside the tree are ignored (no window-wide shortcut)', async () => {
    const spy = mock((_p: string) => undefined);
    await mount(<Harness initial={ORDER[0]} onSelectSpy={spy} />);
    await key('j', document.body);
    expect(spy).not.toHaveBeenCalled();
  });

  test('ArrowLeft/ArrowRight close and open a folder; ArrowLeft from a file focuses its folder', async () => {
    await mount(<Harness initial="src/components/Button.tsx" />);
    await act(async () => row('src/components/Button.tsx')!.focus());
    await key('ArrowLeft');
    expect(document.activeElement).toBe(row('src/components'));
    await key('ArrowLeft');
    expect(row('src/components')!.getAttribute('aria-expanded')).toBe('false');
    expect(row('src/components/deep')).toBeNull();
    await key('ArrowRight');
    expect(row('src/components')!.getAttribute('aria-expanded')).toBe('true');
    await key('ArrowRight');
    expect(document.activeElement).toBe(row('src/components/deep'));
  });

  test('selecting a file inside a collapsed folder opens its folders', async () => {
    await mount(<Harness defaultExpanded="none" initial={null} />);
    expect(row('src/components/deep/Widget.tsx')).toBeNull();
    await act(async () => tree().querySelector<HTMLElement>('[tabindex="0"]')!.focus());
    await key('Home');
    expect(selectedPath()).toBe('src/components/deep/Widget.tsx');
    expect(document.activeElement).toBe(row('src/components/deep/Widget.tsx'));
  });

  test('an equal file list keeps folder state; a different one resets it', async () => {
    let setFiles!: (files: DiffFileTreeFile[]) => void;
    function Rerender() {
      const [files, set] = useState(FILES);
      setFiles = set;
      return <Harness files={files} />;
    }
    await mount(<Rerender />);
    await act(async () => row('src')!.click());
    expect(row('src')!.getAttribute('aria-expanded')).toBe('false');

    await act(async () => setFiles(FILES.map((file) => ({ ...file }))));
    expect(row('src')!.getAttribute('aria-expanded')).toBe('false');

    await act(async () => setFiles([...FILES, { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 }]));
    expect(row('src')!.getAttribute('aria-expanded')).toBe('true');
  });
});
