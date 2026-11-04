/**
 * The standalone Shape page (ShapePage.tsx): the grid under a small
 * Plannotator header, then a board; Esc or Back returns to the grid.
 *
 * What regresses:
 *  - the grid shows finished boards, or Find stops filtering;
 *  - opening a card does not put the board in the address (Back would not
 *    return), or Esc leaves the board open, or the grid stays reachable under
 *    the open board (it must be inert);
 *  - with Shape off the page shows a grid (or Find) at all;
 *  - with no boards the page is blank instead of saying what a board is.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../../../shared/shape/store';
import type { ShapePageApi, ShapeSummaryWire } from './api';
import { ShapeApiError } from './api';

const hasDom = typeof document !== 'undefined';
// The board itself (ShapeSurface and its Code view's guide chain) has its own tests; here it is a stand-in that
// shows which board is open and calls onClose when clicked.
if (hasDom) mock.module('#shape-board', () => ({
  default: ({ id, onClose }: { id: string; onClose: () => void }) => (
    <button type="button" data-stub-board={id} onClick={onClose}>
      board {id}
    </button>
  ),
}));
const { ShapePage, parseShapeHash, shapeHash } = (hasDom ? await import('./ShapePage') : {}) as typeof import('./ShapePage');

let root: Root | null = null;
const dirs: string[] = [];
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '#');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Boards as the store keeps them, behind a stand-in for the page's requests. */
function fakeApi(options: { on?: boolean; boards?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shape-page-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const ids: string[] = [];
  for (const title of options.boards ?? ['Kettle whistles once', 'Snooze announcement']) {
    const made = store.update({ board: { title, claim: 'Built.', views: { picture: { html: `<p data-mark="k">${title}</p>` } } }, project: { root: dir, name: 'app' }, session: null });
    if (!made.ok) throw new Error(JSON.stringify(made));
    ids.push(made.id);
  }
  const on = options.on ?? true;
  const off = () => Promise.reject(new ShapeApiError(404, 'not_found', 'Not found'));
  const api = {
    info: async () => ({ shape_server: 1 as const, version: 'test', serverSession: 's', on }),
    shapes: async () => (on ? { shapes: store.list({ state: 'active' }) as ShapeSummaryWire[] } : off()),
    shape: async (id: string) => (on ? { shape: store.get(id)!, version: store.read(id)!, seen: null, notes: store.notes(id), session: { state: 'gone' as const, agent: 'the agent' } } : off()),
    note: async () => off(),
    seen: async () => ({ seen: null }),
    codeFile: async () => off(),
    codeHover: async () => off(),
  } as unknown as ShapePageApi;
  return { api, store, ids };
}

const fakeEvents = () => ({ addEventListener: () => {}, close: () => {} }) as unknown as EventSource;

async function mount(api: ShapePageApi) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapePage api={api} openEvents={fakeEvents} />));
  await settle();
  return el;
}

async function settle(until?: () => boolean) {
  for (let i = 0; i < 60; i++) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
    if (!until || until()) return;
  }
}

