/**
 * The board's title comes first (owner feedback 2026-11-04 in
 * shape-board-look): no eyebrow row above it (no Pebble tile, no
 * "<project> · Shape · as of …", no version dots), and Global comment stays
 * on the title's line at the right. What regresses: the row coming back, or
 * Global comment dropping below the title.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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

test.skipIf(!hasDom)('the title is the first thing on the board, with Global comment on its line; no eyebrow row', async () => {
  const loaded = board();
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  // A desktop-wide board (happy-dom lays nothing out, so every width reads 0, a phone's).
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  // A host that closes the board still gets no close button drawn in the board.
  act(() => root!.render(<ShapeSurface host={host} id={loaded.shape.id} onClose={() => {}} />));
  for (let i = 0; i < 50 && !el.querySelector('.shp-head h1'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));

  const head = el.querySelector('.shp-head')!;
  const firstRow = head.firstElementChild!;
  expect(firstRow.firstElementChild?.tagName).toBe('H1');
  expect(firstRow.firstElementChild?.textContent).toBe('Kettle');
  expect([...firstRow.querySelectorAll('button')].map((b) => b.textContent)).toContain('Global comment');
  expect(head.textContent).not.toMatch(/relay · Shape|as of/i);
  expect(head.querySelector('svg.shp-pebble, .shp-pebble')).toBeNull();
  expect(el.querySelector('[aria-label="Close Shape"]')).toBeNull();
});
