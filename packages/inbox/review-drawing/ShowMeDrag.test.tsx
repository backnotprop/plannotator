/**
 * The Show me picture moves by its header, like the Ask window (owner's
 * request on #2600). What regresses if these fail:
 * - dragging the header no longer moves the picture, or a click (on the
 *   header, or a press that barely moves) moves it;
 * - a header button (Shrink, Close) starts a drag instead of doing its job;
 * - the picture can be dragged out of the review pane;
 * - a double-click on the header no longer puts it back;
 * - a phone's sheet (no `onOffset`) can be dragged.
 *
 * happy-dom has no layout: the picture's place and size and the pane's are
 * stubbed, as the review lays them out at 1280 by 800.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReviewDrawing } from '@plannotator/core/inbox-review';
import { bridgeSanitizerDom } from '../../../tests/helpers/chat-sanitizer-dom';
import type { SheetOffset } from './useSheetDrag';

const hasDom = typeof document !== 'undefined';
const layer = (hasDom ? await import('./ShowMeLayer') : {}) as typeof import('./ShowMeLayer');

let root: Root | null = null;
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

const DRAWING: InboxReviewDrawing = {
  id: 'drw_1',
  turn: 'ask_1',
  file: 'src/retry-worker.ts',
  lines: [16, 18],
  round: 1,
  title: 'After the third failure',
  view: { html: '<div data-mark="pick" data-code="src/retry-worker.ts#L16-L18">Pick</div>' },
  at: '2026-11-04T00:00:00.000Z',
};

/** The sheet at its place in a 1280 by 800 pane: x may go from -290 to +90, y from -58 to +242. */
const PANE = { width: 1280, height: 800 };
const SHEET = { left: 290, top: 58, width: 900, height: 500 };

function mount(movable = true) {
  const calls = { shrink: 0, close: 0 };
  function Host() {
    const [offset, setOffset] = useState<SheetOffset>({ x: 0, y: 0 });
    return (
      <div data-pane="">
        <layer.ShowMeSheet
          drawing={DRAWING}
          answer=""
          agent="Claude Code"
          host="claude-code"
          offset={offset}
          {...(movable ? { onOffset: setOffset } : {})}
          onCode={() => {}}
          onShrink={() => void calls.shrink++}
          onClose={() => void calls.close++}
        />
      </div>
    );
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<Host />));
  const pane = el.querySelector<HTMLElement>('[data-pane]')!;
  const sheet = el.querySelector<HTMLElement>('[data-show-me-sheet]')!;
  const header = sheet.querySelector<HTMLElement>('.ib-sm-sheet-h')!;
  Object.defineProperty(pane, 'clientWidth', { get: () => PANE.width });
  Object.defineProperty(pane, 'clientHeight', { get: () => PANE.height });
  Object.defineProperty(sheet, 'offsetParent', { get: () => pane });
  Object.defineProperty(sheet, 'offsetLeft', { get: () => SHEET.left });
  Object.defineProperty(sheet, 'offsetTop', { get: () => SHEET.top });
  Object.defineProperty(sheet, 'offsetWidth', { get: () => SHEET.width });
  Object.defineProperty(sheet, 'offsetHeight', { get: () => SHEET.height });
  // happy-dom has no pointer capture: the drag only needs the calls to exist.
  for (const node of [header, ...header.querySelectorAll<HTMLElement>('*')]) {
    node.setPointerCapture = () => {};
    node.releasePointerCapture = () => {};
  }
  return { sheet, header, calls };
}

function pointer(el: Element, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'isPrimary', { value: true });
  act(() => {
    el.dispatchEvent(event);
  });
}

function drag(el: HTMLElement, from: [number, number], ...moves: [number, number][]) {
  pointer(el, 'pointerdown', ...from);
  for (const at of moves) pointer(el, 'pointermove', ...at);
  pointer(el, 'pointerup', ...moves.at(-1)!);
}

const moved = (sheet: HTMLElement) => sheet.style.getPropertyValue('translate') || null;

describe.skipIf(!hasDom)('dragging the Show me picture', () => {
  test('dragging the header moves it; a press that barely moves does not', () => {
    const { sheet, header } = mount();
    expect(header.getAttribute('data-show-me-drag')).toBe('');
    drag(header, [600, 100], [602, 101]);
    expect(moved(sheet)).toBeNull();
    drag(header, [600, 100], [560, 130], [500, 180]);
    expect(moved(sheet)).toBe('-100px 80px');
    // The next drag starts from where the last one left it.
    drag(header, [500, 180], [520, 170]);
    expect(moved(sheet)).toBe('-80px 70px');
  });

  test("a header button does its job and never moves the picture", () => {
    const { sheet, header, calls } = mount();
    const close = header.querySelector<HTMLButtonElement>('button[aria-label="Close the picture"]')!;
    const shrink = header.querySelector<HTMLButtonElement>('button[aria-label="Shrink the picture"]')!;
    drag(shrink, [1100, 100], [900, 300]);
    act(() => shrink.click());
    act(() => close.click());
    expect(calls).toEqual({ shrink: 1, close: 1 });
    expect(moved(sheet)).toBeNull();
  });

  test('it stays inside the review pane, and a double-click puts it back', () => {
    const { sheet, header } = mount();
    drag(header, [600, 100], [-5000, 5000]);
    expect(moved(sheet)).toBe('-290px 242px');
    drag(header, [600, 100], [5000, -5000]);
    expect(moved(sheet)).toBe('90px -58px');
    act(() => {
      header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(moved(sheet)).toBeNull();
  });

  test("a phone's sheet (no onOffset) does not move", () => {
    const { sheet, header } = mount(false);
    expect(header.hasAttribute('data-show-me-drag')).toBe(false);
    drag(header, [600, 100], [500, 180]);
    expect(moved(sheet)).toBeNull();
  });
});
