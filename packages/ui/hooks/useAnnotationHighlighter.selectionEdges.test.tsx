/**
 * Selections whose edges the library cannot use must not paint the rest of
 * the document.
 *
 * web-highlighter paints by walking the root from the range's start node to
 * its end node, and it never ENTERS an element in `exceptSelectors`. Two
 * shapes therefore never meet their end node and paint every text node up to
 * the end of the root:
 *
 *  1. The end sits inside (or right at) skipped chrome: a drag released on a
 *     button in the text, a code block's Copy button, a formula, an alert's
 *     hidden type word.
 *  2. The end sits outside the root: a drag that STARTS in a side panel that
 *     follows the document and ends in the document. Its quote also carries
 *     the panel's words.
 *
 * And one gesture that is not a selection gesture at all: a release of a
 * button other than the main one (a context click on selected words).
 *
 * The file drives the real library over a real `mouseup`, like
 * `useAnnotationHighlighter.blankSelection.test.tsx`.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const LEAD = 'Lead words here ';
const TAIL = ' tail words.';
const SECOND = 'Second paragraph beta.';
const THIRD = 'Third paragraph gamma.';
const PANEL = 'Panel comment text.';

interface HookHandle {
  toolbarState: unknown;
  commentPopover: unknown;
  highlightRange: (range: Range, modeOverride?: 'redline' | 'selection' | 'comment') => void;
  takeSelection?: () => boolean;
}

function Harness({
  mode,
  onAdd,
  hookRef,
}: {
  mode: 'redline' | 'selection' | 'comment';
  onAdd: (ann: Annotation) => void;
  hookRef: { current: HookHandle | null };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode,
    onAddAnnotation: onAdd,
  });
  hookRef.current = hook as unknown as HookHandle;
  return (
    <div>
      <div ref={containerRef} data-testid="doc">
        <p data-block-id="block-1">
          {LEAD}
          <button type="button">Copy</button>
          {TAIL}
        </p>
        <p data-block-id="block-2">
          {SECOND}
          <span className="annotation-exclude">Hidden</span>
        </p>
        <p data-block-id="block-3">{THIRD}</p>
      </div>
      <aside data-testid="panel">
        <p>{PANEL}</p>
      </aside>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let errorListener: ((event: Event) => void) | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (errorListener) {
    window.removeEventListener('error', errorListener);
    errorListener = null;
  }
  if (hasDom) document.body.innerHTML = '';
});

async function mount(mode: 'redline' | 'selection' | 'comment') {
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const hook: { current: HookHandle | null } = { current: null };
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness mode={mode} onAdd={(ann) => added.push(ann)} hookRef={hook} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const uncaught: string[] = [];
  errorListener = (event: Event) => {
    const e = event as ErrorEvent;
    uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
  };
  window.addEventListener('error', errorListener);

  const container = host.querySelector('[data-testid="doc"]') as HTMLElement;
  const panel = host.querySelector('[data-testid="panel"]') as HTMLElement;
  const [first, second, third] = Array.from(container.children) as HTMLElement[];
  return {
    container,
    panel,
    first: first!,
    second: second!,
    third: third!,
    button: first!.querySelector('button') as HTMLElement,
    hidden: second!.querySelector('.annotation-exclude') as HTMLElement,
    added,
    hook,
    uncaught,
  };
}

const rangeOf = (start: Node, startOffset: number, end: Node, endOffset: number): Range => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
};

const select = (start: Node, startOffset: number, end: Node, endOffset: number): Selection => {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(rangeOf(start, startOffset, end, endOffset));
  return selection;
};

const pointerEnd = async (target: HTMLElement, init: MouseEventInit = {}) => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, ...init }));
    await new Promise((r) => setTimeout(r, 20));
  });
};

const paintedText = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll('mark')).map((m) => m.textContent ?? '').join('');

describe('useAnnotationHighlighter: an end the painter cannot reach', () => {
  test.skipIf(!hasDom)('a drag released inside a button in the text stops at the text before it', async () => {
    const { container, first, button, added, uncaught } = await mount('redline');
    // "words here " + part of the button's label: the release landed on it.
    select(first.firstChild!, 5, button.firstChild!, 2);

    await pointerEnd(button);

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('words here ');
    expect(added[0]!.originalText.trim()).toBe('words here');
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('an end at the element boundary right before a button stops there too', async () => {
    // The library resolves an element boundary to the child at its offset:
    // here the button itself, which the painter skips before comparing.
    const { container, first, button, added } = await mount('redline');
    const buttonIndex = Array.from(first.childNodes).indexOf(button);
    select(first.firstChild!, 5, first, buttonIndex);

    await pointerEnd(first);

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('words here ');
  });

  test.skipIf(!hasDom)('a drag released inside excluded text stops at the text before it', async () => {
    const { container, second, hidden, added } = await mount('redline');
    select(second.firstChild!, 7, hidden.firstChild!, 3);

    await pointerEnd(second);

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('paragraph beta.');
    expect(added[0]!.originalText.trim()).toBe('paragraph beta.');
  });

  test.skipIf(!hasDom)('a caller-built range ending inside a button stops at the text before it', async () => {
    const { container, first, button, added, hook } = await mount('selection');

    await act(async () => {
      hook.current!.highlightRange(rangeOf(first.firstChild!, 5, button.firstChild!, 2), 'redline');
    });

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('words here ');
  });

  test.skipIf(!hasDom)('a taken touch selection ending inside a button stops at the text before it', async () => {
    const { container, first, button, hook } = await mount('selection');
    select(first.firstChild!, 5, button.firstChild!, 2);

    let took = false;
    await act(async () => { took = hook.current!.takeSelection!(); });

    expect(took).toBe(true);
    expect(paintedText(container)).toBe('words here ');
  });

  test.skipIf(!hasDom)('a selection wholly inside a button is left alone', async () => {
    const { container, button, added } = await mount('redline');
    select(button.firstChild!, 0, button.firstChild!, 4);

    await pointerEnd(button);

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a selection that runs THROUGH a button still paints both sides', async () => {
    // The regression pin: an end the painter can reach is not moved.
    const { container, first, added } = await mount('redline');
    const tail = first.lastChild!;
    select(first.firstChild!, 5, tail, 5);

    await pointerEnd(first);

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('words here ' + TAIL.slice(0, 5));
  });
});

describe('useAnnotationHighlighter: a selection that reaches outside the document', () => {
  test.skipIf(!hasDom)('a drag from a panel after the document into it makes no highlight', async () => {
    const { container, panel, second, added, hook, uncaught } = await mount('selection');
    // Pressed in the panel, released in the second paragraph: in document
    // order the range runs from the release point to the press point.
    const panelText = panel.querySelector('p')!.firstChild!;
    select(second.firstChild!, 7, panelText, 5);

    await pointerEnd(second);

    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(hook.current!.toolbarState).toBeNull();
    expect(added).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('the same drag in redline mode deletes nothing', async () => {
    const { container, panel, second, added } = await mount('redline');
    select(second.firstChild!, 7, panel.querySelector('p')!.firstChild!, 5);

    await pointerEnd(second);

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a triple-click on the last block, which ends in the next element, still highlights it', async () => {
    // Chromium ends a triple-click at offset 0 of whatever follows the block.
    // After the LAST block that is an element outside the document, so the
    // range's common ancestor is outside too; it carries no words from there
    // and must keep working.
    const { container, panel, third, added } = await mount('redline');
    select(third.firstChild!, 0, panel, 0);

    await pointerEnd(third);

    expect(added.length).toBe(1);
    expect(added[0]!.originalText.trim()).toBe(THIRD);
    expect(added[0]!.type).toBe(AnnotationType.DELETION);
    expect(paintedText(container)).toBe(THIRD);
  });
});

describe('useAnnotationHighlighter: a release of another mouse button', () => {
  test.skipIf(!hasDom)('a context click on selected words makes no highlight and keeps the selection', async () => {
    const { container, second, added, hook } = await mount('selection');
    const selection = select(second.firstChild!, 0, second.firstChild!, 6);

    await pointerEnd(second, { button: 2 });

    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(hook.current!.toolbarState).toBeNull();
    expect(added).toEqual([]);
    // Still there for the context menu's Copy.
    expect(selection.toString()).toBe('Second');
  });

  test.skipIf(!hasDom)('a context click in redline mode deletes nothing', async () => {
    const { second, added } = await mount('redline');
    select(second.firstChild!, 0, second.firstChild!, 6);

    await pointerEnd(second, { button: 2 });

    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('the next main-button release highlights as before', async () => {
    const { container, second, added } = await mount('redline');
    select(second.firstChild!, 0, second.firstChild!, 6);
    await pointerEnd(second, { button: 2 });

    select(second.firstChild!, 0, second.firstChild!, 6);
    await pointerEnd(second);

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('Second');
  });
});
