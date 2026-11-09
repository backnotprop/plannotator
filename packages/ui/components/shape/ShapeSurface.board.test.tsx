/**
 * The board as a person meets it (DOM-gated, tests/dom-test-list.txt). What regresses if these fail:
 * - annotation is on from the start, so a click on a part opens a comment box;
 * - the Annotate button no longer turns pointing on, or an SVG part throws when picked;
 * - `views.know` (or an old board's Requirements) is drawn again, comes back as a tab, lights a dot, or crashes a board
 *   that has nothing else; an old #view=know or #view=reqs link stops opening the Shape view;
 * - Show more cannot go back, or a bubble does not pop out, close on Esc, or avoid another number.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { checkShapeBoard, shapeParts, type ShapeBoard, type ShapeRef, type ShapeVersion, type ShapeViewId } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');
const { RefPeek, shapeRefPicture } = (hasDom ? await import('./refs') : {}) as typeof import('./refs');
const { CodeSpanContext } = (hasDom ? await import('../LocalLinkContext') : {}) as typeof import('../LocalLinkContext');

const ID = 'shp_board_test';
const PICTURE = { html: '<p data-mark="whistle">One whistle</p><svg><g data-mark="svg-part"><text>Kettle</text><text>boils</text></g></svg><span data-ref="1"></span>' };
const REFS: ShapeRef[] = [{ n: 1, kind: 'image', title: 'The dialog', sub: 'One line.', target: 'files/a.png' }];

function host(views: ShapeVersion['views'], refs: ShapeRef[] = REFS, claim = 'Built.'): ShapeHost {
  const at = '2026-11-04T10:00:00.000Z';
  const board: ShapeBoard = { title: 'Kettle', claim, views, refs };
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
  act(() => root!.render(<ShapeSurface host={props.host ?? host(views)} id={ID} readFirst {...props} />));
  for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
  await wait();
}

describe.if(hasDom)('a dragged box is opt-in', () => {
  const press = (el: Element, type: string, x: number) =>
    el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, composed: true, button: 0, clientX: x, clientY: 10 }), { pointerType: 'mouse', pointerId: 1 }));
  const dragAcross = async () => {
    const stage = document.querySelector('.shp-stage')!;
    await act(async () => {
      press(stage, 'pointerdown', 10);
      press(window as unknown as Element, 'pointermove', 90);
    });
  };

  test('a host without boxSelect: no cross, no box, no words on its drawing', async () => {
    await mount({ picture: PICTURE });
    await click(dock('Annotate')!);
    await wait();
    await dragAcross();
    expect(!!document.querySelector('.shp-stage.boxing')).toBe(false);
    expect(!!inDrawing('.board.boxable')).toBe(false);
    expect(!!document.querySelector('.shp-box-band')).toBe(false);
  });

  test('with it: one crosshair in place of Annotate and its tools; a drag draws the band only once it is on', async () => {
    await mount({ picture: PICTURE }, { boxSelect: {} });
    expect(dock('Annotate')).toBe(null);
    expect(document.querySelectorAll('.shp-tstrip button').length).toBe(1);
    expect(!!document.querySelector('.shp-stage.boxing')).toBe(false);
    await dragAcross();
    expect(!!document.querySelector('.shp-box-band')).toBe(false);
    await click(document.querySelector('.shp-tstrip button[aria-label="Comment"]')!);
    await wait();
    expect(!!document.querySelector('.shp-stage.boxing')).toBe(true);
    expect(!!inDrawing('.board.boxable')).toBe(true);
    await dragAcross();
    expect(!!document.querySelector('.shp-box-band')).toBe(true);
  });
});

describe.if(hasDom)('a part’s composer: a host without boxSelect keeps it as it was', () => {
  const header = () => popover()?.querySelector('span.truncate')?.textContent;
  const LONG = 'A whistle that sings louder than the kettle under it, every morning';

  test('its header is the quoted label', async () => {
    await mount({ picture: PICTURE });
    await click(dock('Annotate')!);
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(header()).toBe('"Shape · “One whistle”"');
  });

  test('a long part’s is cut where it was', async () => {
    await mount({ picture: { html: `<p data-mark="long">${LONG}</p>` } });
    await click(dock('Annotate')!);
    await click(inDrawing('[data-mark="long"]')!);
    expect(header()).toBe(`"${`Shape · “${LONG.slice(0, 46)}…”`.slice(0, 50)}..."`);
  });

  test('with it, the header is the label as written', async () => {
    await mount({ picture: PICTURE }, { boxSelect: {} });
    await click(document.querySelector('.shp-tstrip button[aria-label="Comment"]')!);
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(header()).toBe('Shape · “One whistle”');
  });

  test('with it, the composer’s own buttons work with a panel open beside it (its clicks come through a portal)', async () => {
    const sent: unknown[] = [];
    const h = host({ picture: PICTURE });
    h.note = (async (_id: string, note: unknown) => { sent.push(note); throw new Error('stop here'); }) as ShapeHost['note'];
    await mount({ picture: PICTURE }, { boxSelect: {}, host: h });
    await click(document.querySelector('.shp-tstrip button[aria-label="Comment"]')!);
    await click(inDrawing('[data-mark="whistle"]')!);
    await click(dock('References')!);
    expect(dock('References')?.getAttribute('aria-pressed')).toBe('true');
    const box = popover()!.querySelector<HTMLTextAreaElement>('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box, 'louder');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const change = [...popover()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Change it')!;
    await click(change);
    await wait();
    expect(sent.length).toBe(1);
  });
});

describe.if(hasDom)('a host that does not ask for readFirst keeps its board', () => {
  const asHost = { readFirst: undefined };

  test('a part can be marked at once, with no Annotate button, and the strip keeps its modes', async () => {
    await mount({ picture: PICTURE }, asHost);
    expect(!!dock('Annotate')).toBe(false);
    expect(!!document.querySelector('.shp-tstrip')).toBe(true);
    await click(inDrawing('[data-mark="whistle"]')!);
    for (let i = 0; i < 20 && !popover(); i++) await wait();
    expect(!!popover()).toBe(true);
  });

  test('a number lights and opens: no bubble, no file read on hover, its title kept', async () => {
    const reads: string[] = [];
    const refs: ShapeRef[] = [{ n: 1, kind: 'file', title: 'The file', sub: 'One line.', target: 'a.ts', line: 3 }];
    await mount({ picture: PICTURE }, { ...asHost, host: { ...host({ picture: PICTURE }, refs), readFile: async (path: string) => { reads.push(path); return null; } } as ShapeHost });
    const num = inDrawing<HTMLElement>('[data-ref="1"]')!;
    expect(num.getAttribute('title')).toBe('The file');
    await act(async () => { num.dispatchEvent(Object.assign(new MouseEvent('pointerover', { bubbles: true, composed: true }), { pointerType: 'mouse' })); });
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(!!document.querySelector('.shp-peek')).toBe(false);
    expect(reads).toEqual([]);
  });

  test('a link with a picture still opens the link', async () => {
    const refs: ShapeRef[] = [{ n: 1, kind: 'link', title: 'Page', target: 'https://example.com/a', images: [{ src: 'files/a.png', alt: 'A' }] }];
    const opened: unknown[] = [];
    const open = window.open;
    window.open = ((...args: unknown[]) => { opened.push(args[0]); return null; }) as typeof window.open;
    try {
      await mount({ picture: PICTURE }, { ...asHost, host: host({ picture: PICTURE }, refs) });
      await click(inDrawing('[data-ref="1"]')!);
      await wait();
      expect(opened).toEqual(['https://example.com/a']);
      expect(!!document.querySelector('.shp-lightbox, [data-image-lightbox]')).toBe(false);
    } finally {
      window.open = open;
    }
  });

  test('a saved Requirements view and its notes open in the Shape view, with the Requirements not shown', async () => {
    const reqs = { groups: [{ id: 'g', label: 'Who', items: [{ id: 'r-1', text: 'Line one' }] }] };
    const old = host({ picture: PICTURE, reqs } as ShapeVersion['views']);
    const load = old.load;
    old.load = async (shapeId: string) => {
      const data = await load.call(old, shapeId);
      const note = { id: 'n1', kind: 'ask', v: 1, view: 'reqs', part: 'r-1', quote: 'Line one', text: 'Why this?', from: 'you', re: null, delivered: null, at: data.version.at };
      return { ...data, notes: [note as unknown as ShapeLoaded['notes'][number]] };
    };
    await mount({}, { ...asHost, host: old, initialView: 'reqs' as ShapeViewId, initialPanel: 'ask' });
    expect(document.querySelector('.shp-know')).toBeNull();
    expect(dock('Shape')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Why this?');
    expect(document.body.textContent).not.toContain('reqs');
  });
});

describe.if(hasDom)('annotation: off until asked for', () => {
  test('a click on a part does nothing, and the pointing tools are not in the dock', async () => {
    await mount({ picture: PICTURE });
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(!!popover()).toBe(false);
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
    expect(!!popover()).toBe(false);
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(!!popover()).toBe(false);
  });

  test('a part inside an SVG can be picked, and its quote is its labels', async () => {
    await mount({ picture: PICTURE });
    await click(dock('Annotate')!);
    await click(inDrawing('[data-mark="svg-part"]')!);
    expect(popover()?.textContent).toContain('Kettle boils');
  });
});

describe.if(hasDom)('views.know is not shown (approval shape-know-removed)', () => {
  const bar = () => [...document.querySelectorAll<HTMLElement>('.shp-dock [aria-label="Views"] .shp-tbtn')].map((b) => b.title);
  const shown = () => document.querySelector('.shp-view:not(.leaving)')!;
  const WORDS = 'Sent anyway, never shown [^1].\n\nA second paragraph.';

  // Agents are no longer asked for views.know, but one that sends it anyway is not refused: nothing draws its words.
  test('a board an agent sends with views.know passes the check, and its words are nowhere on the board', async () => {
    const sent = checkShapeBoard({ title: 'Kettle', claim: 'Built.', views: { picture: PICTURE, know: WORDS }, refs: REFS });
    expect('errors' in sent ? sent.errors : []).toEqual([]);
    if (!('value' in sent)) return;
    expect(sent.value.views.know).toBe(WORDS);
    await mount(sent.value.views);
    expect(document.querySelector('.shp-know')).toBeNull();
    expect(document.querySelector('[data-mark="know-1"]')).toBeNull();
    expect(document.body.textContent).not.toContain('never shown');
    expect(document.body.textContent).not.toContain('second paragraph');
    // The drawing is as it is with no words.
    expect(shown().classList.contains('v-picture')).toBe(true);
    expect(inDrawing('[data-mark="whistle"]')).not.toBeNull();
    expect(bar()).toEqual(['Shape']);
  });

  // On purpose: the owner's words for the bar (Picture became Shape, What to know went).
  test('the bar says Shape, How it works, Code, with no tab for the words', async () => {
    await mount({ picture: PICTURE, how: PICTURE, know: 'Only this.', code: { stage: 'after', guide: { title: 'G', intent: 'I', sections: [] } } as unknown as NonNullable<ShapeVersion['views']['code']> });
    expect(bar()).toEqual(['Shape', 'How it works', 'Code']);
    expect(document.querySelector('.shp-dock')?.textContent).not.toContain('Picture');
    expect(document.querySelector('.shp-dock')?.textContent).not.toContain('Know');
  });

  test('on a phone too: the active tab reads Shape, and no tab reads Know', async () => {
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 390 });
    try {
      await mount({ picture: PICTURE, know: 'Only this.' });
      expect(document.querySelector('.shp-root')?.classList.contains('phone')).toBe(true);
      expect(document.querySelector('.shp-dock [aria-label="Views"] .shp-tbtn.on .tl')?.textContent).toBe('Shape');
      expect(bar()).toEqual(['Shape']);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', was);
    }
  });

  test('a board whose only view is views.know, or old Requirements, opens with its title and claim, no tab and nothing drawn', async () => {
    for (const views of [{ know: 'Only this.' }, { reqs: { groups: [{ id: 'g', label: 'Who', items: [{ id: 'r-1', text: 'Line one' }] }] } }] as ShapeVersion['views'][]) {
      await mount(views);
      expect(document.querySelector('.shp-head h1')?.textContent).toContain('Kettle');
      expect(document.querySelector('.shp-claim')?.textContent).toBe('Built.');
      expect(bar()).toEqual([]);
      // No empty Views group left in the dock.
      expect(document.querySelector('.shp-dock [aria-label="Views"]')).toBeNull();
      expect(shown().textContent).toBe('');
      expect(document.body.textContent).not.toContain('Only this.');
      expect(document.body.textContent).not.toContain('Line one');
      act(() => root!.unmount());
      root = null;
      document.body.innerHTML = '';
    }
  });

  test('with How it works beside the words and no drawing, the bar has How it works alone and opens on it', async () => {
    await mount({ how: PICTURE, know: 'Only this.' });
    await wait();
    expect(bar()).toEqual(['How it works']);
    expect(shown().classList.contains('v-how')).toBe(true);
    expect(document.body.textContent).not.toContain('Only this.');
  });

  for (const old of ['know', 'reqs']) {
    test(`an old #view=${old} link opens the Shape view, and the address moves on`, async () => {
      const seen: string[] = [];
      await mount({ picture: PICTURE, how: PICTURE, know: 'First.' }, { initialView: old as ShapeViewId, onNavigate: (s) => { seen.push(s.view); } });
      await wait();
      expect(shown().classList.contains('v-picture')).toBe(true);
      expect(dock('Shape')?.getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector('.shp-view.v-know')).toBeNull();
      expect(seen.at(-1)).toBe('picture');
    });
  }

  test('opened on a view the board does not have, it lands on one it does', async () => {
    await mount({ how: PICTURE }, { initialView: 'know' });
    await wait();
    expect(dock('How it works')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('a new version that changes only the words lights no dot and names no view', async () => {
    let send: ((e: Parameters<Parameters<ShapeHost['events']>[1]>[0]) => void) | null = null;
    const h = host({ picture: PICTURE, how: PICTURE, know: 'First.' });
    h.events = (_id, listener) => {
      send = listener;
      return () => {};
    };
    await mount({}, { host: h, initialView: 'how' });
    const data = await h.load(ID);
    const nextBoard: ShapeBoard = { title: 'Kettle', claim: 'Built.', views: { picture: PICTURE, how: PICTURE, know: 'First, changed.' }, refs: REFS };
    // A version saved while the words were parts still carries them: they light nothing either.
    const oldParts = [...shapeParts(nextBoard), { view: 'know' as const, id: 'know-1', text: 'First, changed.' }];
    await act(async () => send!({ type: 'version', shape: data.shape, version: { ...nextBoard, n: 2, at: data.version.at, base: 1, through: null, by: null, parts: oldParts } }));
    for (let i = 0; i < 40 && !document.querySelector('.shp-pill'); i++) await wait();
    expect(document.querySelector('.shp-pill')?.textContent).toContain('Board updated · v2');
    expect(document.querySelector('.shp-tdot')).toBeNull();
    expect(document.body.textContent).not.toContain('First, changed.');
  });
});

describe.if(hasDom)('Show more', () => {
  const picture = { ...PICTURE, more: { html: '<p data-mark="deep">The fuller drawing</p>' } };

  test('only a Picture with more has it, and it goes there and back', async () => {
    await mount({ picture: PICTURE });
    expect(!!document.querySelector('.shp-more')).toBe(false);
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    await mount({ picture });
    const button = document.querySelector<HTMLElement>('.shp-more')!;
    expect(button.textContent).toBe('Show more');
    await click(button);
    for (let i = 0; i < 40 && !inDrawing('.shp-view [data-mark="deep"], [data-mark="deep"]'); i++) await wait();
    expect(!!inDrawing('[data-mark="deep"]')).toBe(true);
    expect(button.textContent).toBe('Back to the main board');
    await click(button);
    expect(button.textContent).toBe('Show more');
  });

  test('Esc comes back to the main board, and is not left for the host to close it', async () => {
    await mount({ picture });
    const button = document.querySelector<HTMLElement>('.shp-more')!;
    await click(button);
    expect(button.textContent).toBe('Back to the main board');
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(document.querySelector('.shp-more')?.textContent).toBe('Show more');
    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    await act(async () => { window.dispatchEvent(again); });
    expect(again.defaultPrevented).toBe(false);
  });

  test('leaving the view comes back to the main board', async () => {
    await mount({ picture, how: PICTURE });
    await click(document.querySelector('.shp-more')!);
    await click(dock('How it works')!);
    await click(dock('Shape')!);
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
        await act(async () => root!.render(<RefPeek key={Math.random()} reference={ref} anchor={rect(500, 400, 20, 20)} bounds={rect(0, 0, 1000, 800)} obstacles={obstacles} {...peekProps} />));
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
    expect(!!document.querySelector('.shp-peek')).toBe(false);
    expect(!!document.querySelector('.shp-surface')).toBe(true);
  });
});

describe.if(hasDom)('a host\'s control beside a file (fileAction)', () => {
  test('an open menu keeps its Esc: the number stays open, and the board does not take the key', async () => {
    await mount({ picture: PICTURE });
    const num = inDrawing('[data-ref="1"]')!;
    await act(async () => { num.dispatchEvent(Object.assign(new MouseEvent('pointerover', { bubbles: true, composed: true }), { pointerType: 'mouse' })); });
    for (let i = 0; i < 40 && !document.querySelector('.shp-peek'); i++) await wait();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    try {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(esc); });
      expect(esc.defaultPrevented).toBe(false);
      await wait();
      expect(!!document.querySelector('.shp-peek')).toBe(true);
    } finally {
      menu.remove();
    }
  });

  test('a code span is the host\'s control while reading, and only words while annotating', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const wrap = (text: string, code: React.ReactNode) => <span data-host-span={text}>{code}</span>;
    act(() => root!.render(<CodeSpanContext.Provider value={wrap}><ShapeSurface host={host({ picture: PICTURE }, REFS, 'The rows go through `src/a.ts`.')} id={ID} readFirst /></CodeSpanContext.Provider>));
    for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
    await wait();
    const spans = () => document.querySelectorAll('.shp-claim [data-host-span="src/a.ts"]').length;
    expect(spans()).toBe(1);
    await click(dock('Annotate')!);
    expect(spans()).toBe(0);
    expect(document.querySelector('.shp-claim code')?.textContent).toBe('src/a.ts');
    await click(dock('Annotate')!);
    expect(spans()).toBe(1);
  });

  const MIXED: ShapeRef[] = [
    { n: 1, kind: 'file', title: 'The loop', target: 'src/a.ts', line: 7 },
    { n: 2, kind: 'diff', title: 'The change', target: 'src/b.ts' },
    { n: 3, kind: 'image', title: 'A picture', target: 'files/a.png' },
    { n: 4, kind: 'link', title: 'A link', target: 'https://example.com/' },
  ];

  async function mountRefs(withAction: ((id: string, file: { path: string; line?: number }) => React.ReactNode) | undefined) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const h = { ...host({ picture: PICTURE }, MIXED), ...(withAction ? { fileAction: withAction } : {}) };
    act(() => root!.render(<ShapeSurface host={h} id={ID} initialPanel="refs" />));
    for (let i = 0; i < 50 && !document.querySelector('.shp-ref-list'); i++) await wait();
    return [...document.querySelectorAll('.shp-ref-list li')];
  }

  test('the References list draws it for a file and a diff, with the board, the path and the line; never for anything else', async () => {
    const seen: unknown[] = [];
    const rows = await mountRefs((id, file) => (seen.push([id, file]), <i data-host-action={file.path} />));
    expect(rows.map((row) => row.querySelector('[data-host-action]')?.getAttribute('data-host-action') ?? null)).toEqual(['src/a.ts', 'src/b.ts', null, null]);
    expect(seen).toContainEqual([ID, { path: 'src/a.ts', line: 7 }]);
  });

  test('a host without one gets the list as it was', async () => {
    const rows = await mountRefs(undefined);
    expect(rows).toHaveLength(4);
    expect(document.querySelector('[data-host-action]')).toBeNull();
  });
});

// A real agent's board sat in the middle of its view, with a band of nothing under the claim.
describe.if(hasDom)("Plannotator's board sits under the claim; another host keeps it in the middle", () => {
  const canvas = { ...PICTURE, width: 800, height: 400 };

  test('with readFirst a fixed canvas sits at the top of its view', async () => {
    await mount({ picture: canvas });
    const drawn = document.querySelector('.shp-view .shp-drawn.canvas');
    expect(drawn).not.toBeNull();
    expect(drawn!.classList.contains('top')).toBe(true);
  });

  test('a host without readFirst keeps its canvas in the middle, as before', async () => {
    await mount({ picture: canvas }, { readFirst: undefined });
    const drawn = document.querySelector('.shp-view .shp-drawn.canvas');
    expect(drawn).not.toBeNull();
    expect(drawn!.classList.contains('top')).toBe(false);
  });
});
