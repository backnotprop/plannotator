/// <reference types="bun-types" />
/**
 * A line selection in the diff library must not throw when something the
 * library did not draw sits in the diff: a node a browser extension puts
 * before the gutter column or among the gutter rows, or a selection naming a
 * line a partial diff does not show. The throw happened inside React's commit
 * (code review's "+" sets the selected lines), which took the whole page down.
 *
 * Real `@pierre/diffs-sem` (the vendored fork code review and the Inbox
 * window draw with, vendor/pierre-diffs/FORK.md), rendered into happy-dom.
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { DEFAULT_THEMES, disposeHighlighter, FileDiff, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs-sem';

const hasDom = typeof document !== 'undefined';

const lines = (n: number, changed: number[], word: string) =>
  Array.from({ length: n }, (_, i) => (changed.includes(i + 1) ? `const row${i + 1} = '${word}';` : `const row${i + 1} = 'same';`)).join('\n') + '\n';

const OLD = lines(12, [5, 6], 'old');
const NEW = lines(12, [5, 6], 'new');

type Layout = 'split' | 'unified';

async function waitFor(check: () => boolean, what: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

function foreignNode(): HTMLElement {
  const span = document.createElement('span');
  span.setAttribute('style', 'position:absolute');
  span.setAttribute('data-from-an-extension', '');
  return span;
}

async function mount(layout: Layout, fileDiff = parseDiffFromFile({ name: 'rows.ts', contents: OLD }, { name: 'rows.ts', contents: NEW })) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const instance = new FileDiff<undefined>({ disableFileHeader: true, theme: DEFAULT_THEMES, diffStyle: layout });
  instance.render({ fileDiff, fileContainer: container, forceRender: true });
  const root = () => container.shadowRoot;
  await waitFor(() => (root()?.querySelectorAll('[data-content] > [data-line]').length ?? 0) > 0, 'the diff rows');
  /** The code column that shows new lines (additions in split, the one column in unified). */
  const column = () => root()!.querySelector<HTMLElement>(layout === 'split' ? '[data-code][data-additions]' : '[data-code]')!;
  /** Whether new line `line`'s number and text are both drawn selected. */
  const selected = (line: number) => {
    const code = column();
    const content = code.querySelector(`[data-content] > [data-line="${line}"]:not([data-line-type="change-deletion"])`);
    const index = content?.getAttribute('data-line-index');
    const gutter = index == null ? null : code.querySelector(`[data-gutter] > [data-line-index="${index}"]`);
    return content?.hasAttribute('data-selected-line') === true && gutter?.hasAttribute('data-selected-line') === true;
  };
  const cleanUp = () => {
    instance.cleanUp();
    container.remove();
  };
  return { instance, root, column, selected, cleanUp };
}

describe.if(hasDom)('a line selection with foreign nodes in the diff', () => {
  afterAll(async () => {
    await disposeHighlighter();
  });

  for (const layout of ['split', 'unified'] as const) {
    test(`${layout}: a node before the gutter column does not stop the selection being drawn`, async () => {
      const view = await mount(layout);
      try {
        for (const code of view.root()!.querySelectorAll('[data-code]')) code.prepend(foreignNode());
        expect(() => view.instance.setSelectedLines({ start: 5, end: 5, side: 'additions' })).not.toThrow();
        await waitFor(() => view.selected(5), 'new line 5 drawn selected');
        expect(view.selected(4)).toBe(false);
      } finally {
        view.cleanUp();
      }
    });

    test(`${layout}: a node among the gutter rows does not stop the selection being drawn on the right rows`, async () => {
      const view = await mount(layout);
      try {
        for (const gutter of view.root()!.querySelectorAll('[data-code] > [data-gutter]')) gutter.insertBefore(foreignNode(), gutter.children[2] ?? null);
        expect(() => view.instance.setSelectedLines({ start: 7, end: 8, side: 'additions' })).not.toThrow();
        await waitFor(() => view.selected(7) && view.selected(8), 'new lines 7 and 8 drawn selected');
        expect(view.selected(6)).toBe(false);
        expect(view.selected(9)).toBe(false);
        expect(view.root()!.querySelector('[data-from-an-extension][data-selected-line]')).toBeNull();
      } finally {
        view.cleanUp();
      }
    });
  }

  for (const layout of ['split', 'unified'] as const) {
    test(`${layout}: a node before the gutter column does not empty the diff when it draws again`, async () => {
      const view = await mount(layout);
      try {
        for (const code of view.root()!.querySelectorAll('[data-code]')) code.prepend(foreignNode());
        // A new version of the file, drawn on the same instance: the library writes rows into its columns again.
        const next = parseDiffFromFile({ name: 'rows.ts', contents: OLD }, { name: 'rows.ts', contents: NEW.replace("row11 = 'same'", "row11 = 'edited'") });
        view.instance.render({ fileDiff: next, forceRender: true });
        await waitFor(() => view.column().textContent?.includes("row11 = 'edited'") === true, 'the new version drawn in the code column');
        const shown = view.column().querySelectorAll(':scope > [data-content] > [data-line]').length;
        expect(shown, 'rows in the shown content column').toBeGreaterThanOrEqual(12);
        view.instance.setSelectedLines({ start: 11, end: 11, side: 'additions' });
        await waitFor(() => view.selected(11), 'new line 11 drawn selected');
      } finally {
        view.cleanUp();
      }
    });
  }

  test('a line that can no longer be drawn does not leave the old line highlighted', async () => {
    const patch = [
      'diff --git a/rows.ts b/rows.ts',
      '--- a/rows.ts',
      '+++ b/rows.ts',
      '@@ -40,3 +40,3 @@',
      " const row40 = 'same';",
      "-const row41 = 'old';",
      "+const row41 = 'new';",
      " const row42 = 'same';",
      '',
    ].join('\n');
    const view = await mount('unified', parsePatchFiles(patch)[0]!.files[0]!);
    try {
      view.instance.setSelectedLines({ start: 41, end: 41, side: 'additions' });
      await waitFor(() => view.selected(41), 'new line 41 drawn selected');
      view.instance.setSelectedLines({ start: 10, end: 10, side: 'additions' });
      await new Promise((done) => setTimeout(done, 50));
      expect(view.root()!.querySelectorAll('[data-selected-line]').length).toBe(0);
    } finally {
      view.cleanUp();
    }
  });

  test('a selection naming a line a partial diff does not show is not drawn, and does not throw', async () => {
    const patch = [
      'diff --git a/rows.ts b/rows.ts',
      '--- a/rows.ts',
      '+++ b/rows.ts',
      '@@ -40,3 +40,3 @@',
      " const row40 = 'same';",
      "-const row41 = 'old';",
      "+const row41 = 'new';",
      " const row42 = 'same';",
      '',
    ].join('\n');
    const fileDiff = parsePatchFiles(patch)[0]!.files[0]!;
    const view = await mount('unified', fileDiff);
    try {
      expect(() => view.instance.setSelectedLines({ start: 10, end: 10, side: 'additions' })).not.toThrow();
      await new Promise((done) => setTimeout(done, 50));
      expect(view.root()!.querySelectorAll('[data-selected-line]').length).toBe(0);
      // The library still draws a selection it can find afterwards.
      expect(() => view.instance.setSelectedLines({ start: 41, end: 41, side: 'additions' })).not.toThrow();
      await waitFor(() => view.selected(41), 'new line 41 drawn selected');
    } finally {
      view.cleanUp();
    }
  });
});
