/**
 * Click a word (part of Select): one click on a word selects it and, after a
 * short wait, hands the word to the shared highlight path.
 *
 * What must not regress: a click becoming a highlight where it has another
 * meaning (a link, a button, an existing highlight, a click that closes a
 * toolbar), from another mouse button or a modified click, while a second
 * click is on its way (double and triple click stay the browser's) or while
 * the page is scrolling; and the method doing anything when it is off.
 *
 * happy-dom has no layout: the caret under a point is stubbed to an offset the
 * test sets, and every range reports one box at the origin.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CLICK_WORD_WAIT_MS, useClickWord } from './useClickWord';

const hasDom = typeof document !== 'undefined';
const TEXT = 'Run the focused tests now.';

interface Props { enabled?: boolean; clicksEnabled?: boolean; annotationUiOpen?: boolean; onSelect: (range: Range) => void }
function Harness({ enabled = true, clicksEnabled = true, annotationUiOpen = false, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickWord({ containerRef, enabled, clicksEnabled, snapDrags: true, annotationUiOpen, onSelectRange: onSelect });
  return (
    <div>
      <div ref={containerRef} data-testid="doc">
        <p>{TEXT}</p>
        <p><a href="#x">linked words</a> <button type="button">Press</button> <mark className="annotation-highlight">marked words</mark></p>
      </div>
      <p data-testid="outside">outside words</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let caret: { node: Node; offset: number } | null = null;
/** Whether the pointer is on the glyphs of the word beside the caret. */
let onGlyphs = true;
type CaretDoc = { caretRangeFromPoint?: unknown; caretPositionFromPoint?: unknown };
let saved: { range: unknown; position: unknown; rects: unknown } | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom && saved) {
    (document as unknown as CaretDoc).caretRangeFromPoint = saved.range;
    (document as unknown as CaretDoc).caretPositionFromPoint = saved.position;
    (Range.prototype as unknown as { getClientRects: unknown }).getClientRects = saved.rects;
    saved = null;
  }
  onGlyphs = true;
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  }
});

async function mount(props: Omit<Props, 'onSelect'> = {}) {
  const doc = document as unknown as CaretDoc;
  saved = { range: doc.caretRangeFromPoint, position: doc.caretPositionFromPoint, rects: Range.prototype.getClientRects };
  doc.caretRangeFromPoint = undefined;
  doc.caretPositionFromPoint = () => (caret ? { offsetNode: caret.node, offset: caret.offset } : null);
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [onGlyphs ? { left: 0, right: 0, top: 0, bottom: 0 } : { left: 500, right: 540, top: 0, bottom: 0 }];

  host = document.createElement('div');
  document.body.appendChild(host);
  const picked: string[] = [];
  root = createRoot(host);
  await act(async () => { root?.render(<Harness {...props} onSelect={(range) => picked.push(range.toString())} />); });
  const container = host.querySelector('[data-testid="doc"]') as HTMLElement;
  const first = container.children[0] as HTMLElement;
  const second = container.children[1] as HTMLElement;
  return {
    first, text: first.firstChild as Text, picked,
    link: second.querySelector('a') as HTMLElement,
    button: second.querySelector('button') as HTMLElement,
    mark: second.querySelector('mark') as HTMLElement,
    outside: host.querySelector('[data-testid="outside"]') as HTMLElement,
  };
}

const pointer = (type: string, init: Record<string, unknown> = {}): Event => {
  const base = { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, pointerType: 'mouse', ...init };
  return typeof PointerEvent === 'function' ? new PointerEvent(type, base) : new MouseEvent(type, base);
};
const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, detail: 1, ...init });

/** One click on `target`, the caret under it at `at`. */
const click = (target: HTMLElement, at: { node: Node; offset: number } | null, init: MouseEventInit = {}) => {
  caret = at;
  target.dispatchEvent(pointer('pointerdown', init as Record<string, unknown>));
  target.dispatchEvent(mouse('mousedown', init));
  target.dispatchEvent(pointer('pointerup', init as Record<string, unknown>));
  target.dispatchEvent(mouse('mouseup', init));
  target.dispatchEvent(mouse('click', init));
};
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const AFTER = CLICK_WORD_WAIT_MS + 60;

describe.if(hasDom)('useClickWord: a click on a word', () => {
  test('selects the word at once and hands it over after the wait', async () => {
    const { first, text, picked } = await mount();

    click(first, { node: text, offset: 10 });

    expect(window.getSelection()!.toString()).toBe('focused');
    expect(picked).toEqual([]);
    await wait(AFTER);
    expect(picked).toEqual(['focused']);
  });

  test('a second press within the wait cancels it: a double click is the browser\'s', async () => {
    const { first, text, picked } = await mount();

    click(first, { node: text, offset: 10 });
    await wait(80);
    first.dispatchEvent(pointer('pointerdown'));
    await wait(AFTER);

    expect(picked).toEqual([]);
  });

  test('a scroll during the wait holds it back until the page is still', async () => {
    const { first, text, picked } = await mount();

    click(first, { node: text, offset: 10 });
    await wait(CLICK_WORD_WAIT_MS - 100);
    window.dispatchEvent(new Event('scroll'));
    await wait(160);
    expect(picked).toEqual([]);

    await wait(CLICK_WORD_WAIT_MS);
    expect(picked).toEqual(['focused']);
  });

  test('a click beside a word, not on its letters, is no word', async () => {
    const { first, text, picked } = await mount();
    // The caret lands next to "now", but the pointer is in the margin past it.
    onGlyphs = false;

    click(first, { node: text, offset: 25 });
    await wait(AFTER);

    expect(picked).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });
});

