/**
 * "Follow an example" on a Shape board (approval "trace-it-board", r5).
 * DOM-gated: runs under DOM_TESTS=1 from tests/dom-test-list.txt.
 *
 * What regresses:
 *  - the dock's "Follow an example" showing on a board with no examples, or
 *    on a view other than How it works;
 *  - rapid next, next, back leaving two parts lit, or a stray dot on the
 *    picture, or the card on a different step from the picture;
 *  - a click on a lit part opening Change it instead of jumping to its step, or
 *    jumping once the person has turned Annotate on;
 *  - a step still to come keeping an invisible tab stop on the picture;
 *  - Esc closing the whole board while an example is followed;
 *  - the function's link not reaching the host's file;
 *  - reduced motion still running the dot, the slides or the flight;
 *  - the path missing a step or leaving the picture behind, and a long step's
 *    signature scrolling away with its checks. What needs real layout is in
 *    tests/e2e/inbox-shape-follow.spec.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeExample, type ShapeExampleStep } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_follow_test';

// An invented kettle: three parts, and an arrow between the first two named by data-edge.
const HOW_HTML =
  '<div data-mark="how-a">Water heats</div>' +
  '<svg width="40" height="10"><g data-edge="hot"><path d="M0 5 H30 M24 1 L30 5 L24 9"/></g></svg><span data-edge="hot">hot enough</span>' +
  '<div data-mark="how-b">It boils</div><div data-mark="how-c">It whistles</div><div data-mark="how-off">Nobody hears</div>';

const step = (part: string, more: Partial<ShapeExampleStep> = {}): ShapeExampleStep => ({
  part,
  tag: `at ${part}`,
  text: `The kettle reaches ${part}`,
  inputs: [{ name: 'temp', value: '100', from: { path: 'src/kettle.ts', line: 3 } }],
  signature: 'heat(temp: number): boolean',
  checks: [{ code: 'temp >= BOIL', constant: '100', saw: '100', result: 'pass', decides: true }],
  output: { name: 'boiling', value: 'true', type: 'boolean' },
  code: { path: 'src/kettle.ts', line: 10 },
  ...more,
});

const EXAMPLE: ShapeExample = {
  name: 'It whistles',
  title: 'You put the kettle on',
  steps: [step('how-a'), step('how-b', { arrow: 'hot', inputs: [{ name: 'boiling', value: 'true', from: { step: 1 } }] }), step('how-c')],
};

function board(examples?: ShapeExample[]): ShapeBoard {
  return {
    title: 'Kettle',
    claim: 'Built.',
    views: {
      picture: { html: '<p data-mark="whistle">One whistle</p>' },
      how: { html: HOW_HTML, ...(examples ? { examples } : {}) },
    },
  };
}

function loaded(b: ShapeBoard): ShapeLoaded {
  const at = '2026-11-04T10:00:00.000Z';
  return {
    shape: { v: 1, id: ID, title: b.title, project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
    version: { ...b, n: 1, at, base: null, through: null, by: null, parts: shapeParts(b) },
    seen: 1,
    notes: [],
    session: { state: 'live', agent: 'Claude Code' },
  };
}

function fakeHost(b: ShapeBoard, reads: string[] = []): ShapeHost {
  const data = loaded(b);
  return {
    load: async () => data,
    version: async () => data.version,
    note: async () => {
      throw new Error('not in this test');
    },
    ask: async () => {
      throw new Error('not in this test');
    },
    seen: () => {},
    events: () => () => {},
    readFile: async (_id, path) => {
      reads.push(path);
      return 'export const BOIL = 100;\n';
    },
  };
}

// ── the page's motion, recorded: every animation the board and the card start ──
type Recorded = { el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean };
let recorded: Recorded[] = [];
let realAnimate: PropertyDescriptor | undefined;
let realMatchMedia: typeof window.matchMedia | undefined;
let reduceMotion = false;

let root: Root | null = null;
let unbridge: (() => void) | null = null;

beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());

beforeEach(() => {
  if (!hasDom) return;
  recorded = [];
  reduceMotion = false;
  realAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const rec: Recorded = { el: this, frames, options, cancelled: false };
      recorded.push(rec);
      const a = {
        onfinish: null as null | (() => void),
        oncancel: null as null | (() => void),
        cancel() {
          rec.cancelled = true;
          a.oncancel?.();
        },
      };
      return a;
    },
  });
  realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') && reduceMotion,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (!hasDom) return;
  document.body.innerHTML = '';
  if (realAnimate) Object.defineProperty(Element.prototype, 'animate', realAnimate);
  else delete (Element.prototype as { animate?: unknown }).animate;
  if (realMatchMedia) window.matchMedia = realMatchMedia;
});

const wait = (ms = 20) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The How it works drawing's shadow root. */
function drawing(): ShadowRoot | null {
  for (const host of document.querySelectorAll('*')) if (host.shadowRoot?.querySelector('[data-mark="how-a"]')) return host.shadowRoot;
  return null;
}

