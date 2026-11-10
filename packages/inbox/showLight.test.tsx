/**
 * Show's light (showLight.ts). Show never scrolls the list (the owner: "instead of scrolling me down all over the
 * … place"), so the rows it brought in can be out of view. What is proved:
 *  - a row is lit when it is in view in the list, for the light's whole time from that moment, however long after
 *    Show that is (the owner: "the timer should reset so I can still see the new one");
 *  - nothing here scrolls the list by itself;
 *  - the rows not yet in view are reported with the edge each is past (the list's pill counts them);
 *  - `go` scrolls to the nearest one past an edge, and holds the count back until the list is there;
 *  - a row whose group is closed stops being waited for;
 *  - without a list to measure in (a compose send's row), the rows are lit at once.
 *
 * happy-dom has no layout: each test gives the list and its rows their places; the clock is bun's fake one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { useShowLight } = await import('./showLight');
const { SHOW_LIT_MS } = await import('./settle');

let root: Root | null = null;
let host: HTMLElement | null = null;
let show: ReturnType<typeof useShowLight>;
let setGone: (ids: string[]) => void = () => {};
const IDS = ['t_a', 't_b', 't_c'];
/** Where each row's top is in the page; the list shows 0 to 600, a row is 50 tall. */
let tops: Record<string, number> = {};
const scrolled: { id: string; block?: string }[] = [];

function List() {
  show = useShowLight();
  const [gone, set] = useState<string[]>([]);
  setGone = (ids) => act(() => set(ids));
  return (
    <div className="ib-lbody">
      {IDS.filter((id) => !gone.includes(id)).map((id) => (
        <button key={id} type="button" data-thread-id={id} data-lit={show.lit.has(id) ? '' : undefined} />
      ))}
    </div>
  );
}

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect;
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;
const realRects = hasDom ? HTMLElement.prototype.getClientRects : undefined;
const realScroll = hasDom ? HTMLElement.prototype.scrollIntoView : undefined;

beforeEach(() => {
  if (!hasDom) return;
  tops = { t_a: 100, t_b: 900, t_c: 950 };
  scrolled.length = 0;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.getAttribute('data-thread-id');
    return id ? rect(tops[id]!, 50) : rect(0, 600);
  };
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (this.isConnected ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList;
  };
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
    scrolled.push({ id: this.getAttribute('data-thread-id')!, block: typeof options === 'object' ? options.block : undefined });
  };
  jest.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<List />));
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  jest.useRealTimers();
  HTMLElement.prototype.getBoundingClientRect = realRect!;
  HTMLElement.prototype.getClientRects = realRects!;
  HTMLElement.prototype.scrollIntoView = realScroll!;
});

const body = () => host!.querySelector<HTMLElement>('.ib-lbody')!;
const litRows = () => IDS.filter((id) => host!.querySelector(`[data-thread-id="${id}"]`)?.hasAttribute('data-lit'));
const pass = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
/** The reader scrolls the list: every row moves up by `by`. */
function scroll(by: number): void {
  for (const id of IDS) tops[id]! -= by;
  act(() => void body().dispatchEvent(new Event('scroll')));
}
const ALL = new Set(IDS);

test.skipIf(!hasDom)('each row is lit when it is in view, for its whole time from then; Show scrolls nothing', () => {
  act(() => show.light(ALL, 0, body()));
  pass(1);
  // The row in view is lit; the two below are reported, past the bottom edge.
  expect(litRows()).toEqual(['t_a']);
  expect(show.unseen).toEqual([{ id: 't_b', edge: 'bottom' }, { id: 't_c', edge: 'bottom' }]);
  expect(scrolled).toEqual([]);

  // Much later than the light's own length, the reader scrolls down to them: their light is fresh.
  pass(SHOW_LIT_MS * 3);
  expect(litRows()).toEqual([]);
  expect(show.unseen).toHaveLength(2);
  scroll(500);
  expect(litRows()).toEqual(['t_b', 't_c']);
  expect(show.unseen).toEqual([]);
  pass(SHOW_LIT_MS - 1);
  expect(litRows()).toEqual(['t_b', 't_c']);
  pass(1);
  expect(litRows()).toEqual([]);
  // The first row is not lit a second time when it comes back into view.
  scroll(-500);
  expect(litRows()).toEqual([]);
});

