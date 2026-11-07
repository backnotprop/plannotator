/**
 * Settings → Capabilities → Board style (approval "shape-board-style-switch"; components/ShapeStyleSetting.tsx,
 * shapeStyle.ts) over the real board as the Inbox lays it (ShapeLayer), with the server's save stubbed (the
 * config.json round trip is packages/shared/shape/switch.test.ts's).
 * What regresses: a person who never chose seeing Rounded (the default is Sharp); a pick that does not reach a
 * board already open, or is not saved, or not remembered for the next page; config.json's style not adopted from
 * the first settings read, or adopted over a pick made on this page first.
 *
 * The row (the Stage take): one radio group, Rounded | Sharp, over one preview board in the picked style, chosen by
 * its own frame's width; the previews are the kit's drawings.
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
import { arrow, box, line, svg, text } from '../core/shape-kit.mjs';

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
const { ShapeStyleRow, SHAPE_STYLE_PREVIEW, SHAPE_STYLE_PREVIEW_NARROW } = (hasDom ? await import('./components/ShapeStyleSetting') : {}) as typeof import('./components/ShapeStyleSetting');
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
const previewBoard = (el: HTMLElement) => boardIn(el.querySelector('.ib-bstyle-pic'));
const boardStyle = (el: HTMLElement) => drawnBoard(el)?.getAttribute('data-shp-style') ?? null;
const boxCorner = (el: HTMLElement) => getComputedStyle(drawnBoard(el)!.querySelector('rect.line')!).getPropertyValue('rx');
const picked = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[name="ib-shape-style"]:checked')?.value ?? null;
/** The radios as a screen reader names them (the label each sits in). */
const radios = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLInputElement>('[data-test-settings] [role="radiogroup"] input[type="radio"]')].map((input) => ({
    input,
    name: input.closest('label')?.textContent?.trim() ?? '',
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

test.skipIf(!hasDom)('the choices are one group of real radios, named Rounded and Sharp, over one preview in the picked style', async () => {
  const el = await mount();
  const group = el.querySelector('[data-test-settings] [role="radiogroup"]')!;
  expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Board style');
  const choices = radios(el);
  expect(choices.map((r) => r.name)).toEqual(['Rounded', 'Sharp']);
  // One name: the browser moves between them with the arrow keys and Tab stops once.
  expect(new Set(choices.map((r) => r.input.name)).size).toBe(1);
  expect(choices.every((r) => r.input.tabIndex !== -1 && !r.input.disabled)).toBe(true);
  expect(choices.map((r) => r.input.checked)).toEqual([false, true]);

  // The preview is the real board in the picked style, redrawn at once: what every board will look like.
  const cap = () => el.querySelector('.ib-bstyle-cap')?.textContent ?? '';
  expect(previewBoard(el)!.getAttribute('data-shp-style')).toBe('sharp');
  for (const chosen of ['Rounded', 'Sharp', 'Rounded']) {
    await pick(el, chosen);
    const style = chosen.toLowerCase();
    expect(choices.map((r) => r.input.checked)).toEqual([chosen === 'Rounded', chosen === 'Sharp']);
    const preview = previewBoard(el)!;
    expect(preview.getAttribute('data-shp-style')).toBe(style);
    expect(getComputedStyle(preview.querySelector('rect.line')!).getPropertyValue('rx') === '3px').toBe(style === 'sharp');
    expect(cap()).toMatch(style === 'sharp' ? /filled arrowheads/ : /open arrowheads/);
    expect(el.querySelector(`[data-shape-style-choice="${style}"]`)!.hasAttribute('data-on')).toBe(true);
    expect(el.querySelectorAll('[data-shape-style-choice][data-on]').length).toBe(1);
  }
});

// The preview picks its board by its own frame's width, not the window's: a desktop Settings card is under 700 px, the
// width at which ShapeDrawn swaps in a board's tall view, so a window-wide rule drew the phone board there. What
// regresses: a phone shrinking the wide board past reading, or a desktop card drawing the phone one.
for (const [frame, wide] of [[620, true], [300, false]] as const) {
  test.skipIf(!hasDom)(`a ${frame} px preview frame draws the ${wide ? 'wide' : 'narrow'} board`, async () => {
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('ib-bstyle-pic') ? frame : real.get!.call(this);
      },
    });
    try {
      const el = await mount();
      const viewBox = previewBoard(el)!.querySelector('svg')!.getAttribute('viewBox');
      expect(viewBox).toBe(`0 0 ${(wide ? SHAPE_STYLE_PREVIEW : SHAPE_STYLE_PREVIEW_NARROW).width} ${(wide ? SHAPE_STYLE_PREVIEW : SHAPE_STYLE_PREVIEW_NARROW).height}`);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', real);
    }
  });
}

test.skipIf(!hasDom)('the previews are drawn as the kit draws a new board', () => {
  const zone = (x: number, y: number, w: number, h: number, hue: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" style="fill:var(--${hue}-soft)"/>`;
  const label = (x: number, y: number, words: string, hue: string) => `<text x="${x}" y="${y}" font-size="13" font-weight="600" style="fill:var(--${hue})">${words}</text>`;
  const narrow =
    zone(150, 12, 138, 126, 'blue') + label(164, 34, 'Cache', 'blue') +
    box(14, 52, 92, 40) + text(60, 77, 'API', { size: 15, anchor: 'middle' }) +
    box(170, 82, 100, 40) + text(220, 107, 'Redis', { size: 15, anchor: 'middle' }) +
    arrow([[106, 62], [134, 62], [134, 102], [170, 102]], { head: 10 });
  const wide =
    box(16, 70, 104, 46) + text(68, 98, 'Client', { size: 15, anchor: 'middle' }) +
    arrow([[120, 93], [190, 93]], { head: 10 }) +
    box(190, 70, 112, 46) + text(246, 98, 'API', { size: 15, anchor: 'middle' }) +
    zone(350, 14, 274, 172, 'green') + label(366, 38, 'Workers · 3', 'green') +
    arrow([[302, 84], [330, 84], [330, 74], [372, 74]], { head: 10 }) +
    box(372, 54, 112, 40) + text(428, 79, 'resize', { size: 14, anchor: 'middle', mono: true }) +
    arrow([[302, 104], [330, 104], [330, 140], [372, 140]], { head: 10 }) +
    box(372, 120, 112, 40) + text(428, 145, 'thumbnail', { size: 14, anchor: 'middle', mono: true }) +
    box(512, 87, 96, 40, { dash: true }) + text(560, 112, 'S3', { size: 15, anchor: 'middle' }) +
    arrow([[484, 74], [496, 74], [496, 107], [512, 107]], { head: 10, tone: 'soft' }) +
    line([[484, 140], [496, 140], [496, 107]], { tone: 'soft' });
  expect(SHAPE_STYLE_PREVIEW).toEqual(svg(640, 200, wide));
  expect(SHAPE_STYLE_PREVIEW_NARROW).toEqual(svg(300, 150, narrow));
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
