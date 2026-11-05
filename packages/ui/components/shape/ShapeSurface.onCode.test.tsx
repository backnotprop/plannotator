/**
 * The seams a host reuses the board through (DOM-gated, tests/dom-test-list.txt).
 * What regresses: a code review's click on a part not reaching its diff, the
 * board's own viewer opening over a diff that took the click, a host that says
 * no (a file its diff lacks) leaving the click dead, or the refresh button
 * losing the host's words.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_on_code_test';
const reads: string[] = [];

function host(extra: Partial<ShapeHost> = {}): ShapeHost {
  const at = '2026-11-04T10:00:00.000Z';
  const board: ShapeBoard = { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="whistle" data-code="src/kettle.ts#L3-L5">One whistle</p>' } } };
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: 'Kettle', project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1 } as ShapeLoaded['shape'],
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
      return 'const whistle = 1;\n';
    },
    ...extra,
  } as ShapeHost;
}

let root: Root | null = null;
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  reads.length = 0;
});

const wait = () => act(() => new Promise((r) => setTimeout(r, 20)));
function inDrawing(selector: string): Element | null {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector(selector);
    if (found) return found;
  }
  return null;
}
async function mount(props: Partial<React.ComponentProps<typeof ShapeSurface>>, shapeHost = host()) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={shapeHost} id={ID} {...props} />));
  for (let i = 0; i < 50 && !inDrawing('[data-code]'); i++) await wait();
  await wait();
}
const clickPart = async () => {
  await act(async () => {
    inDrawing('[data-code]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
  await wait();
};

test.skipIf(!hasDom)("a host that takes the click gets the part's path and lines, and the board's own viewer stays closed", async () => {
  const seen: Array<{ path: string; line: number; to?: number; mark: string | null }> = [];
  await mount({
    onCode: (at, el) => {
      seen.push({ path: at.path, line: at.line, ...(at.lineEnd !== undefined ? { to: at.lineEnd } : {}), mark: el.getAttribute('data-mark') });
      return true;
    },
  });
  await clickPart();
  expect(seen).toEqual([{ path: 'src/kettle.ts', line: 3, to: 5, mark: 'whistle' }]);
  expect(reads).toEqual([]);
});

test.skipIf(!hasDom)("a host that says no: the board's own viewer opens the file", async () => {
  await mount({ onCode: () => false });
  await clickPart();
  expect(reads).toEqual(['src/kettle.ts']);
});

test.skipIf(!hasDom)('no host seam: the board opens the file, as it does on its own', async () => {
  await mount({});
  await clickPart();
  expect(reads).toEqual(['src/kettle.ts']);
});

test.skipIf(!hasDom)("the refresh button takes the host's words, and keeps its own without them", async () => {
  await mount({}, host({ refresh: async () => {}, refreshLabel: 'Show me again' }));
  expect(document.body.textContent).toContain('Show me again');
  expect(document.body.textContent).not.toContain('Bring it up to date');
  act(() => root?.unmount());
  document.body.innerHTML = '';
  await mount({}, host({ refresh: async () => {} }));
  expect(document.body.textContent).toContain('Bring it up to date');
});
