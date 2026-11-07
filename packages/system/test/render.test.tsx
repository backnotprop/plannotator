/**
 * The drawing at rest, rendered: SystemView and SystemThumb over plannotator's
 * own committed drawing and the worst-case fixtures, in a real React tree
 * (happy-dom). What is proved: every sheet draws in each reading it has, with
 * a box for every part the layout placed; Simple draws no lines and no
 * letters; Full draws the lines; a window's "N sheets inside" cue dives into
 * the first sheet inside and names it; the Simple / Full switch asks for the
 * other reading and shows only when a sheet has both and the host listens; the
 * crumbs name the drawing and the parts that open each scope, and a crumb above
 * travels up; the chips and keys 1 to 9 turn to a sheet of the scope; Esc
 * climbs, then closes; the zoom group and + - F zoom and fit; Key and N open
 * their cards and Esc closes them first; keys={false} lets those keys pass; a
 * part with sheets inside is a Tab stop and Enter dives. The moves run under
 * reduced motion (a cut), so where each ends is read at once; the motion itself
 * is measured in a real browser by scripts/measure.mjs.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { join } from 'node:path';
import { loadFiles, type SystemModel } from '../src/index.ts';
import { kindLabel } from '../src/draw/format.ts';
import { readFiles } from '../src/node/index.ts';
import { drawingDir, fixturesDir } from './helpers.ts';

const hasDom = typeof document !== 'undefined';
const R = (hasDom ? await import('../src/react.ts') : {}) as typeof import('../src/react.ts');

let root: Root | null = null;
let host: HTMLElement | null = null;
const models: Record<string, SystemModel> = {};

let savedRect: PropertyDescriptor | undefined;

beforeAll(async () => {
  if (!hasDom) return;
  savedRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) }),
  });
  for (const [name, dir] of [
    ['plannotator', drawingDir],
    ['worst-case', join(fixturesDir, 'worst-case')],
    ['worst-one', join(fixturesDir, 'worst-one')],
  ] as const) {
    const { model, errors } = loadFiles((await readFiles(dir)).files);
    expect(errors).toEqual([]);
    models[name] = model!;
  }
});

afterAll(() => {
  if (savedRect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', savedRect);
});

/** Reduced motion until the test ends: every move cuts, so where a move ends can be read at once. */
let undoReduce: (() => void) | null = null;
function reduce() {
  const saved = globalThis.matchMedia;
  const mm = ((q: string) => ({ matches: q.includes('reduce'), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof matchMedia;
  globalThis.matchMedia = mm;
  undoReduce = () => { globalThis.matchMedia = saved; };
}
const press = (el: Element, key: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });

afterEach(() => {
  undoReduce?.();
  undoReduce = null;
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

test.skipIf(!hasDom)('every sheet draws in each reading it has, a box for every part the layout placed', async () => {
  for (const [name, model] of Object.entries(models)) {
    for (const code of Object.keys(model.sheets)) {
      const readings = R.hasSimple(model, code) ? (['full', 'simple'] as const) : (['full'] as const);
      for (const reading of readings) {
        const el = await render(<R.SystemView model={model} sheet={code} reading={reading} layout="window" onNavigate={noop} />);
        const L = R.restLayout(model, code, { simple: reading === 'simple' });
        const view = el.querySelector('.sys-view')!;
        expect([name, code, view.getAttribute('data-sheet')]).toEqual([name, code, code]);
        expect([name, code, reading, el.querySelectorAll('.sys-parts > .sys-part').length]).toEqual([name, code, reading, Object.keys(L.parts).length]);
        act(() => root!.unmount());
        host!.remove();
        root = null;
      }
    }
  }
});

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

test.skipIf(!hasDom)('a window at rest says how many sheets are inside, and its cue dives into the first of them and names it', async () => {
  const model = models.plannotator!;
  const L = R.restLayout(model, 'C-001', {});
  const windows = Object.entries(L.parts).filter(([, p]) => p.opens);
  expect(windows.length).toBeGreaterThan(0);
  reduce();
  for (const [id, p] of windows) {
    const asked: string[] = [];
    const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" onNavigate={(s) => asked.push(s)} />);
    expect(el.querySelectorAll('button.sys-win-cue').length).toBe(windows.length);
    const cue = el.querySelector<HTMLButtonElement>(`[data-part="${id}"] button.sys-win-cue`)!;
    const inside = model.byScope[p.opens!]!;
    expect(cue.textContent).toBe(`${inside.length} sheet${inside.length === 1 ? '' : 's'} inside`);
    // the cue is reached through its part, not by Tab
    expect(cue.tabIndex).toBe(-1);
    act(() => cue.click());
    expect(asked).toEqual([inside[0]!]);
    expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe(inside[0]!);
    expect(el.querySelector('.sys-crumb.sys-here')!.textContent).toBe(model.parts[id]!.name);
    act(() => root!.unmount());
    host!.remove();
    root = null;
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
  const el = await render(<R.SystemView model={model} sheet={deep} project="acme" layout="window" onNavigate={noop} />);
  const crumbs = [...el.querySelectorAll('.sys-crumb')].map((c) => c.textContent);
  expect(crumbs[0]).toBe('acme');
  expect(crumbs[1]).toBe(model.name);
  expect(crumbs.at(-1)).toBe(model.parts[model.owner[scope]!]!.name);
  expect(el.querySelector('.sys-crumb.sys-here')!.textContent).toBe(crumbs.at(-1)!);
  expect(el.querySelector('.sys-code')!.textContent).toBe(deep);
});

test.skipIf(!hasDom)('a project named like the drawing is not said twice: "plannotator / Plannotator" is one crumb', async () => {
  const model = models.plannotator!;
  expect(model.name.toLowerCase()).toBe('plannotator');
  const el = await render(<R.SystemView model={model} sheet="L-201" project="plannotator" layout="window" onNavigate={noop} />);
  const crumbs = [...el.querySelectorAll('.sys-crumb')].map((c) => c.textContent);
  expect(crumbs).toEqual([model.name, model.parts[model.owner[model.sheets['L-201']!.scope]!]!.name]);
  expect(el.querySelectorAll('.sys-crumb-sep').length).toBe(1);
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

test.skipIf(!hasDom)('Esc climbs one level and names the sheet; on the landing sheet it closes', async () => {
  const model = models.plannotator!;
  reduce();
  const asked: string[] = [];
  let closed = 0;
  const el = await render(<R.SystemView model={model} sheet="L-201" layout="window" onNavigate={(s) => asked.push(s)} onClose={() => closed++} />);
  const stage = el.querySelector('.sys-stage')!;
  press(stage, 'Escape');
  const up = el.querySelector('.sys-view')!.getAttribute('data-sheet')!;
  expect(model.sheets[up]!.scope).toBe('root');
  // the sheet it climbs to is the one that draws the window it climbed out of
  expect(R.restLayout(model, up, {}).parts[model.owner[model.sheets['L-201']!.scope]!]).toBeDefined();
  expect(asked).toEqual([up]);
  expect(closed).toBe(0);
  press(stage, 'Escape');
  expect(closed).toBe(1);
  expect(asked).toEqual([up]);
});

test.skipIf(!hasDom)("a crumb above the sheet travels up to it; the crumb of the sheet on screen is not a control", async () => {
  const model = models.plannotator!;
  reduce();
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet="L-201" project="plannotator" layout="window" onNavigate={(s) => asked.push(s)} />);
  const up = [...el.querySelectorAll<HTMLButtonElement>('button.sys-crumb-b')];
  expect(up.map((b) => b.textContent)).toEqual([model.name]);
  expect(el.querySelector('.sys-crumb.sys-here')!.tagName).toBe('SPAN');
  act(() => up[0]!.click());
  const at = el.querySelector('.sys-view')!.getAttribute('data-sheet')!;
  expect(model.sheets[at]!.scope).toBe('root');
  expect(asked).toEqual([at]);
});

test.skipIf(!hasDom)('the chips name the sheets of this scope and turn to one; keys 1 to 9 do the same', async () => {
  const model = models.plannotator!;
  reduce();
  const codes = model.byScope.root!;
  expect(codes.length).toBeGreaterThan(1);
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" onNavigate={(s) => asked.push(s)} />);
  const chips = () => [...el.querySelectorAll<HTMLButtonElement>('.sys-chips button.sys-chip-b')];
  expect(chips().length).toBe(codes.length);
  // every chip says its sheet's kind in words, not a code's first letter
  expect(chips().map((c) => c.textContent)).toEqual(codes.map((c) => kindLabel(model.sheets[c]!.kind)));
  expect(chips().filter((c) => c.getAttribute('aria-current') === 'page').length).toBe(1);
  const other = codes.find((c) => c !== 'C-001')!;
  act(() => chips()[codes.indexOf(other)]!.click());
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe(other);
  expect(chips()[codes.indexOf(other)]!.getAttribute('aria-current')).toBe('page');
  press(el.querySelector('.sys-stage')!, String(codes.indexOf('C-001') + 1));
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe('C-001');
  expect(asked).toEqual([other, 'C-001']);
});

test.skipIf(!hasDom)('the zoom group zooms in and out and its percent fits; + - F do the same', async () => {
  const model = models.plannotator!;
  reduce();
  const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" onNavigate={noop} />);
  const pct = () => +el.querySelector('.sys-zoom .sys-pct')!.textContent!.replace('%', '');
  const rest = pct();
  act(() => el.querySelector<HTMLButtonElement>('.sys-zoom [aria-label="Zoom in"]')!.click());
  expect(pct()).toBe(Math.round(rest * 1.25));
  act(() => el.querySelector<HTMLButtonElement>('.sys-zoom .sys-pct')!.click());
  expect(pct()).toBe(rest);
  act(() => el.querySelector<HTMLButtonElement>('.sys-zoom [aria-label="Zoom out"]')!.click());
  expect(pct()).toBe(Math.round(rest / 1.25));
  const stage = el.querySelector('.sys-stage')!;
  press(stage, 'f');
  expect(pct()).toBe(rest);
  press(stage, '+');
  expect(pct()).toBe(Math.round(rest * 1.25));
  press(stage, '-');
  expect(pct()).toBe(rest);
});

test.skipIf(!hasDom)('Key opens the symbols and keys, N opens the notes, and Esc closes them before it climbs', async () => {
  const model = models.plannotator!;
  reduce();
  const code = Object.keys(model.sheets).find((c) => model.sheets[c]!.scope !== 'root' && R.restLayout(model, c, {}).notes.length > 0)!;
  expect(code).toBeDefined();
  const notes = R.restLayout(model, code, {}).notes;
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet={code} layout="window" onNavigate={(s) => asked.push(s)} />);
  const key = el.querySelector<HTMLButtonElement>('.sys-zoom button[aria-expanded]')!;
  act(() => key.click());
  expect(key.getAttribute('aria-expanded')).toBe('true');
  expect(el.querySelector('[role="dialog"][aria-label="Symbols and keys"]')).not.toBeNull();
  const stage = el.querySelector('.sys-stage')!;
  press(stage, 'n');
  expect(el.querySelector('[aria-label="Symbols and keys"]')).toBeNull();
  const rows = [...el.querySelectorAll('[aria-label="Notes on this sheet"] .sys-note-row')];
  expect(rows.map((r) => r.querySelector('.sys-letter')!.textContent)).toEqual(notes.map((n) => n.l));
  press(stage, 'Escape');
  expect(el.querySelector('[aria-label="Notes on this sheet"]')).toBeNull();
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe(code);
  expect(asked).toEqual([]);
});

test.skipIf(!hasDom)('with keys off, only Tab, the arrows, Enter and Esc act; the zoom, sheet and notes keys pass through', async () => {
  const model = models.plannotator!;
  reduce();
  const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" keys={false} onNavigate={noop} />);
  const stage = el.querySelector('.sys-stage')!;
  const pct = el.querySelector('.sys-zoom .sys-pct')!.textContent;
  for (const k of ['+', '-', 'f', '1', '2', 'n']) {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => { stage.dispatchEvent(ev); });
    expect([k, ev.defaultPrevented]).toEqual([k, false]);
  }
  expect(el.querySelector('.sys-zoom .sys-pct')!.textContent).toBe(pct);
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe('C-001');
  expect(el.querySelector('.sys-notescard')).toBeNull();
});

test.skipIf(!hasDom)('with keys off, the Notes button beside Key opens the notes card, which has a title and a close; Key and Notes show one card at a time', async () => {
  const model = models.plannotator!;
  reduce();
  const code = Object.keys(model.sheets).find((c) => R.restLayout(model, c, {}).notes.length > 0)!;
  expect(code).toBeDefined();
  const notes = R.restLayout(model, code, {}).notes;
  const el = await render(<R.SystemView model={model} sheet={code} layout="window" keys={false} onNavigate={noop} />);
  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('.sys-zoom button[aria-expanded]')];
  expect(buttons().map((b) => b.textContent)).toEqual(['Key', 'Notes']);
  const [key, btn] = buttons() as [HTMLButtonElement, HTMLButtonElement];
  const card = () => el.querySelector('[role="dialog"][aria-label="Notes on this sheet"]');
  act(() => btn.click());
  expect(btn.getAttribute('aria-expanded')).toBe('true');
  expect(card()!.querySelector('.sys-kc-h')!.textContent).toBe('Notes');
  expect([...card()!.querySelectorAll('.sys-note-row .sys-letter')].map((x) => x.textContent)).toEqual(notes.map((n) => n.l));
  // the button toggles it shut, as Key toggles its card
  act(() => btn.click());
  expect(card()).toBeNull();
  expect(btn.getAttribute('aria-expanded')).toBe('false');
  // one card at a time: Key closes the notes, Notes closes the Key
  act(() => btn.click());
  act(() => key.click());
  expect(card()).toBeNull();
  expect(el.querySelector('[aria-label="Symbols and keys"]')).not.toBeNull();
  act(() => btn.click());
  expect(el.querySelector('[aria-label="Symbols and keys"]')).toBeNull();
  expect(key.getAttribute('aria-expanded')).toBe('false');
  // the card's own close shuts it and gives the focus back to the button
  const x = card()!.querySelector<HTMLButtonElement>('button[aria-label="Close the notes"]')!;
  expect(x).not.toBeNull();
  act(() => x.click());
  expect(card()).toBeNull();
  expect(document.activeElement).toBe(btn);
  // Esc with the focus inside the card still closes it
  act(() => btn.click());
  press(card()!.querySelector('button')!, 'Escape');
  expect(card()).toBeNull();
});

test.skipIf(!hasDom)('a sheet with no notes has no Notes button', async () => {
  const model = models.plannotator!;
  const code = Object.keys(model.sheets).find((c) => R.restLayout(model, c, {}).notes.length === 0);
  if (!code) return;
  const el = await render(<R.SystemView model={model} sheet={code} layout="window" onNavigate={noop} />);
  expect([...el.querySelectorAll('.sys-zoom button[aria-expanded]')].map((b) => b.textContent)).toEqual(['Key']);
});

test.skipIf(!hasDom)('a part with sheets inside is a stop for Tab, says so, and Enter on it dives in', async () => {
  const model = models.plannotator!;
  reduce();
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} sheet="C-001" layout="window" onNavigate={(s) => asked.push(s)} />);
  const L = R.restLayout(model, 'C-001', {});
  const [id, p] = Object.entries(L.parts).find(([, q]) => q.opens)!;
  const part = el.querySelector<HTMLElement>(`.sys-cur [data-part="${id}"]`)!;
  expect(part.tabIndex).toBe(0);
  expect(part.getAttribute('aria-label')).toContain('Enter opens it');
  act(() => part.focus());
  press(part, 'Enter');
  expect(asked).toEqual([model.byScope[p.opens!]![0]!]);
  // the focus stays in the drawing, so Esc still reaches it
  expect(el.contains(document.activeElement)).toBe(true);
});
