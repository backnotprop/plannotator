/**
 * A host's choices for selected lines (the Inbox's code review: Comment · Ask
 * · Show me, approval "shape-in-code-review"). What regresses if these fail:
 * - the review app (no `selectionActions`) stops opening the comment box at
 *   once on a selection;
 * - Show me or Ask reaches the host with the wrong file, lines or side, or
 *   leaves the chooser (or a comment box) open over the picture;
 * - Comment no longer opens the comment box for the same lines;
 * - the bar stops reading the lines the diff painted (the side the selection
 *   ends on, this selection's diff when another has lines painted too), or stops
 *   falling back on the pointer when it can read none.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffSelection } from './SelectionChooser';
import type { ToolbarHostHandle } from './ToolbarHost';

const hasDom = typeof document !== 'undefined';
const host = (hasDom ? await import('./ToolbarHost') : {}) as typeof import('./ToolbarHost');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

const PATCH = ['--- a/src/retry-worker.ts', '+++ b/src/retry-worker.ts', '@@ -14,3 +14,5 @@', ' a', '+b', '+c', '+d', ' e', ''].join('\n');

function mount(actions?: React.ComponentProps<typeof host.ToolbarHost>['selectionActions']) {
  const ref = createRef<ToolbarHostHandle>();
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      <host.ToolbarHost
        ref={ref}
        patch={PATCH}
        filePath="src/retry-worker.ts"
        isFocused
        onLineSelection={() => {}}
        onAddAnnotation={() => {}}
        onEditAnnotation={() => {}}
        {...(actions ? { selectionActions: actions } : {})}
      />,
    ),
  );
  act(() => ref.current!.handleLineSelectionEnd({ start: 16, end: 18, side: 'additions' }));
  return ref;
}

const chooser = () => document.querySelector<HTMLElement>('[data-selection-chooser]');
const frames = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
};

/** A diff with these lines painted, each at the place given, the way Pierre draws them. */
function paintedDiff(rows: { column?: 'additions' | 'deletions'; line: number; top: number; left: number }[]) {
  const host = document.createElement('diffs-container');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  for (const row of rows) {
    const code = document.createElement('div');
    code.setAttribute('data-code', '');
    if (row.column) code.setAttribute(`data-${row.column}`, '');
    const at = (el: HTMLElement, left: number, right: number) => {
      el.setAttribute('data-selected-line', '');
      el.getBoundingClientRect = () => ({ top: row.top, bottom: row.top + 20, left, right, width: right - left, height: 20, x: left, y: row.top, toJSON: () => ({}) });
      code.appendChild(el);
    };
    const gutter = document.createElement('div');
    gutter.setAttribute('data-column-number', String(row.line));
    at(gutter, row.left - 41, row.left);
    const text = document.createElement('div');
    text.setAttribute('data-line', String(row.line));
    // Scrolled sideways: the code's own left has gone under the gutter; the gutter has not moved.
    at(text, row.left - 200, row.left + 400);
    shadow.appendChild(code);
  }
}
const commentBox = () => document.querySelector('.review-toolbar');

