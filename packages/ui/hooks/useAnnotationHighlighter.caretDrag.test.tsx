/** A press-and-drag the browser leaves as a moving caret still selects. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const FIRST = 'First paragraph alpha.';

function Harness({ onAdd }: { onAdd: (ann: Annotation) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnnotationHighlighter({ containerRef, annotations: [], selectedAnnotationId: null, mode: 'redline', onAddAnnotation: onAdd });
  return (
    <div>
      <div ref={containerRef} data-testid="doc">
        <p data-block-id="block-1">{FIRST}</p>
        <p data-block-id="block-2"><button type="button">Press me</button> and more words.</p>
      </div>
      <div data-testid="gutter" />
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
type CaretDoc = { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: unknown };
let savedCaretRange: CaretDoc['caretRangeFromPoint'];
let savedCaretPosition: unknown;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) {
    (document as unknown as CaretDoc).caretRangeFromPoint = savedCaretRange;
    (document as unknown as CaretDoc).caretPositionFromPoint = savedCaretPosition;
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  }
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  root = createRoot(host);
  await act(async () => { root!.render(<Harness onAdd={(ann) => added.push(ann)} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const container = host.querySelector('[data-testid="doc"]') as HTMLElement;
  const first = container.children[0] as HTMLElement;
  const second = container.children[1] as HTMLElement;

  const doc = document as unknown as CaretDoc;
  savedCaretRange = doc.caretRangeFromPoint;
  savedCaretPosition = doc.caretPositionFromPoint;
  doc.caretPositionFromPoint = undefined;
  doc.caretRangeFromPoint = (x: number) => {
    const text = first.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, Math.max(0, Math.min(text.length, Math.round(x / 10))));
    return range;
  };
  return {
    container, first, second,
    button: second.querySelector('button') as HTMLElement,
    gutter: host.querySelector('[data-testid="gutter"]') as HTMLElement,
    added,
  };
}

const mouse = (type: string, x: number, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: 5, detail: 1, ...init });

/** What Chromium leaves after such a press: a caret, however far the pointer goes. */
const caretOnly = (node: Node, offset: number) => {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  selection.addRange(range);
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const paintedText = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll('mark')).map((m) => m.textContent ?? '').join('');

describe('useAnnotationHighlighter: a drag the browser leaves as a caret', () => {
  test.skipIf(!hasDom)('selects from the press to the pointer and commits at the release', async () => {
    const { container, first, added } = await mount();
    const text = first.firstChild!;

    first.dispatchEvent(mouse('mousedown', 60));
    caretOnly(text, 6);
    first.dispatchEvent(mouse('mousemove', 90));
    first.dispatchEvent(mouse('mousemove', 120));
    const last = mouse('mousemove', 150);
    first.dispatchEvent(last);

    // The hook drives now, and keeps the browser from moving its caret again.
    expect(window.getSelection()!.toString()).toBe('paragraph');
    expect(last.defaultPrevented).toBe(true);

    await act(async () => { first.dispatchEvent(mouse('mouseup', 150)); });
    await settle();

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('paragraph');
    expect(paintedText(container)).toBe('paragraph');
  });

  test.skipIf(!hasDom)('backwards too', async () => {
    const { first, added } = await mount();
    const text = first.firstChild!;

    first.dispatchEvent(mouse('mousedown', 150));
    caretOnly(text, 15);
    for (const x of [120, 90, 60]) first.dispatchEvent(mouse('mousemove', x));
    await act(async () => { first.dispatchEvent(mouse('mouseup', 60)); });
    await settle();

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('paragraph');
  });

  test.skipIf(!hasDom)('let go outside the document, it commits there as well', async () => {
    const { container, first, gutter, added } = await mount();

    first.dispatchEvent(mouse('mousedown', 60));
    caretOnly(first.firstChild!, 6);
    for (const x of [90, 120, 150]) first.dispatchEvent(mouse('mousemove', x));
    await act(async () => { gutter.dispatchEvent(mouse('mouseup', 150)); });
    await settle();

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('paragraph');
  });
});

describe('useAnnotationHighlighter: what the caret repair must leave alone', () => {
  test.skipIf(!hasDom)('a plain click makes nothing', async () => {
    const { container, first, added } = await mount();

    first.dispatchEvent(mouse('mousedown', 60));
    caretOnly(first.firstChild!, 6);
    await act(async () => { first.dispatchEvent(mouse('mouseup', 60)); });
    await settle();

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test.skipIf(!hasDom)('a click with a small wobble makes nothing', async () => {
    const { container, first, added } = await mount();

    first.dispatchEvent(mouse('mousedown', 60));
    caretOnly(first.firstChild!, 6);
    for (const x of [61, 62, 63]) first.dispatchEvent(mouse('mousemove', x));
    await act(async () => { first.dispatchEvent(mouse('mouseup', 63)); });
    await settle();

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a drag the browser IS selecting keeps the browser\'s selection', async () => {
    const { first, added } = await mount();
    const text = first.firstChild!;

    first.dispatchEvent(mouse('mousedown', 60));
    for (const x of [90, 120, 150]) {
      // The browser's own selection, deliberately not where the stub points.
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const move = mouse('mousemove', x);
      first.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(false);
    }
    await act(async () => { first.dispatchEvent(mouse('mouseup', 150)); });
    await settle();

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('First');
  });

  test.skipIf(!hasDom)('a press on a button is the button\'s', async () => {
    const { container, button, first, added } = await mount();

    button.dispatchEvent(mouse('mousedown', 60));
    for (const x of [90, 120, 150]) first.dispatchEvent(mouse('mousemove', x));
    await act(async () => { first.dispatchEvent(mouse('mouseup', 150)); });
    await settle();

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('the second press of a double-click is the browser\'s', async () => {
    const { container, first, added } = await mount();

    first.dispatchEvent(mouse('mousedown', 60, { detail: 2 }));
    caretOnly(first.firstChild!, 6);
    for (const x of [90, 120, 150]) first.dispatchEvent(mouse('mousemove', x));
    await act(async () => { first.dispatchEvent(mouse('mouseup', 150, { detail: 2 })); });
    await settle();

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a press with Shift held is the browser\'s', async () => {
    const { container, first, added } = await mount();

    first.dispatchEvent(mouse('mousedown', 60, { shiftKey: true }));
    caretOnly(first.firstChild!, 6);
    for (const x of [90, 120, 150]) first.dispatchEvent(mouse('mousemove', x, { shiftKey: true }));
    await act(async () => { first.dispatchEvent(mouse('mouseup', 150, { shiftKey: true })); });
    await settle();

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });
});
