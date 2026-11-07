/**
 * Settings → Capabilities → Board style (approval "shape-board-style-switch"; components/ShapeStyleSetting.tsx,
 * shapeStyle.ts) over the real board as the Inbox lays it (ShapeLayer), with the server's save stubbed (the
 * config.json round trip is packages/shared/shape/switch.test.ts's).
 * What regresses: a person who never chose seeing Rounded (the default is Sharp); a pick that does not reach a
 * board already open, or is not saved, or not remembered for the next page; config.json's style not adopted from
 * the first settings read, or adopted over a pick made on this page first.
 *
 * The row's choices are radios faced with a live board each (each in its own style, whichever is picked), and the
 * preview is the kit's drawing.
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
const { ShapeStyleRow, SHAPE_STYLE_PREVIEW } = (hasDom ? await import('./components/ShapeStyleSetting') : {}) as typeof import('./components/ShapeStyleSetting');
const { adoptSavedShapeStyle, resetShapeStyleForTests, SHAPE_STYLE_COOKIE } = await import('./shapeStyle');
const { adoptSavedLooks } = await import('./savedLooks');
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

/** A drawing's `.board`, inside its shadow root: the open board's (in `main`), or a Settings preview's. */
const boardIn = (scope: Element | null | undefined) => scope?.querySelector('.shp-drawn-host')?.shadowRoot?.querySelector<HTMLElement>('.board') ?? null;
const drawnBoard = (el: HTMLElement) => boardIn(el.querySelector('main'));
const previewBoard = (el: HTMLElement, style: string) => boardIn(el.querySelector(`[data-shape-style-choice="${style}"]`));
const boardStyle = (el: HTMLElement) => drawnBoard(el)?.getAttribute('data-shp-style') ?? null;
const boxCorner = (el: HTMLElement) => getComputedStyle(drawnBoard(el)!.querySelector('rect.line')!).getPropertyValue('rx');
const picked = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[name="ib-shape-style"]:checked')?.value ?? null;
/** The radios as a screen reader names them (their `aria-labelledby`). */
const radios = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLInputElement>('[data-test-settings] [role="radiogroup"] input[type="radio"]')].map((input) => ({
    input,
    name: (input.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
  }));
async function pick(el: HTMLElement, words: string) {
  const radio = radios(el).find((r) => r.name === words);
  if (!radio) throw new Error(`no "${words}"`);
  act(() => radio.input.click());
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

test.skipIf(!hasDom)('the choices are one group of real radios, named Rounded and Sharp, each previewing its own style', async () => {
  const el = await mount();
  const group = el.querySelector('[data-test-settings] [role="radiogroup"]')!;
  expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Board style');
  const choices = radios(el);
  expect(choices.map((r) => r.name)).toEqual(['Rounded', 'Sharp']);
  // One name: the browser moves between them with the arrow keys and Tab stops once.
  expect(new Set(choices.map((r) => r.input.name)).size).toBe(1);
  expect(choices.every((r) => r.input.tabIndex !== -1 && !r.input.disabled)).toBe(true);
  expect(choices.map((r) => r.input.checked)).toEqual([false, true]);

  // Each face is the real board in its style, whichever is picked: the preview is what boards will look like.
  for (const chosen of ['Rounded', 'Sharp']) {
    await pick(el, chosen);
    expect(choices.map((r) => r.input.checked)).toEqual([chosen === 'Rounded', chosen === 'Sharp']);
    for (const style of ['rounded', 'sharp']) {
      const preview = previewBoard(el, style)!;
      expect(preview.getAttribute('data-shp-style')).toBe(style);
      const rect = preview.querySelector('rect.line')!;
      expect(getComputedStyle(rect).getPropertyValue('rx') === '3px').toBe(style === 'sharp');
    }
    expect(el.querySelector(`[data-shape-style-choice="${chosen.toLowerCase()}"]`)!.hasAttribute('data-on')).toBe(true);
    expect(el.querySelectorAll('[data-shape-style-choice][data-on]').length).toBe(1);
  }
});

test.skipIf(!hasDom)('the preview is drawn as the kit draws a new board', () => {
  const body = `<rect x="6" y="6" width="186" height="96" rx="12" style="fill:var(--blue-soft)"/>` + box(21, 21, 60, 33) + box(117, 60, 60, 33) + arrow([[81, 37], [147, 37], [147, 60]], { head: 10 });
  expect(SHAPE_STYLE_PREVIEW).toEqual(svg(198, 108, body));
});

// App's refreshSettings hands every settings read to adoptSavedLooks (savedLooks.ts); the App-level tests guard that
// call (guideDiffStyle.test.tsx: config.json's diff layout adopted on load). What regresses here: the read's board
// style dropped on the way, so a person who picked Rounded in another window sees Sharp on the next load.
test.skipIf(!hasDom)("a settings read's board style reaches the open board through the window's one adoption step", async () => {
  const el = await mount();
  expect(boardStyle(el)).toBe('sharp');
  act(() => adoptSavedLooks({ shape: { on: true }, shape_style: 'rounded' } as Parameters<typeof adoptSavedLooks>[0], 0));
  expect(boardStyle(el)).toBe('rounded');
  expect(picked(el)).toBe('rounded');
});
