import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fanLayout, FAN_OPTIONS } from './fanLayout';

const hasDom = typeof document !== 'undefined';

let reduce = false;
if (hasDom) {
  const query = (media: string) => ({ media, get matches() { return reduce && media.includes('reduce'); }, addEventListener() {}, removeEventListener() {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const fan = (hasDom ? await import('./FaceFan') : {}) as typeof import('./FaceFan');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');

const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((face) => face !== 'agent').map((face) => [face, `<i data-art="${face}"></i>`])) as Parameters<typeof motion.setAgentFaceArt>[0];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  reduce = false;
  window.localStorage.clear();
  faces.resetAgentFaces();
  motion.setAgentFaceArt(ART);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function mount() {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<div className="ib-sbagent"><AgentMark id="ses_1" host="claude-code" name="Invoice retries" /></div>));
  const icon = document.querySelector<HTMLButtonElement>('[data-agent-icon="ses_1"]')!;
  // happy-dom lays nothing out: the mark at the sidebar's left, half way down a 1024 × 768 window.
  icon.getBoundingClientRect = () => ({ left: 15, top: 370, width: 28, height: 28, right: 43, bottom: 398, x: 15, y: 370, toJSON: () => ({}) }) as DOMRect;
  return icon;
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const group = () => document.querySelector<HTMLElement>('[role="radiogroup"]');
const choice = (face: string) => document.querySelector<HTMLButtonElement>(`[data-face-choice="${face}"]`);
const pointer = (el: EventTarget, type: string, at: { x?: number; y?: number; kind?: string } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: at.kind ?? 'mouse', clientX: at.x ?? 0, clientY: at.y ?? 0, pointerId: 1 });
  act(() => void el.dispatchEvent(event));
};
// React's onPointerEnter / onPointerLeave come from pointerover / pointerout.
const enter = (el: Element, kind = 'mouse') => pointer(el, 'pointerover', { kind, x: 29, y: 384 });
const leave = (el: Element) => {
  const event = new Event('pointerout', { bubbles: true });
  Object.assign(event, { pointerType: 'mouse', relatedTarget: document.body });
  act(() => void el.dispatchEvent(event));
};
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

test.skipIf(!hasDom)('a rest of the pointer on the mark opens the picker; a pointer only passing over opens nothing', async () => {
  const icon = mount();
  enter(icon);
  await wait(120);
  leave(icon);
  await wait(fan.FAN_DWELL_MS + 100);
  expect(group()).toBeNull();
  expect(icon.getAttribute('aria-expanded')).toBe('false');
  enter(icon);
  await wait(fan.FAN_DWELL_MS - 150);
  expect(group()).toBeNull();
  await until(() => group() !== null, 'the picker');
  expect(icon.getAttribute('aria-expanded')).toBe('true');
  expect(group()!.getAttribute('aria-label')).toBe('Icon for Invoice retries');
  const radios = [...group()!.querySelectorAll('[role="radio"]')];
  expect(radios.map((r) => r.getAttribute('data-face-choice'))).toEqual(['agent', 'transparent', 'totman', 'own', 'sets', ...motion.AGENT_FACES.filter((f) => f.startsWith('glass') || f === 'yellow')]);
  expect(choice('agent')!.getAttribute('aria-checked')).toBe('true');
  expect(choice('agent')!.getAttribute('aria-label')).toBe('Claude Code');
  expect(choice('glass-blue')!.getAttribute('aria-label')).toBe('Blue glass');
  expect(group()!.contains(document.activeElement)).toBe(false);
});

test.skipIf(!hasDom)('a choice is kept for its agent and shown on its mark, and the picker closes', async () => {
  const icon = mount();
  enter(icon);
  await until(() => group() !== null, 'the picker');
  act(() => choice('glass-blue')!.click());
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'the picker to close');
  expect(JSON.parse(window.localStorage.getItem(faces.AGENT_FACES_PAINT_KEY)!).faces).toEqual({ ses_1: { face: 'glass-blue', sessions: [] } });
  await until(() => document.querySelector<HTMLElement>('[data-agent-mark="ses_1"]')!.dataset.face === 'glass-blue', 'the mark to show it');
  act(() => root!.unmount());
  document.body.innerHTML = '';
  faces.resetAgentFaces();
  const again = mount();
  await until(() => document.querySelector<HTMLElement>('[data-agent-mark="ses_1"]')!.dataset.face === 'glass-blue', 'the kept face');
  key(again, 'Enter');
  await until(() => group() !== null, 'the picker');
  expect(choice('glass-blue')!.getAttribute('aria-checked')).toBe('true');
  expect([...document.querySelectorAll('[aria-checked="true"]')].map((el) => el.getAttribute('data-face-choice'))).toEqual(['glass-blue']);
});

