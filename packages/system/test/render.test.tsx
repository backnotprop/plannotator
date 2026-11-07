/**
 * The drawing at rest, rendered: SystemView and SystemThumb over plannotator's
 * own committed drawing and the worst-case fixtures, in a real React tree
 * (happy-dom). What is proved: every sheet draws in each reading it has, with
 * a box for every part the layout placed; Simple draws no lines and no
 * letters; Full draws the lines; a window's "N sheets inside" cue asks for the
 * first sheet inside; the Simple / Full switch asks for the other reading and
 * shows only when a sheet has both and the host listens; the crumbs name the
 * drawing and the parts that open each scope; a sheet the drawing lacks falls
 * back to the landing sheet; the thumb is a picture with no controls.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { join } from 'node:path';
import { loadFiles, type SystemModel } from '../src/index.ts';
import { readFiles } from '../src/node/index.ts';
import { drawingDir, fixturesDir } from './helpers.ts';

const hasDom = typeof document !== 'undefined';
const R = (hasDom ? await import('../src/react.ts') : {}) as typeof import('../src/react.ts');

let root: Root | null = null;
let host: HTMLElement | null = null;

// Loaded while the file is collected, so each sheet and reading below gets its own test.
const models: Record<string, SystemModel> = {};
const loadErrors: Record<string, unknown[]> = {};
if (hasDom) {
  for (const [name, dir] of [
    ['plannotator', drawingDir],
    ['worst-case', join(fixturesDir, 'worst-case')],
    ['worst-one', join(fixturesDir, 'worst-one')],
  ] as const) {
    const { model, errors } = loadFiles((await readFiles(dir)).files);
    loadErrors[name] = errors;
    if (model) models[name] = model;
  }
}

let savedRect: PropertyDescriptor | undefined;

beforeAll(() => {
  if (!hasDom) return;
  savedRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) }),
  });
});

afterAll(() => {
  if (savedRect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', savedRect);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Renders into a host. happy-dom has no layout, so every box reads as w by h while a test runs (restored after). */
async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // async: the faces' load (fontsReady) settles inside act, and the view redraws with it
  await act(async () => root!.render(node));
  return host;
}

const noop = () => {};

test.skipIf(!hasDom)('the committed drawing and the worst-case fixtures load with no errors', () => {
  expect(loadErrors).toEqual({ plannotator: [], 'worst-case': [], 'worst-one': [] });
  expect(Object.keys(models)).toEqual(['plannotator', 'worst-case', 'worst-one']);
});

// One test per drawing, sheet and reading, so each fails on its own.
// The heaviest, plannotator L-101 full, takes about 1 s locally and CI's DOM runner is about 3x slower, so 10 s keeps 3x headroom.
const CASE_TIMEOUT_MS = 10_000;
for (const [name, model] of Object.entries(models)) {
  for (const code of Object.keys(model.sheets)) {
    const readings = R.hasSimple(model, code) ? (['full', 'simple'] as const) : (['full'] as const);
    for (const reading of readings) {
      test(`every sheet draws in each reading it has, a box for every part the layout placed: ${name} ${code} ${reading}`, async () => {
        const el = await render(<R.SystemView model={model} sheet={code} reading={reading} layout="window" onNavigate={noop} />);
        const L = R.restLayout(model, code, { simple: reading === 'simple' });
        const view = el.querySelector('.sys-view')!;
        expect([name, code, view.getAttribute('data-sheet')]).toEqual([name, code, code]);
        expect([name, code, reading, el.querySelectorAll('.sys-parts > .sys-part').length]).toEqual([name, code, reading, Object.keys(L.parts).length]);
      }, CASE_TIMEOUT_MS);
    }
  }
}

test.skipIf(!hasDom)('Simple draws no lines and no letters; Full draws the lines and the letters', async () => {
  const model = models.plannotator!;
  const simple = await render(<R.SystemView model={model} sheet="C-001" reading="simple" layout="window" onNavigate={noop} />);
  expect(simple.querySelector('.sys-view')!.getAttribute('data-reading')).toBe('simple');
  expect(simple.querySelectorAll('.sys-edge').length).toBe(0);
  expect(simple.querySelectorAll('.sys-letter').length).toBe(0);
  act(() => root!.unmount());
  const full = await render(<R.SystemView model={model} sheet="C-001" reading="full" layout="window" onNavigate={noop} />);
  const L = R.restLayout(model, 'C-001', { simple: false });
  expect(L.edges.length).toBeGreaterThan(0);
  expect(full.querySelectorAll('.sys-edge').length).toBe(L.edges.length);
  expect(full.querySelectorAll('.sys-letter.sys-mk').length).toBe(L.letters.length);
});

