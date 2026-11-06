/**
 * What's changed on the board (approval "shape-whats-changed"; DOM-gated, tests/dom-test-list.txt). What regresses:
 * - the tab shows on a board with nothing in it, or hides on one that has it, or leaves its place after How it works;
 * - a host that turns the Code view off still gets a Code tab, or a host that does not loses it;
 * - Guided review, Full review, a guide step or a `file:line` opens the wrong place in the review;
 * - a file the review does not change, or a board with no review, opens nothing (it must open the file viewer);
 * - a board with no review shows review buttons or guide-step links that lead nowhere;
 * - a guide step past the review's steps shows as a button that does nothing;
 * - a host whose `open` throws or rejects leaves an unhandled error, or no file viewer;
 * - two links to the same place break the list; the call paths stay sticky when taller than the view.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeLoaded, ShapeReviewAt, ShapeSurfaceReview } from './types';
import { KETTLE_CHANGED } from '../../../../tests/fixtures/shape-whats-changed';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_changed_test';
const PICTURE = { html: '<p data-mark="kettle">One whistle</p>' };
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

/** A review whose `open` records each place, and answers as asked (false: a file it does not change). */
function review(opened: ShapeReviewAt[], answer = true): ShapeSurfaceReview {
  return { label: '#12', files: 3, additions: 20, deletions: 4, open: async (at) => (opened.push(at), answer) };
}

let root: Root | null = null;
let wide: PropertyDescriptor | undefined;
beforeAll(() => {
  if (!hasDom) return;
  wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
});
afterAll(() => {
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
const button = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === words || b.getAttribute('aria-label') === words) ?? null;
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

async function mount(views: ShapeVersion['views'], props: Partial<React.ComponentProps<typeof ShapeSurface>> = {}, reads: string[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host(views, reads)} id={ID} readFirst {...props} />));
  for (let i = 0; i < 50 && !document.querySelector('.shp-dock'); i++) await wait();
  await wait();
}

async function openChanged() {
  await click(document.querySelector('.shp-dock [title="What\'s changed"]')!);
  for (let i = 0; i < 20 && !document.querySelector('.shp-chg'); i++) await wait();
}