test("the face shown is marked by a dot under it, and nothing puts a well or an outline behind a face", async () => {
  const css = await Bun.file(new URL('./agents.css', import.meta.url)).text();
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  const dot = rules.find((r) => r.sel.split(',').some((one) => one.trim() === '.am-fan-i[aria-checked="true"]::after'));
  expect(dot).toBeDefined();
  expect(dot!.body).toMatch(/content:\s*""/);
  expect(dot!.body).toMatch(/border-radius:\s*50%/);
  for (const r of rules.filter((x) => /\.am-fan-i\b/.test(x.sel) && !/:focus-visible|::after/.test(x.sel))) {
    expect(r.body).not.toMatch(/(^|;|\s)(outline|box-shadow)\s*:/);
    expect(r.body).not.toMatch(/(^|;|\s)border\s*:(?!\s*(0|none)\s*;)/);
    expect(r.body).not.toMatch(/(^|;|\s)background(-color)?\s*:(?!\s*none\s*;)/);
  }
});

test.skipIf(!hasDom)('Escape closes it, and so does the pointer leaving the mark and the fan (after a short grace); the way to a choice does not', async () => {
  const icon = mount();
  enter(icon);
  await until(() => group() !== null, 'the picker');
  const seen: boolean[] = [];
  const later = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
  document.addEventListener('keydown', later);
  key(document.body, 'Escape');
  document.removeEventListener('keydown', later);
  expect(seen).toEqual([true]);
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'Escape to close it');
  enter(icon);
  await wait(fan.FAN_DWELL_MS + 100);
  expect(icon.getAttribute('aria-expanded')).toBe('false');
  pointer(icon, 'pointermove', { x: 30, y: 385 });
  await until(() => icon.getAttribute('aria-expanded') === 'true', 'a move to open it again');
  key(document.body, 'Escape');
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'Escape again');
  leave(icon);
  enter(icon);
  await until(() => icon.getAttribute('aria-expanded') === 'true', 'the picker again');
  pointer(document, 'pointermove', { x: 29 + 60, y: 384 - 20 });
  await wait(fan.FAN_GRACE_MS + 80);
  expect(icon.getAttribute('aria-expanded')).toBe('true');
  pointer(document, 'pointermove', { x: 700, y: 384 });
  expect(icon.getAttribute('aria-expanded')).toBe('true');
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'the picker to close');
  const list = document.createElement('div');
  document.body.append(list);
  leave(icon);
  enter(icon);
  await until(() => icon.getAttribute('aria-expanded') === 'true', 'the picker again');
  act(() => void list.dispatchEvent(new Event('scroll')));
  await wait(20);
  expect(icon.getAttribute('aria-expanded')).toBe('true');
  act(() => void host!.dispatchEvent(new Event('scroll')));
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'a scroll of the sidebar to close it');
});

test.skipIf(!hasDom)('keyboard: Enter on the mark opens it on the face shown; the arrows move along the arcs; Enter chooses and focus comes back', async () => {
  const icon = mount();
  act(() => icon.focus());
  key(icon, 'Enter');
  await until(() => group() !== null && document.activeElement === choice('agent'), 'focus on the face shown');
  key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement).toBe(choice('transparent'));
  key(document.activeElement!, 'ArrowUp');
  key(document.activeElement!, 'ArrowUp');
  expect(document.activeElement!.getAttribute('data-face-choice')).toBe(fan.fanArcs(29, 384, 1024, 768).faces.flat().at(-1)!);
  key(document.activeElement!, 'Home');
  expect(document.activeElement).toBe(choice('agent'));
  expect([...group()!.querySelectorAll('[tabindex="0"]')]).toEqual([choice('agent')!]);
  act(() => choice('totman')!.focus());
  act(() => choice('totman')!.click());
  await until(() => icon.getAttribute('aria-expanded') === 'false', 'the choice to close it');
  expect(faces.agentFaceOf('ses_1')).toBe('totman');
  await until(() => document.activeElement === icon, 'focus back on the mark');
});

test.skipIf(!hasDom)('a click still steps the cycle and never opens the picker; a long press on a touch screen opens it and its lift steps nothing', async () => {
  const icon = mount();
  act(() => icon.click());
  expect(faces.agentFaceOf('ses_1')).toBe('glass');
  await wait(fan.FAN_DWELL_MS + 60);
  expect(group()).toBeNull();
  enter(icon, 'touch');
  await wait(fan.FAN_DWELL_MS + 60);
  expect(group()).toBeNull();
  pointer(icon, 'pointerdown', { kind: 'touch', x: 29, y: 384 });
  await until(() => group() !== null, 'a long press to open it');
  pointer(icon, 'pointerup', { kind: 'touch', x: 29, y: 384 });
  act(() => icon.click());
  expect(faces.agentFaceOf('ses_1')).toBe('glass');
});

