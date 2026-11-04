/**
 * A host's choices for selected lines (the Inbox's code review: Comment · Ask
 * · Show me, approval "shape-in-code-review"). What regresses if these fail:
 * - the review app (no `selectionActions`) stops opening the comment box at
 *   once on a selection;
 * - Show me or Ask reaches the host with the wrong file, lines or side, or
 *   leaves the chooser (or a comment box) open over the picture;
 * - Comment no longer opens the comment box for the same lines.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffSelection } from './SelectionChooser';

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
  const ref = createRef<import('./ToolbarHost').ToolbarHostHandle>();
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

const chooser = () => document.querySelector('[data-selection-chooser]');
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
});