async function mount(host: ShapeHost, view: 'how' | 'picture' = 'how', readFirst = false): Promise<HTMLElement> {
  const el = document.createElement('div');
  el.style.width = '1200px';
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={ID} initialView={view} readFirst={readFirst} />));
  const drawn = () => (view === 'how' ? drawing() : document.querySelector('*') && [...document.querySelectorAll('*')].some((h) => h.shadowRoot?.querySelector('[data-mark="whistle"]')));
  for (let i = 0; i < 50 && !drawn(); i++) await wait();
  if (!drawn()) throw new Error('board never drew');
  await wait();
  return el;
}

function button(name: string): HTMLButtonElement {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.getAttribute('aria-label') === name || x.title === name || x.textContent?.trim() === name);
  if (!b) throw new Error(`no button "${name}"`);
  return b;
}

async function press(name: string) {
  await act(async () => {
    button(name).click();
  });
}

/** The card's "n of N" on now. */
const count = () => document.querySelector('.shp-ex-text.cur .shp-ex-count')?.textContent?.trim() ?? null;

/** The step each lit-now thing on the picture belongs to. */
function nowOnPicture(): string[] {
  const d = drawing()!;
  return [...d.querySelectorAll('[data-ex-s="now"], .shp-ex-tag[data-s="now"]')].map((el) => el.getAttribute('data-ex-i')!);
}

