/// <reference types="bun-types" />
/**
 * Writing a diff's rows again must not throw or shift rows when something the
 * library did not draw sits among them: a node a browser extension puts among
 * the content rows or the gutter rows. Adding a comment adds an annotation
 * row, so the library writes the rows again; a throw there took the whole
 * page down, and a gutter one row behind left line numbers on the wrong rows.
 *
 * Real `@pierre/diffs-sem` (the vendored fork code review and the Inbox
 * window draw with, vendor/pierre-diffs/FORK.md), rendered into happy-dom.
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { DEFAULT_THEMES, disposeHighlighter, FileDiff, parseDiffFromFile, type DiffLineAnnotation } from '@pierre/diffs-sem';

const hasDom = typeof document !== 'undefined';

const lines = (n: number, changed: number[], word: string) =>
  Array.from({ length: n }, (_, i) => (changed.includes(i + 1) ? `const row${i + 1} = '${word}';` : `const row${i + 1} = 'same';`)).join('\n') + '\n';

const OLD = lines(12, [5, 6], 'old');
const NEW = lines(12, [5, 6], 'new');

type Layout = 'split' | 'unified';
type Column = 'gutter' | 'content';

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

/** What a row the library drew is, the same in its gutter cell and its content cell. */
function rowKind(row: Element): string {
  const index = row.getAttribute('data-line-index');
  if (index != null) return `line ${index}`;
  // A comment row: the content cell holds the comment, the gutter cell beside it is an annotation gap.
  if (row.hasAttribute('data-line-annotation') || row.getAttribute('data-gutter-buffer') === 'annotation') return 'annotation';
  if (row.hasAttribute('data-gutter-buffer') || row.hasAttribute('data-content-buffer')) return 'buffer';
  if (row.hasAttribute('data-separator')) return 'separator';
  return `other ${row.tagName}`;
}

async function mount(layout: Layout) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const fileDiff = parseDiffFromFile({ name: 'rows.ts', contents: OLD }, { name: 'rows.ts', contents: NEW });
  const instance = new FileDiff<undefined>({
    disableFileHeader: true,
    // A throw while writing rows surfaces here instead of being drawn as an error in place of the diff.
    disableErrorHandling: true,
    theme: DEFAULT_THEMES,
    diffStyle: layout,
    renderAnnotation: (annotation) => {
      const box = document.createElement('div');
      box.setAttribute('data-test-comment', String(annotation.lineNumber));
      box.textContent = 'a comment';
      return box;
    },
  });
  instance.render({ fileDiff, fileContainer: container, forceRender: true });
  const root = () => container.shadowRoot!;
  await waitFor(() => (container.shadowRoot?.querySelectorAll('[data-content] > [data-line]').length ?? 0) > 0, 'the diff rows');
  const codes = () => Array.from(root().querySelectorAll<HTMLElement>('[data-code]'));
  /** The cells of one column the library drew, in order, without the foreign nodes. */
  const drawn = (code: HTMLElement, column: Column) =>
    Array.from(code.querySelector(`:scope > [data-${column}]`)!.children).filter((child) => !child.hasAttribute('data-from-an-extension'));
  /** Each row as its gutter cell and content cell show it, for every code column. */
  const rowsOf = (code: HTMLElement) => ({ gutter: drawn(code, 'gutter').map(rowKind), content: drawn(code, 'content').map(rowKind) });
  const insertAmong = (column: Column, at: number) => {
    for (const code of codes()) {
      const cells = code.querySelector(`:scope > [data-${column}]`)!;
      cells.insertBefore(foreignNode(), cells.children[at] ?? null);
    }
  };
  const annotate = (lineNumber: number) => {
    const lineAnnotations: DiffLineAnnotation<undefined>[] = [{ side: 'additions', lineNumber }];
    instance.render({ fileDiff, lineAnnotations, forceRender: true });
  };
  const cleanUp = () => {
    instance.cleanUp();
    container.remove();
  };
  /** Whether the comment on new line `line` is drawn (comments are slotted into the light DOM). */
  const commentShown = (line: number) => container.querySelector(`[data-test-comment="${line}"]`) != null;
  return { instance, fileDiff, root, codes, rowsOf, insertAmong, annotate, commentShown, cleanUp };
}

type View = Awaited<ReturnType<typeof mount>>;

/** Every code column's gutter cells and content cells describe the same rows, in the same order. */
function expectAligned(view: View) {
  for (const code of view.codes()) {
    const { gutter, content } = view.rowsOf(code);
    expect(gutter.length, 'rows in the gutter and the content').toBe(content.length);
    expect(gutter).toEqual(content);
  }
}

describe.if(hasDom)('a diff writing its rows again with foreign nodes among them', () => {
  afterAll(async () => {
    await disposeHighlighter();
  });

  for (const layout of ['split', 'unified'] as const) {
    for (const firstWrite of [false, true]) {
      const when = firstWrite ? 'straight after the first paint' : 'after the rows were written again once';

      test(`${layout}: a node among the content rows ${when}: a comment row is added in place, nothing throws`, async () => {
        const view = await mount(layout);
        try {
          if (!firstWrite) view.annotate(3);
          view.insertAmong('content', 4);
          expect(() => view.annotate(7)).not.toThrow();
          await waitFor(() => view.commentShown(7), 'the comment drawn');
          expectAligned(view);
          // The foreign node stays where it was put.
          expect(view.root().querySelectorAll('[data-content] > [data-from-an-extension]').length).toBe(view.codes().length);
          // A plain re-render after that does not throw either, and keeps the rows in step.
          expect(() => view.instance.render({ fileDiff: view.fileDiff, forceRender: true })).not.toThrow();
          expectAligned(view);
        } finally {
          view.cleanUp();
        }
      });

      test(`${layout}: a node among the gutter rows ${when}: adding a comment row keeps line numbers on their rows`, async () => {
        const view = await mount(layout);
        try {
          if (!firstWrite) view.annotate(3);
          view.insertAmong('gutter', 2);
          expect(() => view.annotate(7)).not.toThrow();
          await waitFor(() => view.commentShown(7), 'the comment drawn');
          expectAligned(view);
          expect(view.root().querySelectorAll('[data-gutter] > [data-from-an-extension]').length).toBe(view.codes().length);
          // The comment row's gutter cell sits beside the comment, under new line 7.
          const additions = view.codes().at(-1)!;
          const { gutter, content } = view.rowsOf(additions);
          const at = content.findIndex((kind) => kind.startsWith('annotation'));
          expect(at).toBeGreaterThan(0);
          expect(gutter[at]).toBe(content[at]);
          const line7 = Array.from(additions.querySelectorAll('[data-content] > [data-line="7"]')).at(-1)!;
          expect(content[at - 1]).toBe(rowKind(line7));
        } finally {
          view.cleanUp();
        }
      });
    }
  }
});
