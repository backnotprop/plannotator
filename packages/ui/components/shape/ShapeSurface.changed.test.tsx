import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded, ShapeReviewAt, ShapeSurfaceReview } from './types';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import { KETTLE_CHANGED } from '../../../../tests/fixtures/shape-whats-changed';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_changed_test';
const PICTURE = { html: '<p data-mark="kettle" data-code="src/kettle.ts#L42">One whistle</p>' };
const CODE: NonNullable<ShapeVersion['views']['code']> = { stage: 'after', guide: { title: 'Kettle', intent: '', sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts' }] }] } };

function host(views: ShapeVersion['views'], reads: string[] = []): ShapeHost {
  const at = '2026-11-05T10:00:00.000Z';
  const board: ShapeBoard = { title: 'Kettle', claim: 'Built.', views };
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
    readFile: async (_id: string, path: string) => {
      reads.push(path);
      return `// ${path}\n`;
    },
  };
}

function review(opened: ShapeReviewAt[], answer = true): ShapeSurfaceReview {
  return { label: '#12', files: 3, additions: 20, deletions: 4, open: async (at) => (opened.push(at), answer) };
}

let root: Root | null = null;
let wide: PropertyDescriptor | undefined;
let unbridge: (() => void) | null = null;
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
const tabs = () => [...document.querySelectorAll<HTMLElement>('.shp-dock [aria-label="Views"] .shp-tbtn')].map((b) => b.title);
function inDrawing(selector: string): Element | null {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector(selector);
    if (found) return found;
  }
  return null;
}
const clickPart = async () => {
  for (let i = 0; i < 50 && !inDrawing('[data-code]'); i++) await wait();
  await act(async () => {
    inDrawing('[data-code]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
  await wait();
};

async function mount(views: ShapeVersion['views'], props: Partial<React.ComponentProps<typeof ShapeSurface>> = {}, reads: string[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host(views, reads)} id={ID} readFirst {...props} />));
  for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
  await wait();
}

describe.if(hasDom)('views.changed is not shown', () => {
  test('a board that carries it has no What\'s changed tab, and none of its words show', async () => {
    await mount({ picture: PICTURE, how: PICTURE, changed: KETTLE_CHANGED });
    expect(tabs()).toEqual(['Shape', 'How it works']);
    expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
    expect(document.querySelector('.shp-view.v-changed, .shp-chg')).toBeNull();
    for (const words of [KETTLE_CHANGED.summary!, KETTLE_CHANGED.items[0]!.title, KETTLE_CHANGED.flows![0]!.title]) expect(document.body.textContent).not.toContain(words);
  });

  test('an old link or saved view to What\'s changed opens the Shape view', async () => {
    const seen: string[] = [];
    await mount({ picture: PICTURE, how: PICTURE, changed: KETTLE_CHANGED }, { initialView: 'changed', onNavigate: (s) => { seen.push(s.view); } });
    await wait();
    expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
    expect(seen.at(-1)).toBe('picture');
  });

  test('a board whose only view is views.changed opens with its title and claim, no tab and nothing drawn', async () => {
    await mount({ changed: KETTLE_CHANGED });
    expect(document.querySelector('.shp-claim')?.textContent).toBe('Built.');
    expect(tabs()).toEqual([]);
    expect(document.querySelector('.shp-dock [aria-label="Views"]')).toBeNull();
    expect(document.body.textContent).not.toContain(KETTLE_CHANGED.summary!);
  });

  test('with a review: none of its facts or buttons show on the board', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: review([]) });
    for (const words of ['Guided review', 'Full review', 'Guide step', '#12', '+20']) expect(document.body.textContent).not.toContain(words);
  });
});

describe.if(hasDom)('the Code view and the review', () => {
  test('a host that turns the Code view off has no Code tab; one that does not keeps it', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED, code: CODE }, { codeView: false });
    expect(tabs()).toEqual(['Shape']);
    act(() => root!.unmount());
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED, code: CODE });
    expect(tabs()).toEqual(['Shape', 'Code']);
  });

  test('a saved Code view on a board without one opens on the first view instead', async () => {
    await mount({ picture: PICTURE, code: CODE }, { codeView: false, initialView: 'code' });
    for (let i = 0; i < 10 && !document.querySelector('.shp-view.v-picture'); i++) await wait();
    expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
  });

  test('with no Code view, a drawn part\'s place in code opens the review there; one the review does not change opens the file viewer', async () => {
    const opened: ShapeReviewAt[] = [];
    await mount({ picture: PICTURE }, { codeView: false, review: review(opened) });
    await clickPart();
    expect(opened).toEqual([{ path: 'src/kettle.ts', line: 42 }]);
    act(() => root!.unmount());
    const reads: string[] = [];
    const declined: ShapeReviewAt[] = [];
    await mount({ picture: PICTURE }, { codeView: false, review: review(declined, false) }, reads);
    await clickPart();
    for (let i = 0; i < 10 && !reads.length; i++) await wait();
    expect(declined).toEqual([{ path: 'src/kettle.ts', line: 42 }]);
    expect(reads).toEqual(['src/kettle.ts']);
  });

  test('a host whose open throws or rejects: no unhandled error, and the file opens in the file viewer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const open of [() => { throw new Error('host'); }, () => Promise.reject(new Error('host'))] as ShapeSurfaceReview['open'][]) {
        const reads: string[] = [];
        await mount({ picture: PICTURE }, { codeView: false, review: { open } }, reads);
        await clickPart();
        for (let i = 0; i < 10 && !reads.length; i++) await wait();
        expect(reads).toEqual(['src/kettle.ts']);
        act(() => root!.unmount());
      }
      await wait();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