describe.if(hasDom)('useClickWord: a document that changes during the wait', () => {
  test('unmounted: nothing is handed over', async () => {
    const { first, text, picked } = await mount();
    click(first, { node: text, offset: 10 });
    await act(async () => root?.unmount());
    root = null;
    await wait(AFTER);
    expect(picked).toEqual([]);
  });

  test('the text under the click replaced by new nodes: nothing', async () => {
    const { first, text, picked } = await mount();
    click(first, { node: text, offset: 10 });
    // A host that re-renders its body: same words, new nodes.
    first.replaceChildren(document.createTextNode(TEXT));
    await wait(AFTER);
    expect(picked).toEqual([]);
  });

  test('the text edited in place so other words sit there: nothing', async () => {
    const { first, text, picked } = await mount();
    click(first, { node: text, offset: 10 });
    text.data = 'Skip all flaky suites today.';
    await wait(AFTER);
    expect(picked).toEqual([]);
  });

  test('the text cut short of the word: nothing, and no error', async () => {
    const { first, text, picked } = await mount();
    click(first, { node: text, offset: 10 });
    text.data = 'Run';
    await wait(AFTER);
    expect(picked).toEqual([]);
  });
});

describe.if(hasDom)('useClickWord: clicks that keep their own meaning', () => {
  test('another mouse button makes nothing', async () => {
    const { first, text, picked } = await mount();
    click(first, { node: text, offset: 10 }, { button: 2 });
    await wait(AFTER);
    expect(picked).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test('a click with Cmd, Ctrl, Shift or Alt held makes nothing', async () => {
    const { first, text, picked } = await mount();
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      click(first, { node: text, offset: 10 }, { [key]: true });
      await wait(AFTER);
    }
    expect(picked).toEqual([]);
  });

  test('a link, a button and an existing highlight are theirs', async () => {
    const { link, button, mark, picked } = await mount();
    for (const el of [link, button, mark]) {
      click(el, el.firstChild ? { node: el.firstChild, offset: 2 } : null);
      await wait(AFTER);
    }
    expect(picked).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test('a click while a toolbar or composer is open only closes it', async () => {
    const { first, text, picked } = await mount({ annotationUiOpen: true });
    click(first, { node: text, offset: 10 });
    await wait(AFTER);
    expect(picked).toEqual([]);
  });

  test('a click that clears a live selection makes nothing', async () => {
    const { first, text, picked } = await mount();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    window.getSelection()!.addRange(range);

    caret = { node: text, offset: 10 };
    first.dispatchEvent(pointer('pointerdown'));
    window.getSelection()!.removeAllRanges(); // the browser's own press
    first.dispatchEvent(pointer('pointerup'));
    first.dispatchEvent(mouse('click'));
    await wait(AFTER);

    expect(picked).toEqual([]);
  });

  test('with clicks off (redline) a click makes nothing', async () => {
    const { first, text, picked } = await mount({ clicksEnabled: false });
    click(first, { node: text, offset: 10 });
    await wait(AFTER);
    expect(picked).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test('with the method off nothing listens', async () => {
    const { first, text, picked } = await mount({ enabled: false });
    click(first, { node: text, offset: 10 });
    await wait(AFTER);
    expect(picked).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });
});

describe.if(hasDom)('useClickWord: a drag selects whole words', () => {
  test('both ends of the browser\'s selection move out to word edges', async () => {
    const { first, text } = await mount();

    caret = { node: text, offset: 10 }; // in "focused"
    first.dispatchEvent(pointer('pointerdown'));
    first.dispatchEvent(mouse('mousedown'));
    first.dispatchEvent(pointer('pointermove', { clientX: 80 }));
    // The browser's own selection: "cused te".
    window.getSelection()!.setBaseAndExtent(text, 10, text, 18);
    document.dispatchEvent(new Event('selectionchange'));

    expect(window.getSelection()!.toString()).toBe('focused tests');
  });

  test('a release outside the document snaps too, before the highlight is made', async () => {
    const { first, text, outside } = await mount();

    caret = { node: text, offset: 10 };
    first.dispatchEvent(pointer('pointerdown'));
    first.dispatchEvent(mouse('mousedown'));
    first.dispatchEvent(pointer('pointermove', { clientX: 80 }));
    outside.dispatchEvent(pointer('pointerup', { clientX: 80 }));
    window.getSelection()!.setBaseAndExtent(text, 10, text, 18);
    outside.dispatchEvent(mouse('mouseup', { clientX: 80 }));

    expect(window.getSelection()!.toString()).toBe('focused tests');
  });
});
