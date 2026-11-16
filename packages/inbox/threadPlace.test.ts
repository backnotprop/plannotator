/**
 * A file opening beside the thread (threadPlace.ts `stayBeside`, `holdPlace` with `stay`). The column narrows to 440 px
 * at times frames after the place was read, and the browser's scroll anchoring then moved the view by the rows that grew
 * above what it anchored on: the sender row went above the view (CI run 43865115724, inbox-attachments.spec.ts "the
 * header says the message has files": scrollTop 17 to 62 in the frame the column narrowed, no script scroll).
 *
 * What regresses: an anchoring jump left in place; the hold moving a view whose place is still in view (that moves the
 * sender row away just as anchoring did); the hold not putting the place back once it would leave the view; anchoring
 * left on while it holds, or off after it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { holdPlace, stayBeside, type ThreadPlace } from './threadPlace';

const hasDom = typeof document !== 'undefined';

const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top }) as DOMRect;

let root: HTMLElement | null = null;
/** The hold a test started, stopped even when the test fails before stopping it. */
let stopHold: (() => void) | null = null;
const realObserver = globalThis.ResizeObserver;
afterEach(() => {
  stopHold?.();
  stopHold = null;
  root?.remove();
  root = null;
  globalThis.ResizeObserver = realObserver;
});

/**
 * happy-dom has no layout: a thread's view (0 to 800 on screen) scrolled to 17, and the element that holds the place,
 * `box()` its top and bottom in the thread's content (moved as rows above it grow), drawn at that less the scroll.
 */
function thread(box: () => [number, number]) {
  root = document.createElement('div');
  root.innerHTML = '<div data-message-article="m1"><div data-open-head=""></div></div>';
  document.body.appendChild(root);
  const body = root;
  let scrollTop = 17;
  Object.defineProperty(body, 'scrollTop', { get: () => scrollTop, set: (v: number) => void (scrollTop = v), configurable: true });
  Object.defineProperty(body, 'clientHeight', { get: () => 800, configurable: true });
  body.getBoundingClientRect = () => rect(0, 800);
  body.getClientRects = () => [rect(0, 800)] as unknown as DOMRectList;
  const el = body.querySelector<HTMLElement>('[data-open-head]')!;
  el.getBoundingClientRect = () => rect(box()[0] - scrollTop, box()[1] - scrollTop);
  el.getClientRects = () => [el.getBoundingClientRect()] as unknown as DOMRectList;
  const place: ThreadPlace = { el, selector: null, offset: 40, scrollTop: 17 };
  return { body, place };
}

/** A ResizeObserver whose callback the test calls: one resize of the view or its content. */
function observeByHand(): () => void {
  let fire = () => {};
  globalThis.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      fire = () => cb([], this as unknown as ResizeObserver);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => fire();
}

test.skipIf(!hasDom)('an anchoring jump is undone, and a place still wholly in view needs no move', () => {
  let box: [number, number] = [57, 105];
  const t = thread(() => box);
  t.body.scrollTop = 62;
  expect(stayBeside(t.body, t.place)).toBe(true);
  expect(t.body.scrollTop).toBe(17);
  box = [700, 900];
  expect(stayBeside(t.body, t.place)).toBe(false);
});

test.skipIf(!hasDom)('held beside a file: the view stays while the place is in view, and is put back once it would leave', () => {
  const resize = observeByHand();
  let box: [number, number] = [57, 105];
  const t = thread(() => box);
  const stop = (stopHold = holdPlace(t.body, t.place, undefined, 60_000, t.body, true));
  expect(t.body.style.overflowAnchor).toBe('none');
  // The column narrows: the rows above grow, the place moves down but stays in view.
  box = [90, 154];
  resize();
  expect(t.body.scrollTop).toBe(17);
  // A later reflow pushes it out of the view: it goes back to 40 from the top.
  box = [790, 860];
  resize();
  expect(t.body.scrollTop).toBe(790 - 40);
  stop();
  expect(t.body.style.overflowAnchor).toBe('');
});