describe.if(hasDom)("What's changed", () => {
  test('a board without it has no tab; a board with it has one, after How it works', async () => {
    await mount({ picture: PICTURE, how: PICTURE, know: 'Once.' });
    expect(tabs()).toEqual(['Picture', 'How it works', 'What to know']);
    act(() => root!.unmount());
    await mount({ picture: PICTURE, how: PICTURE, changed: KETTLE_CHANGED, know: 'Once.' });
    expect(tabs()).toEqual(['Picture', 'How it works', "What's changed", 'What to know']);
    // The board still opens on the Picture.
    expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
  });

  test('a host that turns the Code view off has no Code tab; one that does not keeps it', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED, code: CODE }, { codeView: false });
    expect(tabs()).toEqual(['Picture', "What's changed"]);
    act(() => root!.unmount());
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED, code: CODE });
    expect(tabs()).toEqual(['Picture', "What's changed", 'Code']);
  });

  test('a saved Code view on a board without one opens on the first view instead', async () => {
    await mount({ picture: PICTURE, code: CODE }, { codeView: false, initialView: 'code' });
    for (let i = 0; i < 10 && !document.querySelector('.shp-view.v-picture'); i++) await wait();
    expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
  });

  test('every change and call path shows, as − and + lines', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED });
    await openChanged();
    const hunks = [...document.querySelectorAll('.shp-chg-hunk')];
    expect(hunks.map((h) => h.getAttribute('data-mark'))).toEqual(KETTLE_CHANGED.items.map((i) => i.id));
    const setting = hunks[1]!;
    expect([...setting.querySelectorAll('.shp-chg-ln.del .tx')].map((l) => l.textContent)).toEqual(['Was: whistle: boolean']);
    expect([...setting.querySelectorAll('.shp-chg-ln.add .tx')].map((l) => l.textContent)).toEqual(['Now: whistle: "once" | "off"', 'Now: true reads as "once"']);
    expect(document.querySelector('[data-mark="boil"] .shp-chg-pt')?.textContent).toBe('Water reaches 100 °C');
    expect([...document.querySelectorAll('[data-mark="boil"] .shp-chg-fr.fork .call')].map((c) => c.textContent)).toEqual(['When: Lid closed', 'When: Lid open']);
  });

  test("with a review: its buttons, a guide step and a file:line open the review there", async () => {
    const opened: ShapeReviewAt[] = [];
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED, code: CODE }, { codeView: false, review: review(opened) });
    await openChanged();
    expect(document.querySelector('.shp-chg-meta')?.textContent).toBe('#123 files+20 -4');
    await click(button('Guided review')!);
    await click(button('Full review')!);
    await click(button('Guide step 2, open the guided review there')!);
    await click(button('kettle.ts:42, open src/kettle.ts at line 42')!);
    await wait();
    expect(opened).toEqual([{}, { files: true }, { step: 2 }, { path: 'src/kettle.ts', line: 42 }]);
  });

  test('a file the review does not change opens in the file viewer', async () => {
    const opened: ShapeReviewAt[] = [];
    const reads: string[] = [];
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: review(opened, false) }, reads);
    await openChanged();
    await click(button('settings.ts:12, open src/settings.ts at line 12')!);
    for (let i = 0; i < 10 && !reads.length; i++) await wait();
    expect(opened).toEqual([{ path: 'src/settings.ts', line: 12 }]);
    expect(reads).toEqual(['src/settings.ts']);
  });

  test('with no review: no review buttons or guide steps, and a file:line opens the file viewer', async () => {
    const reads: string[] = [];
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false }, reads);
    await openChanged();
    expect(button('Guided review')).toBeNull();
    expect(button('Full review')).toBeNull();
    expect(document.querySelector('.shp-chg-step')).toBeNull();
    expect(document.querySelector('.shp-chg-meta')).toBeNull();
    await click(button('kettle.ts:42, open src/kettle.ts at line 42')!);
    for (let i = 0; i < 10 && !reads.length; i++) await wait();
    expect(reads).toEqual(['src/kettle.ts']);
  });

  test('each link is named first by its own words', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: review([]) });
    await openChanged();
    for (const b of document.querySelectorAll<HTMLButtonElement>('.shp-chg-loc, .shp-chg-step')) expect(b.getAttribute('aria-label')!.startsWith(b.textContent!.trim())).toBe(true);
    // Each change's title is a heading under the Changes heading.
    expect(document.querySelectorAll('.shp-chg-hunk h4.shp-chg-title').length).toBe(KETTLE_CHANGED.items.length);
  });

  test('a review that says how many steps it has shows only those; one that does not lands a missing step at its start', async () => {
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: { ...review([]), steps: 1 } });
    await openChanged();
    expect([...document.querySelectorAll('.shp-chg-step')].map((b) => b.textContent)).toEqual(['Guide step 1']);
    act(() => root!.unmount());
    const opened: ShapeReviewAt[] = [];
    await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: { open: async (at) => (opened.push(at), !at.step) } });
    await openChanged();
    await click(button('Guide step 2, open the guided review there')!);
    for (let i = 0; i < 10 && opened.length < 2; i++) await wait();
    expect(opened).toEqual([{ step: 2 }, {}]);
  });

  test('a host whose open throws or rejects: no unhandled error, and the file opens in the file viewer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const open of [() => { throw new Error('host'); }, () => Promise.reject(new Error('host'))] as ShapeSurfaceReview['open'][]) {
        const reads: string[] = [];
        await mount({ picture: PICTURE, changed: KETTLE_CHANGED }, { codeView: false, review: { open } }, reads);
        await openChanged();
        await click(button('Guided review')!);
        await click(button('Guide step 1, open the guided review there')!);
        await click(button('kettle.ts:42, open src/kettle.ts at line 42')!);
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

  test('the same place twice is two links, not a broken list', async () => {
    const errors: unknown[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      const twice = { ...KETTLE_CHANGED, items: [{ ...KETTLE_CHANGED.items[0]!, code: ['src/kettle.ts:42', 'src/kettle.ts:42'] }] };
      await mount({ picture: PICTURE, changed: twice }, { codeView: false, review: review([]) });
      await openChanged();
      expect(document.querySelectorAll('.shp-chg-hunk .shp-chg-loc').length).toBe(2);
      expect(errors.filter((e) => String(e).includes('same key'))).toEqual([]);
    } finally {
      console.error = saved;
    }
  });

  test('the call paths stick beside the changes only while they fit in the view', async () => {
    const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const room = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    let paths = 300;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('shp-chg-flows') ? paths : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
    try {
      await mount({ picture: PICTURE, changed: KETTLE_CHANGED });
      await openChanged();
      expect(document.querySelector('.shp-chg-flows')!.classList.contains('fits')).toBe(true);
      act(() => root!.unmount());
      paths = 2000;
      await mount({ picture: PICTURE, changed: KETTLE_CHANGED });
      await openChanged();
      expect(document.querySelector('.shp-chg-flows')!.classList.contains('fits')).toBe(false);
    } finally {
      for (const [name, d] of [['offsetHeight', tall], ['clientHeight', room]] as const) {
        if (d) Object.defineProperty(HTMLElement.prototype, name, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
