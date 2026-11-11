import { afterEach, beforeEach, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const tray = (hasDom ? await import('./components/ReactionTray') : null) as typeof import('./components/ReactionTray') | null;

const PANE = { top: 50, bottom: 730, left: 600, right: 1270 };
const CLIENT = PANE.bottom - PANE.top;
const BUTTON = { left: 790, top: 752, width: 20, height: 20 };

type Rect = { left: number; top: number; width: number; height: number };
const rect = (r: Rect) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect;

let frames: Map<number, FrameRequestCallback>;
let nextId = 1;
let clock = 1000;
let saved: { raf: typeof requestAnimationFrame; caf: typeof cancelAnimationFrame; now: () => number; matchMedia: typeof matchMedia } | null = null;
let reduce = false;

interface Scene {
  body: HTMLElement;
  emoji: HTMLElement;
  layout: { height: number; messageEnd: number; scrollTop: number };
  drawLine: (height: number) => HTMLElement;
}

function scene(layout: Scene['layout']): Scene {
  const root = document.createElement('div');
  root.className = 'pn-inbox';
  const body = document.createElement('div');
  body.className = 'ib-pbody';
  const message = document.createElement('article');
  message.dataset.messageId = 'msg_1';
  body.appendChild(message);
  const foot = document.createElement('div');
  foot.className = 'ib-pfoot';
  const ack = document.createElement('button');
  ack.dataset.ack = '';
  const emoji = document.createElement('span');
  emoji.className = 'ib-ack-emoji';
  ack.appendChild(emoji);
  foot.appendChild(ack);
  root.append(body, foot);
  document.body.appendChild(root);
  const end = () => layout.height - CLIENT;
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => layout.height });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => CLIENT });
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => layout.scrollTop,
    set: (v: number) => {
      layout.scrollTop = Math.max(0, Math.min(end(), v));
    },
  });
  body.getBoundingClientRect = () => rect({ left: PANE.left, top: PANE.top, width: PANE.right - PANE.left, height: CLIENT });
  message.getBoundingClientRect = () => rect({ left: 640, top: PANE.top + 100 - layout.scrollTop, width: 600, height: layout.messageEnd - 100 });
  emoji.getBoundingClientRect = () => rect(BUTTON);
  const drawLine = (height: number) => {
    const line = document.createElement('p');
    line.dataset.ackFor = 'msg_1';
    const chip = document.createElement('span');
    chip.className = 'ib-ackemoji';
    line.appendChild(chip);
    message.appendChild(line);
    layout.height += height;
    chip.getBoundingClientRect = () => rect({ left: 650, top: PANE.top + layout.messageEnd + 12 + 4 - layout.scrollTop, width: 18, height: 18 });
    return chip;
  };
  return { body, emoji, layout, drawLine };
}

function frame(at = 16) {
  clock += at;
  const due = [...frames.entries()];
  frames.clear();
  for (const [, run] of due) run(clock);
}

function flightY(): number | null {
  const el = document.querySelector<HTMLElement>('[data-reaction-flight]');
  const m = el && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
  return m ? Number(m[2]) : null;
}

beforeEach(() => {
  if (!hasDom) return;
  frames = new Map();
  reduce = false;
  saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, now: performance.now.bind(performance), matchMedia: globalThis.matchMedia };
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => void frames.delete(id)) as typeof cancelAnimationFrame;
  performance.now = () => clock;
  globalThis.matchMedia = ((query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
});

afterEach(() => {
  if (!hasDom || !saved) return;
  for (let i = 0; i < 80 && frames.size > 0; i++) frame();
  globalThis.requestAnimationFrame = saved.raf;
  globalThis.cancelAnimationFrame = saved.caf;
  performance.now = saved.now;
  globalThis.matchMedia = saved.matchMedia;
  saved = null;
  document.body.innerHTML = '';
});

test.skipIf(!hasDom)('a landing out of sight: the thread does not scroll, and the emoji only lifts at the button, briefly', () => {
  const s = scene({ height: 1728, messageEnd: 1700, scrollTop: 800 });
  tray!.flyReaction(s.emoji, '👍', 'msg_1');
  expect(document.querySelector<HTMLElement>('[data-reaction-flight]')?.dataset.reactionFlight).toBe('stay');
  s.drawLine(40);
  frame(-6);
  const ys: number[] = [];
  let ms = 0;
  for (; ms < 600 && flightY() !== null; ms += 16) {
    ys.push(flightY()!);
    frame();
  }
  expect(s.body.scrollTop).toBe(800);
  expect(Math.max(...ys)).toBeLessThanOrEqual(762);
  expect(Math.min(...ys)).toBeGreaterThanOrEqual(762 - 24);
  expect(ms).toBeLessThanOrEqual(tray!.FLIGHT_STAY_MS + 32);
});

