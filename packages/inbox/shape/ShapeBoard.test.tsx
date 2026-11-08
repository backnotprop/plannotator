/**
 * The Inbox's board (ShapeBoard.tsx) draws the crosshair only when asked (`crosshair`, which only the Inbox's
 * ShapeLayer passes); without it the board keeps Annotate, as `plannotator shape open` shows it. What regresses: the
 * crosshair reaching the standalone page, or the Inbox losing it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../../shared/shape/store';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import type { ShapeBoardProps } from './types';

const hasDom = typeof document !== 'undefined';
// The real file, typed as the window sees it (board-module.d.ts): ShapeBoard.tsx is checked by tsconfig.guide.json,
// not the window's strict settings, so its path is not one TypeScript follows from here.
const boardFile = './ShapeBoard.tsx';
const { default: ShapeBoard } = (hasDom ? await import(boardFile) : {}) as { default: ComponentType<ShapeBoardProps> };

let root: Root | null = null;
const dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  for (const undo of restore.splice(0)) undo();
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function loaded(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-board-crosshair-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'relay' }, session: null });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

async function mount(props: { crosshair?: boolean; onAddToReply?: () => void }) {
  // Desktop-wide: happy-dom lays nothing out, so every width reads 0, a phone's.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
  const data = loaded();
  const host: ShapeHost = {
    load: async () => data,
    version: async () => data.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeBoard host={host} id={data.shape.id} onClose={() => {}} {...props} />));
  for (let i = 0; i < 50 && !el.querySelector('.shp-dock'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  return el;
}

const crosshair = (el: HTMLElement) => el.querySelector('.shp-dock button[aria-label="Comment"]');
const annotate = (el: HTMLElement) => [...el.querySelectorAll('.shp-dock button')].find((b) => b.textContent?.includes('Annotate')) ?? null;

test.skipIf(!hasDom)('without crosshair (the standalone page, and Add to reply alone): Annotate, no crosshair', async () => {
  const el = await mount({ onAddToReply: () => {} });
  expect(el.querySelector('.shp-dock')).not.toBeNull();
  expect(annotate(el)).not.toBeNull();
  expect(crosshair(el)).toBeNull();
});

test.skipIf(!hasDom)('with it (the Inbox’s ShapeLayer): the crosshair in Annotate’s place', async () => {
  const el = await mount({ crosshair: true });
  expect(crosshair(el)).not.toBeNull();
  expect(annotate(el)).toBeNull();
});
