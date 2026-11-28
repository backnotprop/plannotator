/**
 * Show never moves the reader (holdView.ts): the rows on screen before Show are where they were after it, whatever
 * the redraw did above them (the "N new" bar leaving the flow, rows coming in, a row moving to another group), and
 * the list is not scrolled when nothing above them changed. Browser scroll anchoring is not relied on.
 *
 * happy-dom has no layout: a stand-in lays the rows out from their place in the content and the list's scrollTop
 * (the list shows 0 to 600 px from its top, each row is 50 px tall).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useLayoutEffect, useState, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { holdView, restoreView, useShowHold } = await import('./holdView');

const BOX_TOP = 100;
const VIEW = 600;
let body: HTMLElement;
let scrollTop = 0;
/** Each row's top in the list's content. */
let at: Record<string, number> = {};

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect;
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;
const realRects = hasDom ? HTMLElement.prototype.getClientRects : undefined;

/** Draw the list: rows in this order, each 50 px, after `above` px of other content (the bar, say). */
function draw(ids: string[], above = 0): void {
  at = {};
  ids.forEach((id, n) => (at[id] = above + n * 50));
  body.replaceChildren(
    ...ids.map((id) => {
      const el = document.createElement('div');
      el.setAttribute('data-thread-id', id);
      return el;
    }),
  );
}

/** Where a row is on screen, from the list's top. */
const onScreen = (id: string) => at[id]! - scrollTop;

beforeEach(() => {
  if (!hasDom) return;
  scrollTop = 0;
  body = document.createElement('div');
  body.className = 'ib-lbody';
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => (scrollTop = Math.max(0, value)) });
  document.body.appendChild(body);
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.getAttribute('data-thread-id');
    return id ? rect(BOX_TOP + at[id]! - scrollTop, 50) : rect(BOX_TOP, VIEW);
  };
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (this.isConnected ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList;
  };
});
afterEach(() => {
  if (!hasDom) return;
  body.remove();
  HTMLElement.prototype.getBoundingClientRect = realRect!;
  HTMLElement.prototype.getClientRects = realRects!;
});

const rows = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test.skipIf(!hasDom)('the bar leaving the flow above the rows: they are put back where they were', () => {
  draw(rows(40), 50);
  scrollTop = 700;
  const before = onScreen('r20');
  const hold = holdView(body);
  draw(rows(40), 0);
  expect(restoreView(body, hold)).toBe(-50);
  expect(onScreen('r20')).toBe(before);
});

test.skipIf(!hasDom)('many rows changing above the view (a 418 px jump): put back, every row on screen in its place', () => {
  draw(rows(40), 50);
  scrollTop = 700;
  const hold = holdView(body);
  const was = Object.fromEntries([...hold.tops.keys()].map((id) => [id, onScreen(id)]));
  // Eight rows and 18 px more land above, the 50 px bar leaves: the rows on screen would sit 418 px lower.
  draw([...rows(8, 'n'), ...rows(40)], 68);
  expect(restoreView(body, hold)).toBe(418);
  for (const id of Object.keys(was)) expect(onScreen(id)).toBe(was[id]!);
});

test.skipIf(!hasDom)('rows coming in below the view: the list is not scrolled', () => {
  draw(rows(40));
  scrollTop = 700;
  const hold = holdView(body);
  draw([...rows(40), ...rows(3, 'n')]);
  expect(restoreView(body, hold)).toBe(0);
  expect(scrollTop).toBe(700);
});

test.skipIf(!hasDom)('a row Show moved elsewhere does not decide: the shift the rest share does', () => {
  draw(rows(40), 50);
  scrollTop = 700;
  const hold = holdView(body);
  // r16 is on screen and moves to the list's end; the bar leaves; the others keep their order.
  const order = rows(40).filter((id) => id !== 'r16');
  draw([...order, 'r16'], 0);
  expect(restoreView(body, hold)).toBe(-100);
  expect(onScreen('r20')).toBe(20 * 50 + 50 - 700);
});

test.skipIf(!hasDom)('at the top, the list cannot scroll above 0: nothing breaks, it stays at the top', () => {
  draw(rows(10), 50);
  const hold = holdView(body);
  draw(rows(10), 0);
  restoreView(body, hold);
  expect(scrollTop).toBe(0);
});

test.skipIf(!hasDom)('no row held is left (a different list): nothing moves', () => {
  draw(rows(20));
  scrollTop = 300;
  const hold = holdView(body);
  draw(rows(20, 'x'));
  expect(restoreView(body, hold)).toBe(0);
  expect(scrollTop).toBe(300);
});

// ---- The list's hook: Show notes, the commit that redraws puts the rows back, before App's slide is measured. ----

let press: () => void = () => {};
/** What App's `[shown]` layout effect (which measures and plays the slide) sees: the list's scrollTop. */
const seenByParent: number[] = [];

/** InboxList's part: Show notes the view, then asks App to show (`onShowNew`). */
function List({ box, onShow }: { box: RefObject<HTMLElement | null>; onShow: () => void }) {
  const note = useShowHold(box);
  press = () =>
    act(() => {
      note();
      onShow();
      // The redraw React commits before any layout effect: the bar leaves and eight rows land above the view
      // (drawn by hand: the stand-in layout).
      draw([...rows(8, 'n'), ...rows(40)], 68);
    });
  return null;
}

/** App's part: Show changes `shown`; its layout effect is where the settle's slide is measured. */
function Parent({ box }: { box: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState(0);
  useLayoutEffect(() => {
    if (shown > 0) seenByParent.push(scrollTop);
  }, [shown]);
  return <List box={box} onShow={() => setShown((n) => n + 1)} />;
}

test.skipIf(!hasDom)('Show through the list\'s hook: the rows are back in place in the same commit, before the parent\'s layout effect', () => {
  draw(rows(40), 50);
  scrollTop = 700;
  const before = onScreen('r20');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const box = { current: body } as RefObject<HTMLElement | null>;
  act(() => root.render(<Parent box={box} />));
  seenByParent.length = 0;
  press();
  expect(onScreen('r20')).toBe(before);
  // The parent's layout effect (where App measures the slide) already saw the list put back.
  expect(seenByParent.at(-1)).toBe(700 + 418);
  act(() => root.unmount());
  host.remove();
});
