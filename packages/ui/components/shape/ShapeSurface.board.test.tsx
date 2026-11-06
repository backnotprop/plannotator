/**
 * The board as a person meets it (DOM-gated, tests/dom-test-list.txt). What regresses if these fail:
 * - annotation is on from the start, so a click on a part opens a comment box;
 * - the Annotate button no longer turns pointing on, or an SVG part throws when picked;
 * - `views.know` stops reading as paragraphs under the drawing, comes back as a tab, or an old link stops landing on it;
 * - a note on those words reaches the agent as one on the drawing;
 * - an old board's Requirements vanish or crash;
 * - Show more cannot go back, or a bubble does not pop out, close on Esc, or avoid another number.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeNote, type ShapeNoteInput, type ShapeRef, type ShapeVersion, type ShapeViewId } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');
const { RefPeek, shapeRefPicture } = (hasDom ? await import('./refs') : {}) as typeof import('./refs');
const { CodeSpanContext } = (hasDom ? await import('../LocalLinkContext') : {}) as typeof import('../LocalLinkContext');

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

  test('a saved Requirements view and its notes open in the Shape view', async () => {
    const reqs = { groups: [{ id: 'g', label: 'Who', items: [{ id: 'r-1', text: 'Line one' }] }] };
    const old = host({ reqs } as ShapeVersion['views']);
    const load = old.load;
    old.load = async (shapeId: string) => {
      const data = await load.call(old, shapeId);
      const note = { id: 'n1', kind: 'ask', v: 1, view: 'reqs', part: 'r-1', quote: 'Line one', text: 'Why this?', from: 'you', re: null, delivered: null, at: data.version.at };
      return { ...data, notes: [note as unknown as ShapeLoaded['notes'][number]] };
    };
    await mount({}, { ...asHost, host: old, initialView: 'reqs' as ShapeViewId, initialPanel: 'ask' });
    expect(document.querySelector('.shp-know')?.textContent).toContain('Line one');
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

describe.if(hasDom)('the words under the drawing (views.know)', () => {
  const bar = () => [...document.querySelectorAll<HTMLElement>('.shp-dock [aria-label="Views"] .shp-tbtn')].map((b) => b.title);
  const shown = () => document.querySelector('.shp-view:not(.leaving)')!;

  test('its words are paragraphs under the drawing, each one a part, with references live', async () => {
    await mount({ picture: PICTURE, know: 'First **point** [^1].\n\nSecond **uses `code` here**.' });
    const know = document.querySelector('.shp-know')!;
    // Directly under the drawing, in the view that scrolls: not a tab, not a panel.
    expect(know.parentElement === shown()).toBe(true);
    expect(know.previousElementSibling?.classList.contains('shp-drawn')).toBe(true);
    // The frame gives up the view's height, or the words sit a whole screen below.
    expect(know.previousElementSibling?.classList.contains('followed')).toBe(true);
    expect(shown().classList.contains('v-picture')).toBe(true);
    expect([...know.querySelectorAll('p')].map((p) => p.getAttribute('data-mark'))).toEqual(['know-1', 'know-2']);
    expect(know.querySelector('b')?.textContent).toBe('point');
    expect(know.querySelector('.shp-rb')?.textContent).toBe('1');
    expect(know.querySelector('b code')?.textContent).toBe('code');
    expect(dock('Shape')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.shp-dock')?.textContent).not.toContain('Requirements');
  });

  test('a number keeps the word before it and the punctuation after it, and no word is lost or doubled', async () => {
    const words = 'Lift it off the base [^1]. Then **pour** [^1], see `src/a.ts:1`[^1]; done [^1][^1]! And the rest.';
    await mount({ picture: PICTURE, know: words });
    const know = document.querySelector('.shp-know')!;
    const groups = [...know.querySelectorAll('.shp-rb-with')];
    // Each number with its neighbours.
    expect(groups.map((g) => g.textContent)).toEqual(['base 1.', 'pour 1,', 'src/a.ts:11;', 'done 11!', 'done 1']);
    // The space before a number and the punctuation after it sit in the part that cannot break.
    expect([...know.querySelectorAll('.shp-rb-end')].map((e) => e.textContent)).toEqual([' 1.', ' 1,', '1;', ' 1', '1!']);
    // What a copy takes: the words as written, with plain spaces.
    expect(know.textContent).toBe('Lift it off the base 1. Then pour 1, see src/a.ts:11; done 11! And the rest.');
    expect(know.querySelectorAll('.shp-rb').length).toBe(5);
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

  test('a board with no words keeps its drawing as it is: no followed frame, nothing under it', async () => {
    await mount({ picture: PICTURE });
    expect(document.querySelector('.shp-know')).toBeNull();
    expect(document.querySelector('.shp-drawn')?.classList.contains('followed')).toBe(false);
    expect(bar()).toEqual(['Shape']);
  });

  test('with no drawing the words are the Shape view; with How it works beside them, both tabs stay and it opens on the words', async () => {
    await mount({ know: 'Only this.' });
    expect(bar()).toEqual(['Shape']);
    expect(shown().classList.contains('v-picture')).toBe(true);
    expect(shown().querySelector('.shp-know')?.textContent).toContain('Only this.');
    expect(document.querySelector('.shp-drawn')).toBeNull();
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    await mount({ how: PICTURE, know: 'Only this.' });
    await wait();
    expect(bar()).toEqual(['Shape', 'How it works']);
    expect(shown().querySelector('.shp-know')?.textContent).toContain('Only this.');
    expect(shown().querySelector('.shp-drawn')).toBeNull();
  });

  for (const old of ['know', 'reqs']) {
    test(`an old #view=${old} link opens the Shape view at the words, and the address moves on`, async () => {
      const scrolled: string[] = [];
      const was = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.className); };
      const seen: string[] = [];
      try {
        await mount({ picture: PICTURE, know: 'First.' }, { initialView: old as ShapeViewId, onNavigate: (s) => { seen.push(s.view); } });
        for (let i = 0; i < 40 && !scrolled.length; i++) await wait();
        expect(shown().classList.contains('v-picture')).toBe(true);
        expect(document.querySelector('.shp-view.v-know')).toBeNull();
        expect(scrolled).toEqual(['shp-know']);
        expect(seen.at(-1)).toBe('picture');
      } finally {
        Element.prototype.scrollIntoView = was;
      }
    });
  }

  test('opened with no old link, the board stays at its top', async () => {
    const scrolled: string[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.className); };
    try {
      await mount({ picture: PICTURE, know: 'First.' });
      for (let i = 0; i < 5; i++) await wait();
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  test('under a drawing, a paragraph can still be pointed at, and its box says Shape', async () => {
    await mount({ picture: PICTURE, know: 'Only this.' });
    await click(dock('Annotate')!);
    await click(document.querySelector('[data-mark="know-1"]')!);
    expect(popover()?.textContent).toContain('Shape · “Only this.”');
  });

  test('with words under it, the drawing still picks its own parts', async () => {
    await mount({ picture: PICTURE, know: 'Only this.' });
    await click(dock('Annotate')!);
    await click(inDrawing('[data-mark="whistle"]')!);
    expect(popover()?.textContent).toContain('One whistle');
  });

  test('a new version that changes the words marks them here, and leaves no dot on another tab', async () => {
    let send: ((e: Parameters<Parameters<ShapeHost['events']>[1]>[0]) => void) | null = null;
    const h = host({ picture: PICTURE, how: PICTURE, know: 'First.' });
    h.events = (_id, listener) => {
      send = listener;
      return () => {};
    };
    await mount({}, { host: h });
    const data = await h.load(ID);
    const nextBoard: ShapeBoard = { title: 'Kettle', claim: 'Built.', views: { picture: PICTURE, how: PICTURE, know: 'First, changed.' }, refs: REFS };
    await act(async () => send!({ type: 'version', shape: data.shape, version: { ...nextBoard, n: 2, at: data.version.at, base: 1, through: null, by: null, parts: shapeParts(nextBoard) } }));
    for (let i = 0; i < 40 && !document.querySelector('.shp-pill'); i++) await wait();
    expect(document.querySelector('.shp-pill')?.textContent).toContain('Board updated · Shape');
    expect(document.querySelector('.shp-tdot')).toBeNull();
    expect(document.querySelector('.shp-know')?.textContent).toContain('First, changed.');
    expect(document.querySelector('[data-mark="know-1"]')?.classList.contains('fresh')).toBe(true);
  });

  test('from How it works, a number that lives in the words brings the Shape view up', async () => {
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    try {
      await mount({ picture: { html: '<p>No number here</p>' }, how: { html: '<p>Nor here</p>' }, know: 'See this [^1].' }, { initialView: 'how', initialPanel: 'refs' });
      expect(shown().classList.contains('v-how')).toBe(true);
      await click(document.querySelector('.shp-ref-row')!);
      for (let i = 0; i < 40 && !document.querySelector('.shp-view.v-picture:not(.leaving)'); i++) await wait();
      expect(shown().classList.contains('v-picture')).toBe(true);
      expect(document.querySelector('.shp-view.v-know')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  test('a paragraph can be pointed at once annotating', async () => {
    await mount({ know: 'Only this.' });
    await click(dock('Annotate')!);
    await click(document.querySelector('[data-mark="know-1"]')!);
    expect(popover()?.textContent).toContain('Only this.');
  });

  test('a note on the words under the drawing is sent as one on the words, and one on the drawing as one on the drawing', async () => {
    const sent: ShapeNoteInput[] = [];
    const base = host({ picture: PICTURE, know: 'Only this.' });
    const at = '2026-11-04T10:00:00.000Z';
    base.note = async (_id, input) => {
      sent.push(input);
      return { id: `n${sent.length}`, at, v: 1, view: input.view, part: input.part, quote: input.quote, kind: 'change', text: input.text, from: 'you', re: null, delivered: null } as ShapeNote;
    };
    await mount({}, { host: base });
    await click(dock('Annotate')!);
    const send = async (words: string) => {
      const box = popover()!.querySelector<HTMLTextAreaElement>('textarea')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(box, words);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })); });
      await wait();
    };
    await click(document.querySelector('[data-mark="know-1"]')!);
    await send('shorter');
    await click(inDrawing('[data-mark="whistle"]')!);
    await send('louder');
    expect(sent.map((n) => [n.view, n.part, n.quote])).toEqual([['know', 'know-1', 'Only this.'], ['picture', 'whistle', 'One whistle']]);
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
    await mount({ reqs });
    const know = document.querySelector('.shp-know')!;
    for (const words of ['What I understand', 'Who gets it', 'You, never a guest', 'Second line', 'Open:', 'Nothing.']) expect(know.textContent).toContain(words);
    expect(know.textContent).not.toContain('Empty group');
    expect(know.querySelector('[data-mark="r-two"]')).not.toBeNull();
    expect(bar()).toEqual(['Shape']);
  });

  test('an old board with both a drawing and Requirements reads them under it', async () => {
    await mount({ picture: PICTURE, reqs: { groups: [{ id: 'g', label: 'Who', items: [{ id: 'r-1', text: 'Line one' }] }] } });
    expect(shown().querySelector('.shp-drawn + .shp-know')?.textContent).toContain('Line one');
    expect(bar()).toEqual(['Shape']);
  });

  test('opened on the view a board does not have, it lands on one it does', async () => {
    await mount({ how: PICTURE }, { initialView: 'know' });
    await wait();
    expect(dock('How it works')?.getAttribute('aria-pressed')).toBe('true');
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
    act(() => root!.render(<CodeSpanContext.Provider value={wrap}><ShapeSurface host={host({ know: 'The rows go through `src/a.ts`.' })} id={ID} readFirst /></CodeSpanContext.Provider>));
    for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
    await wait();
    const spans = () => document.querySelectorAll('.shp-know [data-host-span="src/a.ts"]').length;
    expect(spans()).toBe(1);
    await click(dock('Annotate')!);
    expect(spans()).toBe(0);
    expect(document.querySelector('.shp-know code')?.textContent).toBe('src/a.ts');
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
