/**
 * Settings → Capabilities → Board style (approval "shape-board-style-switch"; components/ShapeStyleSetting.tsx,
 * shapeStyle.ts) over the real board as the Inbox lays it (ShapeLayer), with the server's save stubbed (the
 * config.json round trip is packages/shared/shape/switch.test.ts's).
 * What regresses: a person who never chose seeing Rounded (the default is Sharp); a pick that does not reach a
 * board already open, or is not saved, or not remembered for the next page; config.json's style not adopted from
 * the first settings read, or adopted over a pick made on this page first.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../shared/shape/store';
import { bridgeSanitizerDom } from '../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
// @ts-expect-error the kit is plain JavaScript, with no types
import { arrow, box, svg } from '../core/shape-kit.mjs';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  // The real board (tsconfig `paths` points the window's typecheck at its .d.ts). By a path in a variable: the
  // window's strict typecheck must not follow it into review-editor.
  const seam: string = './shape/ShapeBoard.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#shape-board', () => real);
}
const { ShapeLayer } = (hasDom ? await import('./shape/ShapeParts') : {}) as typeof import('./shape/ShapeParts');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { ShapeStyleRow } = (hasDom ? await import('./components/ShapeStyleSetting') : {}) as typeof import('./components/ShapeStyleSetting');
const { adoptSavedShapeStyle, resetShapeStyleForTests, SHAPE_STYLE_COOKIE } = await import('./shapeStyle');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
// happy-dom cannot host DOMPurify as it stands; the bridge makes it (without it the drawing comes out empty).
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
const dirs: string[] = [];
const saves: unknown[] = [];
const stored = new Map<string, string>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  saves.length = 0;
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { shape_style?: unknown };
    saves.push(body);
    return new Response(JSON.stringify({ shape: { on: true }, shape_style: body.shape_style }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  resetShapeStyleForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (hasDom) {
    act(() => root?.unmount());
    document.body.innerHTML = '';
  }
  root = null;
  resetStorageBackend();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A board drawn with the kit, as an agent stores it. */
function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-style-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const picture = svg(600, 300, `<g data-mark="k" data-step="1">${box(40, 40, 160, 80)}${arrow([[200, 80], [320, 80], [320, 200]])}</g>`);
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture } }, project: { root: dir, name: 'relay' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

async function mount(): Promise<HTMLElement> {
  const loaded = board();
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const el = document.createElement('div');
  el.className = 'pn-inbox';
  document.body.appendChild(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      <SidebarProvider open onOpenChange={() => {}}>
        <section data-test-settings="">
          <ShapeStyleRow />
        </section>
        <main className="ib-main">
          <ShapeLayer host={host} id={loaded.shape.id} onClose={() => {}} thread={null} />
        </main>
      </SidebarProvider>,
    ),
  );
  for (let i = 0; i < 100 && !drawnBoard(el); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(drawnBoard(el)).not.toBeNull();
  return el;
}

/** The drawing's `.board`, inside its shadow root. */
const drawnBoard = (el: HTMLElement) => el.querySelector('.shp-drawn-host')?.shadowRoot?.querySelector<HTMLElement>('.board') ?? null;
const boardStyle = (el: HTMLElement) => drawnBoard(el)?.getAttribute('data-shp-style') ?? null;
const boxCorner = (el: HTMLElement) => getComputedStyle(drawnBoard(el)!.querySelector('rect.line')!).getPropertyValue('rx');
const picked = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[name="ib-shape-style"]:checked')?.value ?? null;
async function pick(el: HTMLElement, words: string) {
  const label = [...el.querySelectorAll('[data-test-settings] label')].find((l) => l.textContent === words);
  if (!label) throw new Error(`no "${words}"`);
  act(() => label.querySelector('input')!.click());
  await act(() => new Promise((r) => setTimeout(r, 10)));
}

test.skipIf(!hasDom)('a person who never chose sees every board Sharp, and the row says so', async () => {
  const el = await mount();
  expect(picked(el)).toBe('sharp');
  expect(boardStyle(el)).toBe('sharp');
  expect(boxCorner(el)).toBe('3px');
  expect(saves).toEqual([]);
});

test.skipIf(!hasDom)('a pick redraws the open board at once, both ways, and is saved and remembered', async () => {
  const el = await mount();
  await pick(el, 'Rounded');
  expect(picked(el)).toBe('rounded');
  expect(boardStyle(el)).toBe('rounded');
  expect(boxCorner(el)).not.toBe('3px');
  expect(saves).toEqual([{ shape_style: 'rounded' }]);
  expect(stored.get(SHAPE_STYLE_COOKIE)).toBe('rounded');

  await pick(el, 'Sharp');
  expect(boardStyle(el)).toBe('sharp');
  expect(boxCorner(el)).toBe('3px');
  expect(saves).toEqual([{ shape_style: 'rounded' }, { shape_style: 'sharp' }]);
  // Sharp is the default: nothing to remember.
  expect(stored.has(SHAPE_STYLE_COOKIE)).toBe(false);
});

test.skipIf(!hasDom)("config.json's style comes with the first settings read, never over a pick made here first", async () => {
  const el = await mount();
  act(() => adoptSavedShapeStyle('rounded'));
  expect(boardStyle(el)).toBe('rounded');
  expect(picked(el)).toBe('rounded');
  // Adopted once: a later read does not move it.
  act(() => adoptSavedShapeStyle('sharp'));
  expect(boardStyle(el)).toBe('rounded');

  act(() => resetShapeStyleForTests());
  await pick(el, 'Rounded');
  act(() => adoptSavedShapeStyle('sharp'));
  expect(boardStyle(el)).toBe('rounded');
  // An Inbox with Shape off sends no style; that read adopts nothing and the next one still can.
  act(() => resetShapeStyleForTests());
  act(() => adoptSavedShapeStyle(undefined));
  act(() => adoptSavedShapeStyle('rounded'));
  expect(boardStyle(el)).toBe('rounded');
});