test.skipIf(!hasDom)('a line in view that moves under the foot mid-flight is not chased past the thread, and gets no hit', () => {
  const s = scene({ height: 1728, messageEnd: 1500, scrollTop: 900 });
  tray!.flyReaction(s.emoji, '👍', 'msg_1');
  expect(document.querySelector<HTMLElement>('[data-reaction-flight]')?.dataset.reactionFlight).toBe('land');
  const chip = s.drawLine(40);
  let hits = 0;
  chip.animate = (() => {
    hits += 1;
    return {} as Animation;
  }) as typeof chip.animate;
  frame();
  s.layout.messageEnd += 120;
  s.layout.height += 120;
  const ys: number[] = [];
  for (let i = 0; i < 60 && flightY() !== null; i++) {
    ys.push(flightY()!);
    frame();
  }
  expect(s.body.scrollTop).toBe(900);
  expect(Math.max(...ys)).toBeLessThanOrEqual(762);
  expect(ys.at(-1)!).toBeLessThanOrEqual(PANE.bottom - 12 + 0.5);
  expect(hits).toBe(0);
});

test.skipIf(!hasDom)('at the end: the thread eases to its new end once the line draws, with no jump, and the emoji lands', () => {
  const s = scene({ height: 1728, messageEnd: 1700, scrollTop: 1048 });
  tray!.flyReaction(s.emoji, '👍', 'msg_1');
  const chip = s.drawLine(48);
  let hits = 0;
  chip.animate = (() => {
    hits += 1;
    return {} as Animation;
  }) as typeof chip.animate;
  const tops = [s.body.scrollTop];
  const ys: number[] = [];
  for (let i = 0; i < 60 && (frames.size > 0 || flightY() !== null); i++) {
    if (flightY() !== null) ys.push(flightY()!);
    frame();
    tops.push(s.body.scrollTop);
  }
  const steps = tops.slice(1).map((t, i) => t - tops[i]!);
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...steps)).toBeLessThan(24);
  expect(s.body.scrollTop).toBe(1728 + 48 - CLIENT);
  const moving = steps.filter((d) => d > 0).length;
  expect(moving * 16).toBeLessThanOrEqual(tray!.KEEP_END_MS + 32);
  expect(Math.max(...ys)).toBeLessThanOrEqual(762);
  expect(hits).toBe(1);
});

test.skipIf(!hasDom)("at the end: the person's own wheel stops the thread keeping its end", () => {
  const s = scene({ height: 1728, messageEnd: 1700, scrollTop: 1048 });
  tray!.flyReaction(s.emoji, '👍', 'msg_1');
  s.drawLine(48);
  frame();
  frame();
  const at = s.body.scrollTop;
  expect(at).toBeGreaterThan(1048);
  s.body.dispatchEvent(new Event('wheel'));
  for (let i = 0; i < 30; i++) frame();
  expect(s.body.scrollTop).toBe(at);
});

test.skipIf(!hasDom)('reduced motion: no emoji flies; at the end the thread keeps its end at once, elsewhere it stays put', () => {
  reduce = true;
  const end = scene({ height: 1728, messageEnd: 1700, scrollTop: 1048 });
  tray!.flyReaction(end.emoji, '👍', 'msg_1');
  expect(document.querySelector('[data-reaction-flight]')).toBeNull();
  end.drawLine(48);
  frame();
  expect(end.body.scrollTop).toBe(1728 + 48 - CLIENT);
  expect(frames.size).toBe(0);
  document.body.innerHTML = '';

  const up = scene({ height: 1728, messageEnd: 1700, scrollTop: 800 });
  tray!.flyReaction(up.emoji, '👍', 'msg_1');
  expect(document.querySelector('[data-reaction-flight]')).toBeNull();
  up.drawLine(48);
  for (let i = 0; i < 10; i++) frame();
  expect(up.body.scrollTop).toBe(800);
});
