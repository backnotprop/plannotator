import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { scrollWithPage, type PageScroll } from './scrollWithPage';

const hasDom = typeof document !== 'undefined' && !!process.env.DOM_TESTS;
const rect = (top: number, height: number) => ({ x: 0, y: top, left: 0, right: 800, width: 800, top, bottom: top + height, height, toJSON: () => ({}) }) as DOMRect;

function world(height: number, boxTop: number) {
  const page = document.createElement('div');
  page.style.overflowY = 'auto';
  const root = document.createElement('div');
  page.appendChild(root);
  document.body.appendChild(page);
  let scrollTop = 0;
  Object.defineProperty(page, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => void (scrollTop = v) });
  page.getBoundingClientRect = () => rect(0, 900);
  const moves: number[] = [];
  page.scrollTo = ((options: ScrollToOptions) => {
    scrollTop = options.top!;
    moves.push(scrollTop);
  }) as typeof page.scrollTo;
  const realGet = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this === root ? rect(boxTop - scrollTop, height) : realGet.call(this);
  };
  const scrolled: number[] = [];
  root.addEventListener('scroll', () => scrolled.push(root.scrollTop));
  const pageScroll = scrollWithPage(root);
  const scrollPage = (top: number) => {
    scrollTop = top;
    page.dispatchEvent(new Event('scroll'));
  };
  return { page, root, moves, scrolled, pageScroll, scrollPage, top: () => scrollTop, restore: () => { Element.prototype.getBoundingClientRect = realGet; page.remove(); } };
}

describe.skipIf(!hasDom)('a CodeView root scrolling with the page', () => {
  const savedInner = globalThis.innerHeight;
  let w: ReturnType<typeof world> | null = null;
  let undo: PageScroll | null = null;
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    Object.defineProperty(window, 'screen', { configurable: true, value: { height: 900 } });
  });
  afterEach(() => {
    undo?.undo();
    w?.restore();
    w = null;
    undo = null;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: savedInner });
  });
  const start = (height: number, boxTop: number) => {
    w = world(height, boxTop);
    undo = w.pageScroll;
    return w;
  };

  test('reports where the viewport is inside the box, the viewport as its height, and scroll only when that moved', () => {
    const { root, scrollPage, scrolled } = start(100_000, 300);
    expect(root.scrollTop).toBe(0);
    expect(root.getBoundingClientRect().height).toBe(900);
    scrollPage(200);
    expect(scrolled).toEqual([]);
    scrollPage(1300);
    expect(scrolled).toEqual([1000]);
  });

  test('a short box reports its own height: CodeView would hold its rows that far down', () => {
    const { root } = start(200, 300);
    expect(root.getBoundingClientRect().height).toBe(200);
  });

  test('a move inside the file moves the page by that much', () => {
    const { root, scrollPage, top } = start(100_000, 300);
    scrollPage(1300);
    root.scrollTo({ top: 1050, behavior: 'instant' });
    expect(top()).toBe(1350);
  });

  test('past the last whole window an anchor fix is a move from there, not a jump back', () => {
    const { root, scrollPage, top } = start(10_000, 0);
    scrollPage(9500);
    root.scrollTo({ top: 9140 });
    expect(top()).toBe(9540);
  });

  test('wholly above the viewport nothing moves the page: the browser keeps the place', () => {
    const { root, scrollPage, moves } = start(1000, 0);
    scrollPage(5000);
    root.scrollTo({ top: 200 });
    expect(moves).toEqual([]);
  });

  test('a jump asked for by name lands exactly, from past the end and from wholly above', () => {
    const { root, scrollPage, top, pageScroll } = start(10_000, 100);
    scrollPage(9700);
    pageScroll.expectJump();
    root.scrollTo({ top: 3000 });
    expect(top()).toBe(3100);
    scrollPage(50_000);
    pageScroll.expectJump();
    root.scrollTo({ top: 200 });
    expect(top()).toBe(300);
  });

  test('a person moving the page ends a jump under way and tells CodeView', () => {
    const { page, root, pageScroll, scrollPage, moves } = start(1000, 0);
    const heard: string[] = [];
    root.addEventListener('wheel', () => heard.push('wheel'));
    pageScroll.expectJump();
    page.dispatchEvent(new Event('wheel'));
    expect(heard).toEqual(['wheel']);
    scrollPage(5000);
    root.scrollTo({ top: 200 });
    expect(moves).toEqual([]);
  });

  test('undone, the root is a plain element again', () => {
    const { root, page, pageScroll, scrolled, scrollPage } = start(1000, 0);
    pageScroll.undo();
    undo = null;
    expect(Object.getOwnPropertyDescriptor(root, 'scrollTop')).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(root, 'scrollTo')).toBe(false);
    scrollPage(100);
    expect(scrolled).toEqual([]);
    expect(page.contains(root)).toBe(true);
  });
});