describe.if(hasDom)('Follow an example', () => {
  test('the dock shows it only on How it works, and only when the board has examples', async () => {
    await mount(fakeHost(board()));
    expect(document.querySelector('[data-follow]')).toBeNull();
    act(() => root!.unmount());
    document.body.innerHTML = '';

    await mount(fakeHost(board([EXAMPLE])), 'picture');
    expect(document.querySelector('[data-follow]')).toBeNull();
    await press('How it works');
    for (let i = 0; i < 50 && !document.querySelector('[data-follow]'); i++) await wait();
    expect(document.querySelector('[data-follow]')).not.toBeNull();
  });

  test('next, next, back: the card and the picture agree on one step, with no stray dot', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    // All steps: every part on the path is lit, none is "now".
    expect(nowOnPicture()).toEqual([]);
    expect(drawing()!.querySelector('[data-mark="how-off"]')!.hasAttribute('data-ex-dim')).toBe(true);

    await press('Step through');
    expect(count()).toBe('1 of 3');
    await press('Next step');
    // Forward: the dot runs on the arrow to the next part.
    expect(drawing()!.querySelectorAll('.shp-ex-dot').length).toBe(1);
    await press('Next step');
    expect(drawing()!.querySelectorAll('.shp-ex-dot').length).toBe(1);
    await press('Previous step');
    await wait();

    expect(count()).toBe('2 of 3');
    const now = nowOnPicture();
    expect(now.length).toBeGreaterThan(0);
    expect(new Set(now)).toEqual(new Set(['1']));
    expect(drawing()!.querySelectorAll('.shp-ex-tag[data-s="now"]').length).toBe(1);
    expect(drawing()!.querySelectorAll('.shp-ex-dot').length).toBe(0);
    // The arrow taken to step 2 is lit with it.
    expect(drawing()!.querySelector('g[data-edge="hot"]')!.getAttribute('data-ex-s')).toBe('now');

    await press('Stop following');
    await wait();
    expect(drawing()!.querySelector('[data-ex-dim], [data-ex-s], .shp-ex-layer, .shp-ex-lit')).toBeNull();
  });

  test('a click on a lit part jumps to its step, and opens no composer', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await act(async () => {
      drawing()!.querySelector('[data-mark="how-c"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(count()).toBe('3 of 3');
    expect(nowOnPicture().every((i) => i === '2')).toBe(true);
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('with Annotate on, a click on the drawing annotates it, and the tags still step', async () => {
    await mount(fakeHost(board([EXAMPLE])), 'how', true);
    await press('Follow an example');
    await press('Step through');
    await act(async () => {
      drawing()!.querySelector('[data-mark="how-c"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    // Annotate off: it jumps.
    expect(count()).toBe('3 of 3');
    await press('Previous step');
    await press('Annotate: point at a part to change it or ask about it');
    await act(async () => {
      drawing()!.querySelector('[data-mark="how-c"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(count()).toBe('2 of 3');
    expect(document.querySelectorAll('[data-comment-popover]').length).toBe(1);
    await act(async () => {
      drawing()!.querySelector('.shp-ex-tag[data-ex-i="0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(count()).toBe('1 of 3');
  });

  test('a step still to come has no tag to land on with the keys', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    const stops = () => [...drawing()!.querySelectorAll<HTMLButtonElement>('.shp-ex-tag')].map((t) => [t.tabIndex, t.getAttribute('aria-hidden')]);
    expect(stops()).toEqual([[0, null], [0, null], [0, null]]);
    await press('Step through');
    expect(stops()).toEqual([[0, null], [-1, 'true'], [-1, 'true']]);
    await press('Next step');
    expect(stops()).toEqual([[0, null], [0, null], [-1, 'true']]);
  });

  test('every number that steps the example carries a bug, hidden from screen readers, and keeps its name', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    const tags = [...drawing()!.querySelectorAll<HTMLButtonElement>('.shp-ex-tag')];
    expect(tags.map((t) => t.querySelectorAll('.n + .bug[aria-hidden="true"] svg').length)).toEqual([1, 1, 1]);
    expect(tags.map((t) => t.getAttribute('aria-label'))).toEqual(EXAMPLE.steps.map((s, i) => `Step ${i + 1}: ${s.text}. ${s.tag}`));
  });

  test('the board made only shorter lays out again, in a host that never re-renders it: a phone hides the slice left above the card', async () => {
    // Watched boxes, resized by hand: nothing else here re-renders the board.
    const watching: { cb: ResizeObserverCallback; els: Element[] }[] = [];
    const realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private w: { cb: ResizeObserverCallback; els: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.w = { cb, els: [] };
        watching.push(this.w);
      }
      observe(el: Element) {
        this.w.els.push(el);
      }
      unobserve() {}
      disconnect() {
        this.w.els = [];
      }
    } as unknown as typeof ResizeObserver;
    try {
      let tall = 844;
      const el = document.createElement('div');
      document.body.appendChild(el);
      const surfaceOf = () => document.querySelector<HTMLElement>('.shp-root')!;
      root = createRoot(el);
      act(() => root!.render(<ShapeSurface host={fakeHost(board([EXAMPLE]))} id={ID} initialView="how" />));
      for (let i = 0; i < 50 && !drawing(); i++) await wait();
      const surface = surfaceOf();
      Object.defineProperty(surface, 'clientWidth', { configurable: true, get: () => 390 });
      Object.defineProperty(surface, 'clientHeight', { configurable: true, get: () => tall });
      surface.getBoundingClientRect = () => new DOMRect(0, 0, 390, tall);
      surface.querySelector<HTMLElement>('.shp-head')!.getBoundingClientRect = () => new DOMRect(0, 0, 390, 60);
      await press('Follow an example');
      const card = document.querySelector<HTMLElement>('.shp-ex-card')!;
      Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 200 });
      const view = () => document.querySelector('.shp-view.v-how')!;
      const resize = (box: Element) =>
        act(() => {
          for (const w of watching) if (w.els.includes(box)) w.cb([], {} as ResizeObserver);
        });
      resize(surface);
      await wait();
      expect(document.querySelector('.shp-root.follow-sheet')).not.toBeNull();
      expect(view().classList.contains('shp-ex-covered')).toBe(false);

      // Shorter only: the card keeps its height, and 300 - 60 - 200 leaves less than a board's room.
      tall = 300;
      resize(surface);
      await wait();
      expect(view().classList.contains('shp-ex-covered')).toBe(true);
    } finally {
      if (realRO) globalThis.ResizeObserver = realRO;
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  test('Esc stops following and is marked used; a panel goes first', async () => {
    reduceMotion = true;
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await press('References');
    expect(document.querySelectorAll('.shp-sidep.open').length).toBe(1);
    const esc = async () => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => {
        window.dispatchEvent(e);
      });
      return e.defaultPrevented;
    };
    expect(await esc()).toBe(true);
    expect(document.querySelectorAll('.shp-sidep.open').length).toBe(0);
    expect(document.querySelectorAll('[data-follow-card]:not(.leaving)').length).toBe(1);
    expect(await esc()).toBe(true);
    expect(document.querySelectorAll('[data-follow-card]:not(.leaving)').length).toBe(0);
  });

  test('the function opens its file in the host', async () => {
    const reads: string[] = [];
    await mount(fakeHost(board([EXAMPLE]), reads));
    await press('Follow an example');
    await press('Step through');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.shp-ex-text.cur .shp-ex-fn')!.click();
    });
    await wait();
    expect(reads).toEqual(['src/kettle.ts']);
  });

  test('open, the path names every step and jumps with the picture; folded, it is gone', async () => {
    reduceMotion = true; // Closing waits on no fade.
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await press('Step through');
    expect(document.querySelectorAll('.shp-ex-stop').length).toBe(0);
    await press('Inputs and outputs');

    const stops = () => [...document.querySelectorAll<HTMLButtonElement>('.shp-ex-stop')];
    expect(stops().map((b) => b.getAttribute('aria-label'))).toEqual(['Step 1: at how-a', 'Step 2: at how-b', 'Step 3: at how-c']);
    expect(stops().map((b) => b.getAttribute('aria-current'))).toEqual(['step', null, null]);

    await act(async () => stops()[2]!.click());
    expect(stops().map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'step']);
    expect(new Set(nowOnPicture())).toEqual(new Set(['2']));

    await press('Hide inputs and outputs');
    expect(document.querySelectorAll('.shp-ex-stop').length).toBe(0);
    expect(count()).toBe('3 of 3');
  });

  test('a long step scrolls its checks: the signature stays out of the scroller', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await press('Step through');
    await press('Inputs and outputs');
    await press('What happens');
    const cur = document.querySelector('.shp-ex-io.cur')!;
    expect(cur.querySelectorAll('.shp-ex-sig').length).toBe(1);
    expect(cur.querySelectorAll('.shp-ex-scroll .shp-ex-sig').length).toBe(0);
    expect(cur.querySelectorAll('.shp-ex-scroll .decides').length).toBe(1);
  });

  test('reduced motion: no dot, no slide and no flight, only short fades', async () => {
    reduceMotion = true;
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await press('Step through');
    await press('Inputs and outputs');
    recorded = [];
    await press('Next step');
    await press('Next step');
    await press('Previous step');
    await wait();

    expect(count()).toBe('2 of 3');
    expect(drawing()!.querySelectorAll('.shp-ex-dot').length).toBe(0);
    expect(document.querySelector('.shp-ex-ghost')).toBeNull();
    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      const keys = new Set(r.frames.flatMap((f) => Object.keys(f)).filter((k) => k !== 'offset'));
      expect([...keys]).toEqual(['opacity']);
      expect(Number(r.options.duration)).toBeLessThanOrEqual(150);
    }
  });

  test('without reduced motion, forward hands the output on: it flies into the next step', async () => {
    await mount(fakeHost(board([EXAMPLE])));
    await press('Follow an example');
    await press('Step through');
    await press('Inputs and outputs');
    await press('Goes in');
    await press('Next step');
    const flights = recorded.filter((r) => (r.el as HTMLElement).classList?.contains('shp-ex-ghost'));
    expect(flights.length).toBe(1);
    expect(String(flights[0]!.frames[0]!.transform)).toContain('translate(');
  });
});