describe.skipIf(!hasDom)('the standalone Shape page', () => {
  test('the address: a board and its view and panel, else the grid', () => {
    expect(parseShapeHash('')).toEqual({ shape: null, view: null, panel: null });
    expect(parseShapeHash('#shape=shp_01ABC&view=how&panel=ask')).toEqual({ shape: 'shp_01ABC', view: 'how', panel: 'ask' });
    expect(parseShapeHash('#shape=../x&view=nope&panel=thread')).toEqual({ shape: null, view: null, panel: null });
    expect(shapeHash({ shape: 'shp_1', view: 'picture', panel: null })).toBe('#shape=shp_1');
    expect(shapeHash({ shape: 'shp_1', view: 'reqs', panel: 'refs' })).toBe('#shape=shp_1&view=reqs&panel=refs');
  });

  test('the grid: the header, every active board, Find filters as you type', async () => {
    const { api, store, ids } = fakeApi({ boards: ['Kettle whistles once', 'Snooze announcement', 'Old one'] });
    store.setState(ids[2]!, 'finished');
    const el = await mount(api);
    await settle(() => el.querySelectorAll('[data-shape-card]').length === 2);
    expect(el.querySelector('h1')?.textContent).toBe('Shape');
    expect(el.querySelector('.shp-page-brand')?.textContent).toBe('Plannotator');
    // The count is the active boards' (the finished one is not counted), not its wording.
    expect(el.querySelector('.shp-page-sum')?.textContent?.match(/\d+/)?.[0]).toBe('2');
    expect([...el.querySelectorAll('[data-shape-card]')].map((c) => c.getAttribute('data-shape-card')).sort()).toEqual([ids[0], ids[1]].sort());
    const find = el.querySelector<HTMLInputElement>('.shp-page-find input')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(find, 'kettle');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(() => el.querySelectorAll('[data-shape-card]').length === 1);
    expect([...el.querySelectorAll('[data-shape-card]')].map((c) => c.getAttribute('data-shape-card'))).toEqual([ids[0]]);
  });

  test('a card opens its board in the address, over an inert grid; Esc returns to the grid', async () => {
    const { api, ids } = fakeApi();
    const el = await mount(api);
    await settle(() => !!el.querySelector(`[data-shape-card="${ids[1]}"]`));
    act(() => el.querySelector<HTMLElement>(`[data-shape-card="${ids[1]}"]`)!.click());
    await settle(() => !!el.querySelector('[data-shape-layer]'));
    expect(window.location.hash).toBe(`#shape=${ids[1]}`);
    expect(el.querySelector('[data-shape-layer]')?.getAttribute('data-shape-layer')).toBe(ids[1]);
    expect(el.querySelector('.shp-page-grid')?.hasAttribute('inert')).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle(() => !el.querySelector('[data-shape-layer]'));
    expect(el.querySelector('[data-shape-layer]')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(el.querySelector('.shp-page-grid')?.hasAttribute('inert')).toBe(false);
  });

  test('opened at a board address: the board shows first; Back to the grid leaves the board', async () => {
    const { api, ids } = fakeApi();
    window.history.replaceState(null, '', `#shape=${ids[0]}`);
    const el = await mount(api);
    await settle(() => !!el.querySelector('[data-shape-layer]'));
    expect(el.querySelector('[data-shape-layer]')?.getAttribute('data-shape-layer')).toBe(ids[0]);
    act(() => {
      window.history.pushState(null, '', '#');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle(() => !el.querySelector('[data-shape-layer]'));
    expect(el.querySelector('[data-shape-layer]')).toBeNull();
  });

  test('Shape off: the page says so, with no grid and no Find', async () => {
    const { api } = fakeApi({ on: false });
    const el = await mount(api);
    await settle(() => !!el.querySelector('[data-shape-page-off]'));
    expect(el.querySelector('[data-shape-page-off]')?.textContent).toContain('Shape is off.');
    expect(el.querySelector('[data-shape-card]')).toBeNull();
    expect(el.querySelector('.shp-page-find')).toBeNull();
  });

  test('no boards: the Pebble and what a board is, not a blank page', async () => {
    const { api } = fakeApi({ boards: [] });
    const el = await mount(api);
    await settle(() => !!el.querySelector('[data-shape-page-empty]'));
    const empty = el.querySelector('[data-shape-page-empty]')!;
    // A living Pebble, a heading and a line that says what a board is: something to read, not a blank grid.
    expect(empty.querySelector('.shp-pebble[data-on]')).not.toBeNull();
    expect(empty.querySelector('h2')?.textContent?.trim()).toBeTruthy();
    expect(empty.querySelector('p')?.textContent?.trim()).toBeTruthy();
    expect(el.querySelector('[data-shape-card]')).toBeNull();
    // Nothing to count or find yet.
    expect(el.querySelector('.shp-page-find')).toBeNull();
    expect(el.querySelector('.shp-page-sum')).toBeNull();
  });
});
