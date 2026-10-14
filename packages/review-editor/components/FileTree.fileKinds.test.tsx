/** DOM coverage for the tree's kind blocks (Code / Tests / Generated). */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree } from './FileTree';
import type { DiffFile } from '../types';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const file = (path: string, additions = 1, deletions = 0): DiffFile => ({
  path,
  patch: `@@ -1 +1 @@\n-old\n+new`,
  additions,
  deletions,
  status: 'modified',
});

// Parse order mixes the kinds on purpose.
const mixed: DiffFile[] = [
  file('bun.lock', 5, 1),
  file('src/sync/__tests__/retry.test.ts', 20),
  file('src/sync/retry.ts', 19),
  file('README.md', 1, 1),
  file('tests/e2e/sync.spec.ts', 4, 3),
];

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
      groupByKind
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

const blocks = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[data-file-kind-block]')].map((b) => b.dataset.fileKindBlock);
const block = (el: HTMLElement, kind: string) => el.querySelector<HTMLElement>(`[data-file-kind-block="${kind}"]`)!;
const header = (el: HTMLElement, kind: string) => block(el, kind).querySelector<HTMLButtonElement>('button[aria-expanded]')!;
const rows = (el: HTMLElement) => [...el.querySelectorAll('.file-tree-item')].map((r) => r.textContent ?? '');

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('FileTree kind blocks', () => {
  test.skipIf(!hasDom)('splits a mixed change into Code, Tests, Generated; Generated starts folded', async () => {
    const el = await mount(<Tree viewedFiles={new Set(['README.md'])} />);
    expect(blocks(el)).toEqual(['code', 'test', 'generated']);

    const code = header(el, 'code');
    expect(code.getAttribute('aria-expanded')).toBe('true');
    // label, file count, viewed/total and +/-
    expect(code.textContent).toContain('Code');
    expect(code.textContent).toContain('1/2');
    expect(code.textContent).toContain('+20');
    expect(header(el, 'test').textContent).toContain('0/2');

    expect(header(el, 'generated').getAttribute('aria-expanded')).toBe('false');
    expect(block(el, 'generated').querySelector('.file-tree-item')).toBeNull();
    expect(block(el, 'test').querySelectorAll('.file-tree-item').length).toBe(2);
  });

  test.skipIf(!hasDom)('a header folds and opens its own block only', async () => {
    const el = await mount(<Tree />);
    await act(async () => header(el, 'test').click());
    expect(header(el, 'test').getAttribute('aria-expanded')).toBe('false');
    expect(block(el, 'test').querySelector('.file-tree-item')).toBeNull();
    expect(block(el, 'code').querySelectorAll('.file-tree-item').length).toBe(2);

    await act(async () => header(el, 'generated').click());
    expect(block(el, 'generated').querySelectorAll('.file-tree-item').length).toBe(1);
  });

  test.skipIf(!hasDom)('one kind, or the switch off, keeps the plain tree', async () => {
    const codeOnly = [file('src/a.ts'), file('src/b.ts')];
    let el = await mount(<Tree files={codeOnly} activeFileIndex={0} />);
    expect(blocks(el)).toEqual([]);
    expect(rows(el).length).toBe(2);
    await act(async () => root?.unmount());
    host?.remove();

    el = await mount(<Tree groupByKind={false} />);
    expect(blocks(el)).toEqual([]);
    expect(rows(el).length).toBe(5);
  });

  test.skipIf(!hasDom)('j/k follow the block order and open a folded block they land in', async () => {
    const selected: number[] = [];
    function Controlled() {
      const [active, setActive] = React.useState(2);
      return (
        <Tree
          activeFileIndex={active}
          onSelectFile={(index) => {
            selected.push(index);
            setActive(index);
          }}
        />
      );
    }
    const el = await mount(<Controlled />);
    const press = (key: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key })));
    // Each block in tree order (folders first): Code, then Tests, then Generated.
    await press('Home');
    await press('j');
    await press('j');
    await press('j');
    await press('j');
    expect(selected.map((i) => mixed[i].path)).toEqual([
      'src/sync/retry.ts',
      'README.md',
      'src/sync/__tests__/retry.test.ts',
      'tests/e2e/sync.spec.ts',
      'bun.lock',
    ]);
    expect(header(el, 'generated').getAttribute('aria-expanded')).toBe('true');
  });

  test.skipIf(!hasDom)('a file that becomes active by any route opens its folded block', async () => {
    // index 0 is bun.lock (Generated). A new file list never opens a block.
    const el = await mount(<Tree activeFileIndex={0} />);
    expect(header(el, 'generated').getAttribute('aria-expanded')).toBe('false');

    // An annotation or search jump: the app changes the active file.
    await act(async () => root?.render(<Tree activeFileIndex={2} />));
    await act(async () => header(el, 'test').click());
    await act(async () => root?.render(<Tree activeFileIndex={1} />));
    expect(header(el, 'test').getAttribute('aria-expanded')).toBe('true');

    // The all-files scroll highlight reaching bun.lock.
    await act(async () => root?.render(<Tree activeFileIndex={1} isAllFilesActive scrollHighlightIndex={2} />));
    expect(header(el, 'generated').getAttribute('aria-expanded')).toBe('false');
    await act(async () => root?.render(<Tree activeFileIndex={1} isAllFilesActive scrollHighlightIndex={0} />));
    expect(header(el, 'generated').getAttribute('aria-expanded')).toBe('true');
  });

  test.skipIf(!hasDom)('hide-viewed hides a block whose files are all hidden, header included', async () => {
    const viewed = new Set(['src/sync/__tests__/retry.test.ts', 'tests/e2e/sync.spec.ts']);
    const el = await mount(<Tree hideViewedFiles viewedFiles={viewed} />);
    expect(blocks(el)).toEqual(['code', 'generated']);
    // The active file stays shown, so its block does too.
    await act(async () => root?.render(<Tree hideViewedFiles viewedFiles={viewed} activeFileIndex={4} />));
    expect(blocks(el)).toEqual(['code', 'test', 'generated']);
  });

  test.skipIf(!hasDom)('the Tree controls popover carries the Group by kind switch', async () => {
    let toggles = 0;
    const el = await mount(
      <Tree onToggleShowViewedControls={() => {}} onToggleShowStageControls={() => {}} onToggleGroupByKind={() => toggles++} />,
    );
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Tree controls"]')!.click());
    const toggle = document.querySelector<HTMLButtonElement>('[data-review-group-by-kind-toggle]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle!.click());
    expect(toggles).toBe(1);
  });
});
