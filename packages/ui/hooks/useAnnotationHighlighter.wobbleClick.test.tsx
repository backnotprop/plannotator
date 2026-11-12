import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const FIRST = 'First paragraph a alpha.';

function Harness({ onAdd }: { onAdd: (ann: Annotation) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnnotationHighlighter({ containerRef, annotations: [], selectedAnnotationId: null, mode: 'redline', onAddAnnotation: onAdd });
  return (
    <div ref={containerRef} data-testid="doc">
      <p data-block-id="block-1">{FIRST}</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) {
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
  return { container, first, text: first.firstChild as Text, added };
}

const mouse = (type: string, x: number, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: 5, detail: 1, ...init });

const press = async (first: HTMLElement, text: Text, from: number, via: number[], start: number, end: number, init: MouseEventInit = {}) => {
  await act(async () => {
    first.dispatchEvent(mouse('mousedown', from, init));
    window.getSelection()!.setBaseAndExtent(text, start, text, end);
    for (const x of via) first.dispatchEvent(mouse('mousemove', x, init));
    first.dispatchEvent(mouse('mouseup', via[via.length - 1] ?? from, init));
    await new Promise((r) => setTimeout(r, 30));
  });
};
const marks = (container: HTMLElement) => Array.from(container.querySelectorAll('mark')).map((m) => m.textContent).join('|');

describe('useAnnotationHighlighter: a click with a wobble', () => {
  test.skipIf(!hasDom)('one letter selected by a 2px wobble makes nothing', async () => {
    const { container, first, text, added } = await mount();

    await press(first, text, 60, [61, 62], 6, 7);

    expect(added).toEqual([]);
    expect(marks(container)).toBe('');
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test.skipIf(!hasDom)('two letters by a 3px wobble make nothing', async () => {
    const { container, first, text, added } = await mount();
    await press(first, text, 60, [62, 63], 6, 8);
    expect(added).toEqual([]);
    expect(marks(container)).toBe('');
  });

  test.skipIf(!hasDom)('a deliberate drag across one letter still highlights it', async () => {
    const { container, first, text, added } = await mount();
    await press(first, text, 60, [64, 69], 6, 7);
    expect(added.length).toBe(1);
    expect(marks(container)).toBe('p');
  });

  test.skipIf(!hasDom)('a drag out and back to where it started still counts as a drag', async () => {
    const { container, first, text, added } = await mount();
    await press(first, text, 60, [75, 61], 6, 7);
    expect(added.length).toBe(1);
    expect(marks(container)).toBe('p');
  });

  test.skipIf(!hasDom)('a double-click on a one-letter word still highlights it', async () => {
    const { container, first, text, added } = await mount();
    const at = FIRST.indexOf(' a ') + 1;
    await press(first, text, 60, [], at, at + 1, { detail: 2 });
    expect(added.length).toBe(1);
    expect(marks(container)).toBe('a');
  });

  test.skipIf(!hasDom)('a longer selection with no movement (a triple click, Shift+click) is untouched', async () => {
    const { container, first, text, added } = await mount();
    await press(first, text, 60, [], 0, 5);
    expect(added.length).toBe(1);
    expect(marks(container)).toBe('First');
  });

  test.skipIf(!hasDom)('Shift+click that extends by one letter is the browser\'s', async () => {
    const { container, first, text, added } = await mount();
    await press(first, text, 60, [], 6, 7, { shiftKey: true });
    expect(added.length).toBe(1);
    expect(marks(container)).toBe('p');
  });
});