test.skipIf(!hasDom)('reduced motion: the choices appear in place, with no travel', async () => {
  reduce = true;
  const icon = mount();
  enter(icon);
  await until(() => group() !== null, 'the picker');
  expect(document.querySelector('.am-fan')!.hasAttribute('data-still')).toBe(true);
});

test.skipIf(!hasDom)("every Glass colour is the same rounded tile in the row as in the fan, the rounding in the picture itself", async () => {
  const art = await import('./faceArt');
  motion.setAgentFaceArt(art.AGENT_FACE_ART);
  const icon = mount();
  const tileOf = (src: string) => {
    expect(src.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = new DOMParser().parseFromString(decodeURIComponent(src.slice('data:image/svg+xml,'.length)), 'image/svg+xml');
    const side = Number(svg.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[2]);
    const layers = [...svg.querySelectorAll('rect')].filter((r) => Number(r.getAttribute('width')) > side * 0.9);
    expect(layers.length).toBeGreaterThanOrEqual(4);
    for (const r of layers) expect(Number(r.getAttribute('rx'))).toBeGreaterThanOrEqual(side * 0.15);
    return svg.querySelector('[data-tile]')!.getAttribute('rx');
  };
  const glass = motion.AGENT_FACES.filter((f): f is Exclude<typeof f, 'agent'> => f.startsWith('glass') || f === 'yellow');
  expect(glass.length).toBe(10);
  for (const face of glass) {
    act(() => faces.keepAgentFace('ses_1', face));
    await until(() => !!document.querySelector(`.am-f-${face} img.am-art`), `the row's ${face}`);
    const row = document.querySelector<HTMLImageElement>(`.am-f-${face} img.am-art`)!;
    tileOf(row.getAttribute('src')!);
    expect(row.getAttribute('src')).toBe(art.AGENT_FACE_SRC[face] as string);
  }
  enter(icon);
  await until(() => !!choice('glass-blue')?.querySelector('img'), 'the fan with its pictures');
  for (const face of glass) expect(choice(face)!.querySelector('img')!.getAttribute('src')).toBe(art.AGENT_FACE_SRC[face] as string);
});

test('the fan fits the window: every choice inside it, targets a pitch apart, opening away from an edge', () => {
  const check = (cx: number, cy: number, w: number, h: number, counts: number[]) => {
    const rings = fanLayout(cx, cy, w, h, counts);
    expect(rings.map((r) => r.length)).toEqual(counts);
    const all = rings.flat();
    const pad = FAN_OPTIONS.margin + FAN_OPTIONS.item / 2 - 0.5;
    for (const s of all) {
      expect(cx + s.x).toBeGreaterThanOrEqual(pad);
      expect(cx + s.x).toBeLessThanOrEqual(w - pad);
      expect(cy + s.y).toBeGreaterThanOrEqual(pad);
      expect(cy + s.y).toBeLessThanOrEqual(h - pad);
    }
    for (const ring of rings) for (let i = 1; i < ring.length; i++) expect(Math.hypot(ring[i]!.x - ring[i - 1]!.x, ring[i]!.y - ring[i - 1]!.y)).toBeGreaterThanOrEqual(FAN_OPTIONS.pitch - 0.5);
    return rings;
  };
  const mid = check(29, 400, 1440, 900, [3, 10]);
  expect(mid[1]![0]!.x).toBeCloseTo(0, 0);
  expect(mid[1]![0]!.y).toBeLessThan(0);
  expect(mid[1]!.at(-1)!.y).toBeGreaterThan(0);
  const top = check(29, 30, 1440, 900, [3, 10]);
  expect(Math.min(...top[1]!.map((s) => s.y))).toBeGreaterThan(-30);
  const bottom = check(29, 880, 1440, 900, [3, 10]);
  expect(Math.max(...bottom[1]!.map((s) => s.y))).toBeLessThan(20);
  check(29, 30, 390, 760, [3, 5, 5]);
});

test("a finger's fan has finger-sized room: neighbours on an arc 44 px apart, inside a phone's window", () => {
  if (!hasDom) return;
  for (const cy of [120, 420, 780]) {
    const { spots } = fan.fanArcs(39, cy, 390, 844, true);
    for (const ring of spots) for (let i = 1; i < ring.length; i++) expect(Math.hypot(ring[i]!.x - ring[i - 1]!.x, ring[i]!.y - ring[i - 1]!.y)).toBeGreaterThanOrEqual(43.5);
    for (const s of spots.flat()) {
      expect(39 + s.x).toBeGreaterThanOrEqual(27.5);
      expect(39 + s.x).toBeLessThanOrEqual(390 - 27.5);
      expect(cy + s.y).toBeGreaterThanOrEqual(27.5);
      expect(cy + s.y).toBeLessThanOrEqual(844 - 27.5);
    }
  }
});
