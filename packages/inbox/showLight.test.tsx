/**
 * Show's light (showLight.ts): the rows Show brought in are lit for `SHOW_LIT_MS`. After a press on the list's
 * pill the list scrolls to them, perhaps from far, and the owner asked that the light be fresh when the reader
 * gets there ("if I hit the pill, then the timer should reset so I can still see the new one"). What is proved:
 * the light's time starts when the row the list scrolls to is in view, not at the press and not when the message
 * arrived, and lasts its whole length from there; a Show beside its rows lights them as before.
 *
 * happy-dom has no layout: a stand-in IntersectionObserver says when the row is in view; the clock is bun's fake one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { useShowLight } = await import('./showLight');
const { SHOW_LIT_MS } = await import('./settle');

class FakeObserver {
  static live: FakeObserver | null = null;
  target: Element | null = null;
  constructor(readonly notify: (entries: IntersectionObserverEntry[]) => void) {
    FakeObserver.live = this;
  }
  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {
    if (FakeObserver.live === this) FakeObserver.live = null;
  }
  takeRecords() {
    return [];
  }
}
/** The browser reports how much of the watched row shows in the list. */
const rowShows = (ratio: number) => act(() => FakeObserver.live?.notify([{ target: FakeObserver.live.target, intersectionRatio: ratio } as unknown as IntersectionObserverEntry]));

let root: Root | null = null;
let host: HTMLElement | null = null;
let light: ReturnType<typeof useShowLight>['light'] = () => {};
const realObserver = globalThis.IntersectionObserver;

/** A list with two rows Show brought in, lit as the window's rows are (`data-lit`). */
function List() {
  const show = useShowLight();
  light = show.light;
  return (
    <div className="ib-lbody">
      {['t_a', 't_b'].map((id) => (
        <button key={id} type="button" data-thread-id={id} data-lit={show.lit.has(id) ? '' : undefined} />
      ))}
    </div>
  );
}

beforeEach(() => {
  if (!hasDom) return;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
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
  globalThis.IntersectionObserver = realObserver;
  FakeObserver.live = null;
});

const row = (id: string) => host!.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const litRows = () => ['t_a', 't_b'].filter((id) => row(id).hasAttribute('data-lit'));
const pass = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const BOTH = new Set(['t_a', 't_b']);

test.skipIf(!hasDom)('after the pill\'s press the light starts when the row is in view, and lasts its whole time from there', () => {
  // The message arrived, and four seconds went by before the press: neither is the light's clock.
  pass(4000);
  act(() => light(BOTH, 0, row('t_a')));
  expect(litRows()).toEqual([]);

  // The list is still scrolling to the row: no light runs out of sight, however long the scroll takes.
  rowShows(0);
  pass(700);
  rowShows(0.4);
  pass(SHOW_LIT_MS);
  expect(litRows()).toEqual([]);

  // The row is in view: every row Show brought in is lit, for the light's whole time from this moment.
  rowShows(1);
  pass(1);
  expect(litRows()).toEqual(['t_a', 't_b']);
  pass(SHOW_LIT_MS - 2);
  expect(litRows()).toEqual(['t_a', 't_b']);
  pass(1);
  expect(litRows()).toEqual([]);
});

test.skipIf(!hasDom)('the rows\' slide into place still comes first when the row is in view at once', () => {
  act(() => light(BOTH, 280, row('t_a')));
  rowShows(1);
  pass(279);
  expect(litRows()).toEqual([]);
  pass(1);
  expect(litRows()).toEqual(['t_a', 't_b']);
  pass(SHOW_LIT_MS);
  expect(litRows()).toEqual([]);
});

test.skipIf(!hasDom)('Show beside its rows lights them without waiting on the view, and a new light takes the last one\'s place', () => {
  act(() => light(new Set(['t_a']), 0));
  pass(1);
  expect(litRows()).toEqual(['t_a']);
  expect(FakeObserver.live).toBeNull();

  // Another Show while the first light is on: only its rows, for their own whole time.
  pass(SHOW_LIT_MS - 501);
  act(() => light(new Set(['t_b']), 0));
  pass(1);
  expect(litRows()).toEqual(['t_b']);
  pass(SHOW_LIT_MS - 2);
  expect(litRows()).toEqual(['t_b']);
  pass(1);
  expect(litRows()).toEqual([]);
});