test.skipIf(!hasDom)('a window at rest says how many sheets are inside, and its cue asks for the first of them', async () => {
  const model = models.plannotator!;
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" onNavigate={(s) => asked.push(s)} />);
  const cues = [...el.querySelectorAll<HTMLButtonElement>('button.sys-win-cue')];
  const L = R.restLayout(model, 'C-001', {});
  const windows = Object.entries(L.parts).filter(([, p]) => p.opens);
  expect(windows.length).toBeGreaterThan(0);
  expect(cues.length).toBe(windows.length);
  for (const [id, p] of windows) {
    const cue = el.querySelector<HTMLButtonElement>(`[data-part="${id}"] button.sys-win-cue`)!;
    expect(cue.textContent).toBe(`${model.byScope[p.opens!]!.length} sheet${model.byScope[p.opens!]!.length === 1 ? '' : 's'} inside`);
    act(() => cue.click());
    expect(asked.at(-1)).toBe(model.byScope[p.opens!]![0]!);
  }
});

test.skipIf(!hasDom)('the Simple / Full switch asks for the other reading, and shows only where both exist and the host listens', async () => {
  const model = models.plannotator!;
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet="C-001" reading="full" layout="pane" onNavigate={noop} onReading={(r) => asked.push(r)} />);
  const radios = [...el.querySelectorAll<HTMLButtonElement>('.sys-seg [role="radio"]')];
  expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([['Simple', 'false'], ['Full', 'true']]);
  act(() => radios[1]!.click());
  expect(asked).toEqual([]);
  act(() => radios[0]!.click());
  expect(asked).toEqual(['simple']);
  act(() => root!.unmount());
  expect((await render(<R.SystemView model={model} sheet="C-001" layout="pane" onNavigate={noop} />)).querySelector('.sys-seg')).toBeNull();
  act(() => root!.unmount());
  const one = Object.keys(model.sheets).find((c) => !R.hasSimple(model, c));
  expect(one).toBeDefined();
  expect((await render(<R.SystemView model={model} sheet={one} layout="pane" onNavigate={noop} onReading={noop} />)).querySelector('.sys-seg')).toBeNull();
});

test.skipIf(!hasDom)('Open full window and Close show only when the host gives them, and call it', async () => {
  const model = models.plannotator!;
  const calls: string[] = [];
  const el = await render(<R.SystemView model={model} layout="pane" onNavigate={noop} onOpenFull={() => calls.push('full')} onClose={() => calls.push('close')} />);
  act(() => el.querySelector<HTMLButtonElement>('.sys-btn')!.click());
  act(() => el.querySelector<HTMLButtonElement>('.sys-icon-btn[aria-label="Close"]')!.click());
  expect(calls).toEqual(['full', 'close']);
  act(() => root!.unmount());
  const bare = await render(<R.SystemView model={model} layout="window" onNavigate={noop} onOpenFull={noop} />);
  expect(bare.querySelector('.sys-btn')).toBeNull();
  expect(bare.querySelector('.sys-icon-btn')).toBeNull();
});

test.skipIf(!hasDom)('the crumbs name the project, the drawing, then the part that opens each scope', async () => {
  const model = models.plannotator!;
  const deep = Object.keys(model.sheets).find((c) => model.sheets[c]!.scope !== 'root')!;
  const scope = model.sheets[deep]!.scope;
  const el = await render(<R.SystemView model={model} sheet={deep} project="plannotator" layout="window" onNavigate={noop} />);
  const crumbs = [...el.querySelectorAll('.sys-crumb')].map((c) => c.textContent);
  expect(crumbs[0]).toBe('plannotator');
  expect(crumbs[1]).toBe(model.name);
  expect(crumbs.at(-1)).toBe(model.parts[model.owner[scope]!]!.name);
  expect(el.querySelector('.sys-crumb.sys-here')!.textContent).toBe(crumbs.at(-1)!);
  expect(el.querySelector('.sys-code')!.textContent).toBe(deep);
});

test.skipIf(!hasDom)('a sheet the drawing does not have falls back to the landing sheet', async () => {
  const model = models.plannotator!;
  const el = await render(<R.SystemView model={model} sheet="Z-999" layout="window" onNavigate={noop} />);
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe(model.root);
});

test.skipIf(!hasDom)('the thumb is a picture of the landing sheet at the asked width, with no controls', async () => {
  const model = models.plannotator!;
  const el = await render(<R.SystemThumb model={model} width={640} />);
  const thumb = el.querySelector<HTMLElement>('.sys-thumb')!;
  const L = R.restLayout(model, model.root, {});
  expect(thumb.getAttribute('role')).toBe('img');
  expect(thumb.getAttribute('data-sheet')).toBe(model.root);
  expect(thumb.style.width).toBe('640px');
  expect(thumb.style.height).toBe(`${Math.ceil((L.h * 640) / L.w)}px`);
  expect(thumb.querySelectorAll('button').length).toBe(0);
  expect(thumb.querySelector('.sys-sheet.sys-live')).toBeNull();
});
