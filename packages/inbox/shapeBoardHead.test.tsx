import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../shared/shape/store';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('@plannotator/ui/components/shape/ShapeSurface') : {}) as typeof import('@plannotator/ui/components/shape/ShapeSurface');

let root: Root | null = null;
const dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const undo of restore.splice(0)) undo();
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-board-head-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'relay' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

/** The board, desktop-wide (happy-dom lays nothing out, so every width reads 0, a phone's). */
async function mount(loaded: ShapeLoaded, onClose?: () => void): Promise<HTMLElement> {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={loaded.shape.id} onClose={onClose} />));
  for (let i = 0; i < 50 && !el.querySelector('.shp-head h1'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  return el;
}

const side = (el: HTMLElement) =>
  [...el.querySelectorAll('.shp-head-side > *')].map((n) => n.getAttribute('aria-label') ?? n.textContent?.trim());

test.skipIf(!hasDom)('the title is the first thing on the board; Global comment and the × that closes it are on its line', async () => {
  let closed = 0;
  const el = await mount(board(), () => closed++);
  const head = el.querySelector('.shp-head')!;
  const firstRow = head.firstElementChild!;
  expect(firstRow.firstElementChild?.tagName).toBe('H1');
  expect(firstRow.firstElementChild?.textContent).toBe('Kettle');
  expect(head.textContent).not.toMatch(/relay · Shape|as of/i);
  expect(side(el)).toEqual(['Global comment', 'Close Shape']);
  act(() => (firstRow.querySelector('[aria-label="Close Shape"]') as HTMLButtonElement).click());
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)('no close button when the host has nothing to close to', async () => {
  const el = await mount(board());
  expect(el.querySelector('[aria-label="Close Shape"]')).toBeNull();
});

test.skipIf(!hasDom)('while the agent draws, the Pebble and "<agent> is drawing v<n>…" sit left of Global comment; a finished board says so', async () => {
  const drawing = board();
  drawing.shape = { ...drawing.shape, drawing: { at: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() } };
  let el = await mount(drawing, () => {});
  expect(side(el)).toEqual(['Claude Code is drawing v2…', 'Global comment', 'Close Shape']);
  expect(el.querySelector('.shp-drawing .shp-pebble')).not.toBeNull();
  act(() => root?.unmount());
  document.body.innerHTML = '';

  const finished = board();
  finished.shape = { ...finished.shape, state: 'finished' };
  el = await mount(finished, () => {});
  expect(side(el)).toEqual(['Finished', 'Global comment', 'Close Shape']);
});
