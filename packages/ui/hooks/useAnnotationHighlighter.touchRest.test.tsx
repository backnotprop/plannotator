/**
 * A selection made with a finger is highlighted once it is finished, and
 * stays selected.
 *
 * On a touch screen the highlighter reads the selection from
 * `selectionchange`. It used to paint the selection 400 ms after its last
 * change even with the finger still dragging: the marks it wrapped around the
 * words took the live selection away (iOS's handles and magnifier went and
 * the drag stopped selecting), and a later highlight replacing the first moved
 * the selection's ends onto other words, so a third, wrong highlight followed.
 * Now nothing is painted while a finger is on the screen, a selection changed
 * with no finger seen waits TOUCH_HIGHLIGHT_REST_MS, a lift waits
 * TOUCH_HIGHLIGHT_LIFT_MS, and the selection is put back over the same words
 * after the paint.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';
import {
  TOUCH_FINGER_STALE_MS,
  TOUCH_HIGHLIGHT_LIFT_MS,
  TOUCH_HIGHLIGHT_REST_MS,
} from '../utils/touchSelection';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const FIRST = 'The first paragraph has enough words in it to drag a selection across several of them.';
const SECOND = 'A second paragraph follows it.';

interface HookHandle {
  toolbarState: { source: { id: string }; selectionText: string; touchSide?: 'above' } | null;
}

function Harness({ onAdd, hookRef }: { onAdd: (ann: Annotation) => void; hookRef: { current: HookHandle | null } }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({ containerRef, annotations: [], selectedAnnotationId: null, mode: 'selection', onAddAnnotation: onAdd });
  hookRef.current = hook as unknown as HookHandle;
  return (
    <div ref={containerRef} data-testid="doc">
      <p data-block-id="block-1">{FIRST}</p>
      <p data-block-id="block-2">{SECOND}</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

afterEach(async () => {
  jest.useRealTimers();
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  originalMatchMedia = undefined;
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  }
});

function pointerIs(coarse: boolean) {
  originalMatchMedia ??= window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: coarse ? query.includes('pointer: coarse') : query.includes('pointer: fine'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
}

async function mount(coarse = true) {
  pointerIs(coarse);
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const hook: { current: HookHandle | null } = { current: null };
  root = createRoot(host);
  await act(async () => { root!.render(<Harness onAdd={(ann) => added.push(ann)} hookRef={hook} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const container = host.querySelector('[data-testid="doc"]') as HTMLElement;
  const first = container.querySelector('[data-block-id="block-1"]') as HTMLElement;
  jest.useFakeTimers();
  return { container, first, added, hook };
}

/** Characters `from`..`to` of the first paragraph, as one live selection (the browser's own, then `selectionchange`). */
const select = (first: HTMLElement, from: number, to: number) => {
  const text = first.firstChild as Text;
  window.getSelection()!.setBaseAndExtent(text, from, text, to);
  document.dispatchEvent(new Event('selectionchange'));
};
/** Moves the selection's focus end (a handle drag) to `to` characters into the first paragraph's text. */
const extendTo = (first: HTMLElement, to: number) => {
  const selection = window.getSelection()!;
  const node = (selection.anchorNode && first.contains(selection.anchorNode) ? textAtOffset(first, to) : null)!;
  selection.extend(node[0], node[1]);
  document.dispatchEvent(new Event('selectionchange'));
};
/** The (text node, offset) `offset` characters into `el` (its text may be split into marks by now). */
function textAtOffset(el: HTMLElement, offset: number): [Text, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (left <= text.data.length) return [text, left];
    left -= text.data.length;
  }
  throw new Error(`no text at ${offset}`);
}
const touch = (type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', target: EventTarget, fingers: number) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: fingers }, () => ({})) });
  target.dispatchEvent(event);
};
const wait = async (ms: number) => {
  await act(async () => { jest.advanceTimersByTime(ms); });
};
const marks = (container: HTMLElement) => Array.from(container.querySelectorAll('mark')).map((m) => m.textContent).join('');
const markIds = (container: HTMLElement) => new Set(Array.from(container.querySelectorAll('mark')).map((m) => m.getAttribute('data-highlight-id')));
const selected = () => window.getSelection()!.toString();