describe.skipIf(!hasDom)('the selection chooser', () => {
  test('without a host\'s actions, a selection opens the comment box at once', () => {
    mount();
    expect(chooser()).toBeNull();
    expect(commentBox()).not.toBeNull();
  });

  test('Show me and Ask hand the host the lines, and close the chooser', () => {
    const shown: DiffSelection[] = [];
    const asked: DiffSelection[] = [];
    const ref = mount({ onShowMe: (s) => shown.push(s), onAsk: (s) => asked.push(s) });
    expect([...chooser()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Comment', 'Ask', 'Show me']);
    expect(commentBox()).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[data-selection-action="show-me"]')!.click());
    expect(shown).toEqual([{ filePath: 'src/retry-worker.ts', lineStart: 16, lineEnd: 18, side: 'new' }]);
    expect(chooser()).toBeNull();
    expect(commentBox()).toBeNull();

    act(() => ref.current!.handleLineSelectionEnd({ start: 15, end: 15, side: 'additions' }));
    act(() => document.querySelector<HTMLButtonElement>('[data-selection-action="ask"]')!.click());
    expect(asked).toEqual([{ filePath: 'src/retry-worker.ts', lineStart: 15, lineEnd: 15, side: 'new' }]);
  });

  test('deleted (old-side) lines offer no Show me: a picture is of the code as it is now; Ask stays', () => {
    const shown: DiffSelection[] = [];
    const ref = mount({ onShowMe: (s) => shown.push(s), onAsk: () => {} });
    act(() => ref.current!.handleLineSelectionEnd({ start: 14, end: 14, side: 'deletions' }));
    expect([...chooser()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Comment', 'Ask']);
    // A drag from a new-side line onto a deleted one: one end is old, so no Show me either.
    act(() => ref.current!.handleLineSelectionEnd({ start: 16, end: 14, side: 'additions', endSide: 'deletions' }));
    expect([...chooser()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Comment', 'Ask']);
    act(() => ref.current!.handleLineSelectionEnd({ start: 15, end: 17, side: 'additions', endSide: 'additions' }));
    expect([...chooser()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Comment', 'Ask', 'Show me']);
    expect(shown).toEqual([]);
  });

  test('Comment opens the comment box for the same lines', () => {
    mount({ onShowMe: () => {} });
    act(() => document.querySelector<HTMLButtonElement>('[data-selection-action="comment"]')!.click());
    expect(chooser()).toBeNull();
    expect(commentBox()).not.toBeNull();
  });

  describe('where it sits', () => {
    const placed = () => ({ top: chooser()!.style.top, left: chooser()!.style.left, transform: chooser()!.style.transform, hidden: chooser()!.style.visibility });

    test('under the painted lines, at the start of their code, and not until it has read them', async () => {
      const ref = mount({ onShowMe: () => {} });
      // Nothing painted yet: unseen, not flashed at the pointer.
      expect(placed().hidden).toBe('hidden');
      paintedDiff([{ line: 16, top: 300, left: 803 }, { line: 18, top: 340, left: 803 }]);
      act(() => ref.current!.handleLineSelectionEnd({ start: 16, end: 18, side: 'additions' }));
      await frames();
      expect(placed()).toEqual({ top: '366px', left: '803px', transform: '', hidden: '' });
    });

    test('Split paints both columns: it goes by the side the selection ends on', async () => {
      paintedDiff([
        { column: 'deletions', line: 18, top: 340, left: 100 },
        { column: 'additions', line: 18, top: 340, left: 803 },
      ]);
      const ref = mount({ onShowMe: () => {} });
      await frames();
      expect(placed().left).toBe('803px');
      act(() => ref.current!.handleLineSelectionEnd({ start: 16, end: 18, side: 'deletions' }));
      await frames();
      expect(placed().left).toBe('100px');
      act(() => ref.current!.handleLineSelectionEnd({ start: 16, end: 18, side: 'additions', endSide: 'deletions' }));
      await frames();
      expect(placed().left).toBe('100px');
    });

    test("another diff's painted lines don't take it: this selection's last line does", async () => {
      paintedDiff([{ line: 5, top: 100, left: 300 }]);
      paintedDiff([{ line: 18, top: 500, left: 803 }]);
      mount({ onShowMe: () => {} });
      await frames();
      expect(placed()).toMatchObject({ top: '526px', left: '803px' });
    });

    test('nothing on the diff to read: the pointer, centred, on screen', async () => {
      mount({ onShowMe: () => {} });
      await frames();
      expect(placed().hidden).toBe('');
      expect(placed().transform).toBe('translateX(-50%)');
    });

    test('it follows its lines when they move, with nothing to announce it', async () => {
      paintedDiff([{ line: 18, top: 340, left: 803 }]);
      mount({ onShowMe: () => {} });
      await frames();
      expect(placed().top).toBe('366px');
      const rows = [...document.querySelector('diffs-container')!.shadowRoot!.querySelectorAll<HTMLElement>('[data-selected-line]')];
      for (const row of rows) {
        const was = row.getBoundingClientRect();
        row.getBoundingClientRect = () => ({ ...was, top: 240, bottom: 260, y: 240 });
      }
      await frames(3);
      expect(placed().top).toBe('266px');
    });
  });
});