test.skipIf(!hasDom)('a row scrolled past is reported at the top edge; one mostly out of view is not yet seen', () => {
  tops = { t_a: -400, t_b: 580, t_c: 900 };
  act(() => show.light(ALL, 0, body()));
  pass(1);
  // 20 of t_b's 50 px show: not in view yet.
  expect(litRows()).toEqual([]);
  expect(show.unseen).toEqual([{ id: 't_a', edge: 'top' }, { id: 't_b', edge: 'bottom' }, { id: 't_c', edge: 'bottom' }]);
  scroll(20);
  expect(litRows()).toEqual(['t_b']);
});

test.skipIf(!hasDom)('the light waits for the rows to slide into place', () => {
  act(() => show.light(ALL, 280, body()));
  pass(279);
  expect(litRows()).toEqual([]);
  expect(show.unseen).toEqual([]);
  pass(1);
  expect(litRows()).toEqual(['t_a']);
  expect(show.unseen).toHaveLength(2);
});

test.skipIf(!hasDom)('go scrolls to the nearest row past that edge, to the middle, and holds the count back until the list is there', () => {
  act(() => show.light(ALL, 0, body()));
  pass(1);
  act(() => show.go('bottom'));
  expect(scrolled).toEqual([{ id: 't_b', block: 'center' }]);
  expect(document.activeElement?.getAttribute('data-thread-id')).toBe('t_b');
  // On the way there the count does not change under the reader.
  scroll(200);
  expect(show.unseen).toHaveLength(2);
  // The scroll ends with one of the two in view: it is lit, and only now is the count told, the one that is left.
  scroll(150);
  expect(litRows()).toEqual(['t_a', 't_b']);
  expect(show.unseen).toHaveLength(2);
  act(() => void body().dispatchEvent(new Event('scrollend')));
  expect(show.unseen).toEqual([{ id: 't_c', edge: 'bottom' }]);
});

test.skipIf(!hasDom)('go asked with Show (the pill\'s press) waits for the rows to slide into place, then goes, the count held back meanwhile', () => {
  act(() => {
    show.light(ALL, 280, body());
    show.go('bottom');
  });
  pass(279);
  expect(scrolled).toEqual([]);
  pass(1);
  expect(scrolled).toEqual([{ id: 't_b', block: 'center' }]);
  expect(litRows()).toEqual(['t_a']);
  expect(show.unseen).toEqual([]);
  scroll(500);
  act(() => void body().dispatchEvent(new Event('scrollend')));
  expect(litRows()).toEqual(['t_a', 't_b', 't_c']);
  expect(show.unseen).toEqual([]);
});

test.skipIf(!hasDom)('a row whose group is closed is no longer waited for', async () => {
  act(() => show.light(ALL, 0, body()));
  pass(1);
  expect(show.unseen).toHaveLength(2);
  // The list is drawn again without it: that redraw is measured, and the row is dropped.
  setGone(['t_c']);
  await act(async () => {});
  expect(show.unseen).toEqual([{ id: 't_b', edge: 'bottom' }]);
});

test.skipIf(!hasDom)('with no list to measure in, the rows are lit at once; a new light takes the last one\'s place', () => {
  act(() => show.light(new Set(['t_b']), 0));
  pass(1);
  expect(litRows()).toEqual(['t_b']);
  expect(show.unseen).toEqual([]);
  pass(SHOW_LIT_MS - 501);
  act(() => show.light(new Set(['t_c']), 0));
  pass(1);
  expect(litRows()).toEqual(['t_c']);
  pass(SHOW_LIT_MS - 2);
  expect(litRows()).toEqual(['t_c']);
  pass(2);
  expect(litRows()).toEqual([]);
});