describe('useAnnotationHighlighter: a finger\'s selection on a touch screen', () => {
  test.skipIf(!hasDom)('nothing is painted while a finger is on the screen; the lift paints it, and it stays selected', async () => {
    const { container, first, hook } = await mount();
    const words = FIRST.slice(4, 30);

    touch('touchstart', first, 1);
    select(first, 4, 30);
    // The finger rests on the words, moving a little, for far longer than the old 400 ms.
    for (let i = 0; i < 6; i++) {
      await wait(TOUCH_HIGHLIGHT_REST_MS / 2);
      touch('touchmove', first, 1);
    }
    expect(marks(container)).toBe('');
    expect(hook.current!.toolbarState).toBeNull();
    expect(selected()).toBe(words);

    touch('touchend', first, 0);
    await wait(TOUCH_HIGHLIGHT_LIFT_MS - 1);
    expect(marks(container)).toBe('');
    await wait(1);
    expect(marks(container)).toBe(words);
    expect(hook.current!.toolbarState?.selectionText).toBe(words);
    // The selection is the person's still, over the same words, to adjust.
    expect(selected()).toBe(words);
  });

  test.skipIf(!hasDom)('with no finger seen, a selection is painted only once it has not changed for the rest time', async () => {
    const { container, first } = await mount();
    select(first, 4, 30);
    await wait(TOUCH_HIGHLIGHT_REST_MS - 1);
    expect(marks(container)).toBe('');
    await wait(1);
    expect(marks(container)).toBe(FIRST.slice(4, 30));
  });

  test.skipIf(!hasDom)('a drag that grows in steps and pauses mid-way makes no highlight until it ends, then exactly one', async () => {
    const { container, first } = await mount();
    // The repro's sequence: a word, the handle dragged on in steps, a 650 ms pause with the finger down, more steps.
    select(first, 4, 9);
    for (let to = 12; to <= 24; to += 3) {
      await wait(90);
      extendTo(first, to);
    }
    await wait(650);
    expect(marks(container)).toBe('');
    for (let to = 27; to <= 45; to += 3) {
      await wait(90);
      extendTo(first, to);
    }
    expect(marks(container)).toBe('');
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    expect(marks(container)).toBe(FIRST.slice(4, 45));
    expect(markIds(container).size).toBe(1);
    expect(selected()).toBe(FIRST.slice(4, 45));

    // Nothing more: the selection put back is not painted again.
    await wait(TOUCH_HIGHLIGHT_REST_MS * 5);
    expect(markIds(container).size).toBe(1);
  });

  test.skipIf(!hasDom)('putting the selection back fires no second highlight', async () => {
    const { container, first, hook } = await mount();
    select(first, 4, 30);
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    const id = hook.current!.toolbarState!.source.id;
    // The selectionchange the restore (and the wrap under it) causes, as a browser sends it.
    document.dispatchEvent(new Event('selectionchange'));
    await wait(TOUCH_HIGHLIGHT_REST_MS * 3);
    touch('touchstart', first, 1);
    touch('touchend', first, 0);
    await wait(TOUCH_HIGHLIGHT_REST_MS * 3);
    expect(hook.current!.toolbarState!.source.id).toBe(id);
    expect([...markIds(container)]).toEqual([id]);
    expect(selected()).toBe(FIRST.slice(4, 30));
  });

  test.skipIf(!hasDom)('a handle dragged after the highlight replaces it with one for the new words, and the selection never jumps', async () => {
    const { container, first, hook } = await mount();
    select(first, 4, 30);
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    const firstId = hook.current!.toolbarState!.source.id;

    // The end handle, dragged on over the highlight's marks.
    touch('touchstart', first, 1);
    for (const to of [34, 40, 47]) {
      extendTo(first, to);
      expect(selected()).toBe(FIRST.slice(4, to));
      await wait(100);
      touch('touchmove', first, 1);
    }
    touch('touchend', first, 0);
    await wait(TOUCH_HIGHLIGHT_LIFT_MS);

    expect(marks(container)).toBe(FIRST.slice(4, 47));
    const ids = markIds(container);
    expect(ids.size).toBe(1);
    expect(ids.has(firstId)).toBe(false);
    // The live selection's words are what they were before the old highlight came out.
    expect(selected()).toBe(FIRST.slice(4, 47));
    await wait(TOUCH_HIGHLIGHT_REST_MS * 3);
    expect(markIds(container).size).toBe(1);
  });

  test.skipIf(!hasDom)('a selection made backwards is put back backwards, and its toolbar goes below', async () => {
    const { first, hook } = await mount();
    const text = first.firstChild as Text;
    window.getSelection()!.setBaseAndExtent(text, 30, text, 4);
    document.dispatchEvent(new Event('selectionchange'));
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    const selection = window.getSelection()!;
    expect(selection.toString()).toBe(FIRST.slice(4, 30));
    // The focus (the end being moved) is still the start.
    expect(selection.anchorNode!.compareDocumentPosition(selection.focusNode!) & Node.DOCUMENT_POSITION_PRECEDING
      || (selection.anchorNode === selection.focusNode && selection.focusOffset < selection.anchorOffset)).toBeTruthy();
    expect(hook.current!.toolbarState?.touchSide).toBeUndefined();
  });

  test.skipIf(!hasDom)('a selection whose end moved last puts its toolbar above', async () => {
    const { hook, first } = await mount();
    select(first, 4, 30);
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    expect(hook.current!.toolbarState?.touchSide).toBe('above');
  });

  test.skipIf(!hasDom)('a finger whose lift never comes stops holding the highlight back', async () => {
    // iOS 27 sends no more of a touch that starts on a selection handle.
    const { container, first } = await mount();
    touch('touchstart', first, 1);
    select(first, 4, 30);
    await wait(TOUCH_FINGER_STALE_MS - 1);
    expect(marks(container)).toBe('');
    await wait(1);
    expect(marks(container)).toBe(FIRST.slice(4, 30));
  });

  test.skipIf(!hasDom)('a touch cancelled (not lifted) waits the full rest time', async () => {
    const { container, first } = await mount();
    touch('touchstart', first, 1);
    select(first, 4, 30);
    touch('touchcancel', first, 0);
    await wait(TOUCH_HIGHLIGHT_LIFT_MS * 2);
    expect(marks(container)).toBe('');
    await wait(TOUCH_HIGHLIGHT_REST_MS);
    expect(marks(container)).toBe(FIRST.slice(4, 30));
  });

  test.skipIf(!hasDom)('a touchend on the document does not paint the selection at once and take it away', async () => {
    const { container, first } = await mount();
    touch('touchstart', first, 1);
    select(first, 4, 30);
    touch('touchend', first, 0);
    expect(marks(container)).toBe('');
    expect(selected()).toBe(FIRST.slice(4, 30));
    await wait(TOUCH_HIGHLIGHT_LIFT_MS);
    expect(marks(container)).toBe(FIRST.slice(4, 30));
    expect(selected()).toBe(FIRST.slice(4, 30));
  });

  test.skipIf(!hasDom)('with a mouse or trackpad as the main pointer, a resting selection is never painted on its own', async () => {
    const { container, first } = await mount(false);
    select(first, 4, 30);
    await wait(TOUCH_HIGHLIGHT_REST_MS * 5);
    expect(marks(container)).toBe('');
    expect(selected()).toBe(FIRST.slice(4, 30));
  });
});
