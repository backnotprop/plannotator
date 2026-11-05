/**
 * The board as a person meets it (DOM-gated, tests/dom-test-list.txt). What regresses if these fail:
 * - annotation is on from the start, so a click on a part opens a comment box;
 * - the Annotate button no longer turns pointing on, or an SVG part throws when picked;
 * - What to know stops reading as paragraphs, or an old board's Requirements vanish or crash;
 * - Show more cannot go back, or a bubble does not pop out, close on Esc, or avoid another number.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeRef, type ShapeVersion } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');
const { RefPeek, shapeRefPicture } = (hasDom ? await import('./refs') : {}) as typeof import('./refs');

const ID = 'shp_board_test';
const PICTURE = { html: '<p data-mark="whistle">One whistle</p><svg><g data-mark="svg-part"><text>Kettle</text><text>boils</text></g></svg><span data-ref="1"></span>' };
const REFS: ShapeRef[] = [{ n: 1, kind: 'image', title: 'The dialog', sub: 'One line.', target: 'files/a.png' }];

function host(views: ShapeVersion['views'], refs: ShapeRef[] = REFS): ShapeHost {
  const at = '2026-11-04T10:00:00.000Z';
  const board: ShapeBoard = { title: 'Kettle', claim: 'Built.', views, refs };
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: 'Kettle', project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
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
    assetUrl: (_id: string, src: string) => `/assets/${src}`,
  } as ShapeHost;
}

let root: Root | null = null;
let unbridge: (() => void) | null = null;
// A wide board: this DOM measures everything as 0 wide, which reads as a phone.
let wide: PropertyDescriptor | undefined;
beforeAll(() => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
});
afterAll(() => {
  unbridge?.();
  if (wide) Object.defineProperty(HTMLElement.prototype, 'clientWidth', wide);
  else if (hasDom) delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const wait = () => act(() => new Promise((r) => setTimeout(r, 20)));
function inDrawing<T extends Element>(selector: string): T | null {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector<T>(selector);
    if (found) return found;
  }
  return null;
}
const dock = (words: string) => [...document.querySelectorAll<HTMLElement>('.shp-tbtn')].find((b) => b.textContent?.includes(words) || b.title === 'Stop annotating' && words === 'Annotate') ?? null;
const click = (el: Element, composed = true) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed })); });
const popover = () => document.querySelector('[data-comment-popover]');

async function mount(views: ShapeVersion['views'], props: Partial<React.ComponentProps<typeof ShapeSurface>> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host(views)} id={ID} {...props} />));
  for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
  await wait();
}

describe.if(hasDom)('annotation: off until asked for', () => {
  test('a click on a part does nothing, and the pointing tools are not in the dock', async () => {
    await mount({ picture: PICTURE });
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(popover()).toBeNull();
    expect(dock('Annotate')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('.shp-tstrip button').length).toBe(1);
  });

  test('Annotate turns it on, a part then opens its box, and off it stops again', async () => {
    await mount({ picture: PICTURE });
    await click(dock('Annotate')!);
    expect(dock('Annotate')?.getAttribute('aria-pressed')).toBe('true');
    // Select and Pinpoint only: the board's box decides the action.
    expect(document.querySelectorAll('.shp-tstrip button').length).toBe(3);
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(popover()?.textContent).toContain('One whistle');
    await click(dock('Annotate')!);
    expect(popover()).toBeNull();
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(popover()).toBeNull();
  });

  test('a part inside an SVG can be picked, and its quote is its labels', async () => {
    await mount({ picture: PICTURE });
    await click(dock('Annotate')!);
    await click(inDrawing('[data-mark="svg-part"]')!);
    expect(popover()?.textContent).toContain('Kettle boils');
  });
});

describe.if(hasDom)('What to know', () => {
  test('its words are paragraphs, each one a part, with references live', async () => {
    await mount({ picture: PICTURE, know: 'First **point** [^1].\n\nSecond **uses `code` here**.' }, { initialView: 'know' });
    const know = document.querySelector('.shp-know')!;
    expect([...know.querySelectorAll('p')].map((p) => p.getAttribute('data-mark'))).toEqual(['know-1', 'know-2']);
    expect(know.querySelector('b')?.textContent).toBe('point');
    expect(know.querySelector('.shp-rb')?.textContent).toBe('1');
    expect(know.querySelector('b code')?.textContent).toBe('code');
    expect(dock('What to know')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.shp-dock')?.textContent).not.toContain('Requirements');
  });

  test('a paragraph can be pointed at once annotating', async () => {
    await mount({ know: 'Only this.' }, { initialView: 'know' });
    await click(dock('Annotate')!);
    await click(document.querySelector('[data-mark="know-1"]')!);
    expect(popover()?.textContent).toContain('Only this.');
  });

  test('an old board opens: heading, group names, every line, the foot, with no crash', async () => {
    const reqs = {
      heading: 'What I understand',
      groups: [
        { id: 'who', label: 'Who gets it', items: [{ id: 'r-who', text: 'You, **never** a guest [^1]', code: { path: 'src/who.ts', line: 10 } }, { id: 'r-two', text: 'Second line' }] },
        { id: 'none', label: 'Empty group', items: [] },
      ],
      foot: [{ label: 'Open', text: 'Nothing.' }],
    };
    await mount({ reqs }, { initialView: 'know' });
    const know = document.querySelector('.shp-know')!;
    for (const words of ['What I understand', 'Who gets it', 'You, never a guest', 'Second line', 'Open:', 'Nothing.']) expect(know.textContent).toContain(words);
    expect(know.textContent).not.toContain('Empty group');
    expect(know.querySelector('[data-mark="r-two"]')).not.toBeNull();
    expect(dock('What to know')).not.toBeNull();
  });

  test('an old board with both a Picture and Requirements has the tab, and a board with neither words has none', async () => {
    await mount({ picture: PICTURE });
    expect(dock('What to know')).toBeNull();
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    await mount({ picture: PICTURE, reqs: { groups: [] } });
    expect(dock('What to know')).not.toBeNull();
  });

  test('opened on the view a board does not have, it lands on one it does', async () => {
    await mount({ picture: PICTURE }, { initialView: 'know' });
    await wait();
    expect(dock('Picture')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe.if(hasDom)('Show more', () => {
  const picture = { ...PICTURE, more: { html: '<p data-mark="deep">The fuller drawing</p>' } };

  test('only a Picture with more has it, and it goes there and back', async () => {
    await mount({ picture: PICTURE });
    expect(document.querySelector('.shp-more')).toBeNull();
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    await mount({ picture });
    const button = document.querySelector<HTMLElement>('.shp-more')!;
    expect(button.textContent).toBe('Show more');
    await click(button);
    for (let i = 0; i < 40 && !inDrawing('.shp-view [data-mark="deep"], [data-mark="deep"]'); i++) await wait();
    expect(inDrawing('[data-mark="deep"]')).not.toBeNull();
    expect(button.textContent).toBe('Back to the main board');
    await click(button);
    expect(button.textContent).toBe('Show more');
  });

  test('leaving the view comes back to the main board', async () => {
    await mount({ picture, know: 'Words.' });
    await click(document.querySelector('.shp-more')!);
    await click(dock('What to know')!);
    await click(dock('Picture')!);
    expect(document.querySelector('.shp-more')?.textContent).toBe('Show more');
  });
});

describe.if(hasDom)('a reference\'s bubble', () => {
  const peekProps = { canOpen: true, resolveSrc: (s: string) => `/assets/${s}`, onOpen: () => {}, onEnter: () => {}, onLeave: () => {} };
  const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

  test('the picture it shows: the first the board holds; never one from outside', () => {
    expect(shapeRefPicture({ n: 1, kind: 'link', title: 'T', target: 'https://example.com', images: [{ src: 'https://evil.invalid/a.png', alt: '' }, { src: 'files/b.png', alt: 'B' }] })?.src).toBe('files/b.png');
    expect(shapeRefPicture({ n: 1, kind: 'image', title: 'T', target: 'files/a.png' })?.src).toBe('files/a.png');
    expect(shapeRefPicture({ n: 1, kind: 'file', title: 'T', target: 'a.ts' })).toBeNull();
  });

  test('a crop shows only that part; a picture with none shows whole', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const ref: ShapeRef = { n: 1, kind: 'image', title: 'T', target: 'files/a.png', images: [{ src: 'files/a.png', alt: 'A', crop: [0.25, 0, 0.5, 0.5] }] };
    await act(async () => root!.render(<RefPeek reference={ref} anchor={rect(100, 100, 20, 20)} bounds={rect(0, 0, 1000, 800)} {...peekProps} />));
    const crop = document.querySelector<HTMLElement>('.shp-peek-crop')!;
    expect(crop.style.backgroundSize).toContain('200%');
    expect(crop.style.backgroundPosition).toContain('50%');
    await act(async () => root!.render(<RefPeek reference={{ ...ref, images: [{ src: 'files/a.png', alt: 'A' }] }} anchor={rect(100, 100, 20, 20)} bounds={rect(0, 0, 1000, 800)} {...peekProps} />));
    expect(document.querySelector('.shp-peek img')?.getAttribute('src')).toBe('/assets/files/a.png');
  });

  test('it takes the side that hides no other number', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const ref: ShapeRef = { n: 1, kind: 'file', title: 'T', target: 'a.ts' };
    // happy-dom gives the bubble no size, and the choice needs one.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 });
    try {
      const place = async (obstacles: { rect: DOMRect; number: boolean }[]) => {
        await act(async () => root!.render(<RefPeek key={Math.random()} reference={ref} anchor={rect(500, 400, 20, 20)} bounds={rect(0, 0, 1000, 800)} obstacles={obstacles} onClose={() => {}} />));
        return document.querySelector('.shp-peek')!.getAttribute('data-side');
      };
      expect(await place([])).toBe('right');
      expect(await place([{ rect: rect(600, 420, 20, 20), number: true }])).toBe('left');
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
    }
  });

  test('a number on the board pops it out, Esc closes it first, and the board stays', async () => {
    await mount({ picture: PICTURE });
    const num = inDrawing('[data-ref="1"]')!;
    await act(async () => { num.dispatchEvent(Object.assign(new MouseEvent('pointerover', { bubbles: true, composed: true }), { pointerType: 'mouse' })); });
    for (let i = 0; i < 40 && !document.querySelector('.shp-peek'); i++) await wait();
    expect(document.querySelector('.shp-peek')?.textContent).toContain('One line.');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    await wait();
    expect(document.querySelector('.shp-peek')).toBeNull();
    expect(document.querySelector('.shp-surface')).not.toBeNull();
  });
});
