/**
 * Show me in a dragged box (DOM-gated, tests/dom-test-list.txt). The box picks whole parts; its Show me asks for a new
 * board of them, with the box's picture. What regresses if these fail: a box shows two Show me buttons (the board's
 * and a stand-in), several parts go out under one part's name or none, one part loses its own name or its code, the
 * picture is dropped, or a host with no Show me (the standalone page) gets the button.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeVersion } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded, ShapeShowMeInput } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_box_show_me_test';
const PICTURE = {
  html: '<div data-mark="login"><b>Sign in</b> form</div><div data-mark="token" data-code="src/token.ts#L4-L9"><b>Token store</b></div><div data-mark="far"><b>Far away</b></div>',
};

function host(showMe?: ShapeHost['showMe']): ShapeHost {
  const at = '2026-11-07T10:00:00.000Z';
  const board: ShapeBoard = { title: 'Login', claim: 'Built.', views: { picture: PICTURE } as ShapeVersion['views'], refs: [] };
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: 'Login', project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
    version: { ...board, n: 1, at, base: null, through: null, by: null, parts: shapeParts(board) },
    seen: 1,
    notes: [],
    session: { state: 'live', agent: 'Claude Code' },
  };
  return {
    load: async () => data,
    version: async () => data.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
    ...(showMe ? { showMe } : {}),
  } as ShapeHost;
}

// Where each thing sits on the page: happy-dom lays nothing out, so a box could cover nothing.
const RECTS: [string, [number, number, number, number]][] = [
  ['.shp-stage', [0, 0, 1000, 800]],
  ['.board', [0, 0, 400, 300]],
  ['[data-mark="login"]', [10, 10, 110, 60]],
  ['[data-mark="token"]', [10, 100, 110, 150]],
  ['[data-mark="far"]', [300, 200, 390, 290]],
];
let root: Root | null = null;
let unbridge: (() => void) | null = null;
let wide: PropertyDescriptor | undefined;
let rect: PropertyDescriptor | undefined;
let computed: typeof window.getComputedStyle | undefined;
beforeAll(() => {
  if (!hasDom) return;
  // happy-dom computes no opacity: a part reads as hidden, and a box could take none.
  computed = window.getComputedStyle;
  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const style = computed!.call(window, el, pseudo);
    return new Proxy(style, { get: (target, key) => (key === 'opacity' ? target.opacity || '1' : Reflect.get(target, key, target)) });
  }) as typeof window.getComputedStyle;
  unbridge = bridgeSanitizerDom();
  wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const [l, t, r, b] = RECTS.find(([selector]) => this.matches(selector))?.[1] ?? [0, 0, 0, 0];
      return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON: () => ({}) } as DOMRect;
    },
  });
});
afterAll(() => {
  unbridge?.();
  if (!hasDom) return;
  if (wide) Object.defineProperty(HTMLElement.prototype, 'clientWidth', wide);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  if (rect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
  if (computed) window.getComputedStyle = computed;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const wait = () => act(() => new Promise((r) => setTimeout(r, 20)));
const popover = () => document.querySelector('[data-comment-popover]');
const buttons = (words: string) => [...(popover()?.querySelectorAll('button') ?? [])].filter((b) => b.textContent?.trim() === words);

async function mount(h: ShapeHost, boxSelect: React.ComponentProps<typeof ShapeSurface>['boxSelect'] = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={h} id={ID} readFirst boxSelect={boxSelect} />));
  for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
  await wait();
  await act(async () => document.querySelector<HTMLElement>('.shp-tstrip button[aria-label="Comment"]')!.click());
  await wait();
}

async function drag(from: [number, number], to: [number, number]) {
  const at = (type: string, [x, y]: [number, number]) => Object.assign(new MouseEvent(type, { bubbles: true, composed: true, button: 0, clientX: x, clientY: y }), { pointerType: 'mouse', pointerId: 1 });
  await act(async () => {
    document.querySelector('.shp-stage')!.dispatchEvent(at('pointerdown', from));
    window.dispatchEvent(at('pointermove', to));
    window.dispatchEvent(at('pointerup', to));
  });
  // The drag eats the click that ends it, for 60 ms.
  await act(() => new Promise((r) => setTimeout(r, 80)));
}

test.skipIf(!hasDom)('a box over two parts: one Show me, on "A part of the board" with both parts named, and the box’s picture', async () => {
  const asked: ShapeShowMeInput[] = [];
  // A box option's own Show me too: the host's is the box's, and only one shows.
  await mount(host((_id, input) => asked.push(input)), { onShowMe: () => { throw new Error('not the board’s Show me'); } });
  await drag([5, 5], [150, 160]);
  expect(popover()).not.toBeNull();
  expect(buttons('Show me').length).toBe(1);
  await act(async () => buttons('Show me')[0]!.click());
  expect(asked.length).toBe(1);
  expect(asked[0]).toMatchObject({ name: 'A part of the board', parts: ['Sign in', 'Token store'], words: '' });
  expect(asked[0]!.code).toBeUndefined();
  expect(asked[0]!.picture).toBeInstanceOf(Promise);
});

test.skipIf(!hasDom)('a box over one part: its own name and code, no list of parts, and the picture', async () => {
  const asked: ShapeShowMeInput[] = [];
  await mount(host((_id, input) => asked.push(input)));
  await drag([5, 95], [150, 160]);
  expect(buttons('Show me').length).toBe(1);
  await act(async () => buttons('Show me')[0]!.click());
  expect(asked[0]).toMatchObject({ name: 'Token store', code: 'src/token.ts#L4-L9' });
  expect(asked[0]!.parts).toBeUndefined();
  expect(asked[0]!.picture).toBeInstanceOf(Promise);
});

test.skipIf(!hasDom)('a host with no Show me (the standalone page, no live agent): the box has none, not even a stand-in', async () => {
  await mount(host());
  await drag([5, 5], [150, 160]);
  expect(popover()).not.toBeNull();
  expect(buttons('Show me').length).toBe(0);
});
