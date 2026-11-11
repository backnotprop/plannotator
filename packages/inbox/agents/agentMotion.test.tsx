import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import type { SidebarProps } from '../components/Sidebar';
import type { AgentRigKind } from './rigs';

const hasDom = typeof document !== 'undefined';

let reduce = false;
interface FakeAnimation {
  target: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  at: number;
  playState: 'running' | 'paused' | 'finished' | 'idle';
}
const made: FakeAnimation[] = [];
const watchers: { cb: IntersectionObserverCallback; seen: Set<Element> }[] = [];
if (hasDom) {
  const query = { media: '(prefers-reduced-motion: reduce)', get matches() { return reduce; }, addEventListener() {}, removeEventListener() {} };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = window.matchMedia;
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    const opts = (typeof options === 'number' ? { duration: options } : (options ?? {})) as KeyframeAnimationOptions;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    finished.catch(() => {});
    const record: FakeAnimation = { target: this, frames: Array.isArray(frames) ? frames : [], options: opts, at: performance.now(), playState: 'running' };
    made.push(record);
    const an = {
      currentTime: 0 as number | null,
      playbackRate: 1,
      finished,
      get playState() {
        return record.playState;
      },
      play() {
        if (record.playState !== 'idle' && record.playState !== 'finished') record.playState = 'running';
      },
      pause() {
        if (record.playState !== 'idle' && record.playState !== 'finished') record.playState = 'paused';
      },
      cancel() {
        if (record.playState === 'idle') return;
        record.playState = 'idle';
        reject(new DOMException('cancelled', 'AbortError'));
      },
      finish() {
        record.playState = 'finished';
        resolve();
      },
    };
    if (opts.iterations !== Infinity) setTimeout(() => record.playState === 'running' && an.finish(), 5);
    return an as unknown as Animation;
  } as typeof Element.prototype.animate;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    seen = new Set<Element>();
    constructor(cb: IntersectionObserverCallback) {
      watchers.push({ cb, seen: this.seen });
    }
    observe(el: Element) {
      this.seen.add(el);
    }
    unobserve(el: Element) {
      this.seen.delete(el);
    }
    disconnect() {
      this.seen.clear();
    }
  };
}

const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { setInboxAgents } = await import('../agentsList');
const { machinesModel } = await import('../machines');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const view = (id: string, name: string): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true }) as MachineView;
const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({
  id,
  session: id,
  host: 'claude-code',
  project: { id: 'prj_bill', name: 'billing-svc' },
  state: 'idle',
  waiting: 0,
  live: true,
  started_at: '2026-11-09T09:14:00.000Z',
  last_seen_at: '2026-11-09T09:46:00.000Z',
  ...over,
});
const group = (agents: InboxAgent[]): InboxAgentsGroup => ({ machine: SELF, agents, total: agents.length, ended_today: 0 });

let root: Root | null = null;
let host: HTMLElement | null = null;
const mounted: HTMLElement[] = [];

beforeEach(() => {
  if (!hasDom) return;
  reduce = false;
  made.length = 0;
  motion.agentMotionOptions.clock = 1;
  motion.agentMotionOptions.fidgets = true;
  motion.agentMotionOptions.simulatedDom = true;
  window.localStorage.clear();
  setInboxAgents(null);
});

afterEach(() => {
  if (!hasDom) return;
  for (const el of mounted.splice(0)) motion.unmountAgentMark(el);
  act(() => root?.unmount());
  root = null;
  host = null;
  document.body.innerHTML = '';
  setInboxAgents(null);
  motion.agentMotionOptions.clock = 1;
  motion.agentMotionOptions.fidgets = true;
});

const noop = () => {};
function sidebar(agents: InboxAgent[]) {
  act(() => setInboxAgents([group(agents)]));
  const props = { page: 'inbox', projectId: null, inboxCount: 0, projects: [] as never, projectCounts: new Map(), update: null, restarting: false, updated: null, pins: [], onInbox: noop, onProject: noop, onSettings: noop, onUpdate: noop, onWhatsNew: noop, onMachine: noop, machines: machinesModel([view(SELF, 'Studio')]) } as unknown as SidebarProps;
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<SidebarProvider><Sidebar {...props} /></SidebarProvider>));
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const mark = (id: string) => document.querySelector<HTMLElement>(`[data-agent-mark="${id}"]`)!;
const running = (el: Element) => made.filter((an) => el.contains(an.target) && an.playState === 'running');
const loops = (el: Element) => running(el).filter((an) => an.options.iterations === Infinity);

const place = (el: Element, left: number, top: number, width: number, height: number) => {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
};
function handSidebar(rigs: (AgentRigKind | null)[]): HTMLElement[] {
  const side = document.createElement('aside');
  side.className = 'ib-side';
  place(side, 0, 0, 232, 800);
  const section = document.createElement('div');
  section.setAttribute('data-agents-section', '');
  side.append(section);
  document.body.append(side);
  return rigs.map((rig, i) => {
    const el = document.createElement('span');
    el.className = 'am';
    place(el, 17, 100 + 36 * i, 24, 24);
    section.append(el);
    motion.mountAgentMark(el, { rig, face: 'agent', size: 24, seed: `agent-${i}` });
    mounted.push(el);
    return el;
  });
}
function pointerTo(x: number, y: number, type = 'mouse') {
  const event = new Event('pointermove', { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y, pointerType: type });
  document.dispatchEvent(event);
}
function lean(el: HTMLElement) {
  const read = (text: string | undefined) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)(?:\s*rotate\((-?[\d.]+)deg\))?/.exec(text ?? '');
    return m ? { x: Number(m[1]), y: Number(m[2]), turn: Number(m[3] ?? 0) } : { x: 0, y: 0, turn: 0 };
  };
  return { body: read(el.querySelector<HTMLElement>('.am-look')!.style.transform), eyes: read(el.querySelector<HTMLElement>('.am-e')?.style.transform) };
}
const atRest = (el: HTMLElement) => el.querySelector<HTMLElement>('.am-look')!.style.transform === '' && (el.querySelector<HTMLElement>('.am-e')?.style.transform ?? '') === '';

test.skipIf(!hasDom)("a mark's motion never depends on its agent's state: a change of state starts, stops and restarts nothing", async () => {
  motion.agentMotionOptions.fidgets = false;
  sidebar([agent('ses_c'), agent('ses_x', { host: 'codex' })]);
  await wait(20);
  const before = made.length;
  const live = [...loops(mark('ses_c')), ...loops(mark('ses_x'))];
  expect(live.length).toBeGreaterThan(0);
  for (const state of ['working', 'waiting', 'idle'] as const) {
    sidebar([agent('ses_c', { state, waiting: state === 'waiting' ? 1 : 0 }), agent('ses_x', { host: 'codex', state })]);
    await wait(20);
    expect(made.length).toBe(before);
    expect(live.every((an) => an.playState === 'running')).toBe(true);
  }
  expect(document.querySelector('[data-sidebar-agent="ses_c"]')!.getAttribute('data-agent-state')).toBe('idle');
  expect(mark('ses_c').hasAttribute('data-state')).toBe(false);
});

test.skipIf(!hasDom)('every mark has a life of its own: an idle agent gestures by itself, a plain mark moves too, and two marks of one kind never run the same loop', async () => {
  motion.agentMotionOptions.clock = 200;
  sidebar([agent('ses_a', { host: 'codex' }), agent('ses_b', { host: 'codex' }), agent('ses_plain', { host: 'some-new-agent' })]);
  await wait(20);
  expect(mark('ses_plain').getAttribute('data-rig')).toBe('plain');
  expect(mark('ses_plain').querySelector('.am-plain .ib-mk')).not.toBeNull();
  expect(loops(mark('ses_plain')).length).toBeGreaterThan(0);
  const lengths = (id: string) => [...new Set(loops(mark(id)).map((an) => Number(an.options.duration)))].sort().join();
  expect(lengths('ses_a')).not.toBe(lengths('ses_b'));
  for (const id of ['ses_a', 'ses_plain']) {
    const el = mark(id);
    const start = made.filter((an) => el.contains(an.target)).length;
    await until(() => made.filter((an) => el.contains(an.target)).length > start, `a gesture of ${id}`);
  }
});

test.skipIf(!hasDom)('the pointer in the sidebar: each mark leans toward it within the small bound, at its own pace, and its eyes look too', async () => {
  motion.agentMotionOptions.fidgets = false;
  // Slow enough that a busy machine still sees them on the way.
  motion.agentMotionOptions.clock = 2;
  const [claude, codex, plain] = handSidebar(['claude', 'codex', null]) as [HTMLElement, HTMLElement, HTMLElement];
  expect(motion.agentPointerActivity().listening).toBe(true);
  expect(atRest(codex)).toBe(true);
  pointerTo(200, 600);
  const seen: ReturnType<typeof lean>[] = [];
  let apart = false;
  for (let i = 0; i < 400 && !(apart && seen.length > 60); i++) {
    await wait(8);
    if (i % 20 === 19) pointerTo(200 + (i % 3), 600);
    const now = [lean(claude), lean(codex), lean(plain)];
    seen.push(...now);
    const flying = (y: number) => y > 0.1 && y < 1.3;
    const ys = now.map((at) => at.body.y);
    if (ys.some(flying) && Math.max(...ys) - Math.min(...ys) > 0.005) apart = true;
  }
  expect(apart).toBe(true);
  const { shift, turn, eyes } = motion.AGENT_LOOK;
  for (const at of seen) {
    expect(Math.hypot(at.body.x, at.body.y)).toBeLessThanOrEqual(shift + 0.001);
    expect(Math.abs(at.body.turn)).toBeLessThanOrEqual(turn + 0.001);
    expect(Math.hypot(at.eyes.x, at.eyes.y)).toBeLessThanOrEqual(eyes + 0.001);
  }
  pointerTo(201, 600);
  await until(() => lean(codex).body.y > 1.2 && lean(claude).body.y > 1.2, 'the marks to arrive');
  const there = lean(codex);
  expect(there.body.x).toBeGreaterThan(0.3);
  expect(there.body.turn).toBeGreaterThan(0.5);
  expect(there.eyes.y).toBeGreaterThan(1);
  expect(lean(claude).body.turn).toBe(0);
  expect(loops(codex).length).toBeGreaterThan(0);
  pointerTo(17 + 12, 100 + 36 + 12);
  await until(() => lean(plain).body.y < -0.4 && Math.hypot(lean(codex).body.x, lean(codex).body.y) < 0.05, 'codex to look straight, its neighbour up');
  await until(() => !motion.agentPointerActivity().frame, 'the frames to stop');
});

test.skipIf(!hasDom)('the lean lets go: the pointer out of the sidebar, or still for a while, and each mark drifts back; a touch is never followed', async () => {
  motion.agentMotionOptions.fidgets = false;
  motion.agentMotionOptions.clock = 6;
  const [codex, pi] = handSidebar(['codex', 'pi']) as [HTMLElement, HTMLElement];
  pointerTo(200, 600, 'touch');
  await wait(80);
  expect(atRest(codex) && atRest(pi)).toBe(true);
  pointerTo(200, 600);
  await until(() => lean(codex).body.y > 1 && lean(pi).eyes.y > 1, 'both to lean');
  pointerTo(600, 300);
  await until(() => atRest(codex) && atRest(pi), 'both to drift back');
  await until(() => !motion.agentPointerActivity().frame, 'the frames to stop');
  pointerTo(120, 500);
  await until(() => lean(codex).body.y > 1, 'codex to lean again');
  await until(() => atRest(codex) && atRest(pi), 'both to let go of a still pointer');
  await until(() => !motion.agentPointerActivity().frame, 'the frames to stop');
});

test.skipIf(!hasDom)('reduced motion: nothing follows the pointer and nothing listens; off screen a mark does not follow either', async () => {
  motion.agentMotionOptions.fidgets = false;
  motion.agentMotionOptions.clock = 6;
  reduce = true;
  const still = handSidebar(['codex', 'opencode']);
  expect(made).toEqual([]);
  expect(motion.agentPointerActivity().listening).toBe(false);
  pointerTo(200, 600);
  await wait(80);
  expect(still.every(atRest)).toBe(true);
  for (const el of mounted.splice(0)) motion.unmountAgentMark(el);
  document.body.innerHTML = '';
  reduce = false;
  const [shown, hidden] = handSidebar(['codex', 'opencode']) as [HTMLElement, HTMLElement];
  const watcher = watchers.find((w) => w.seen.has(hidden))!;
  act(() => watcher.cb([{ target: hidden, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  pointerTo(200, 600);
  await until(() => lean(shown).body.y > 1, 'the shown mark to lean');
  expect(atRest(hidden)).toBe(true);
  expect(running(hidden)).toEqual([]);
});

test.skipIf(!hasDom)('unmount leaves nothing behind: no animation, no frame, no pointer listener, even in the middle of a lean and a gesture', async () => {
  motion.agentMotionOptions.clock = 6;
  const marks = handSidebar(['claude', 'codex', 'pi', 'opencode', null]);
  pointerTo(200, 600);
  await wait(40);
  expect(motion.agentPointerActivity()).toEqual({ listening: true, frame: true });
  expect(made.filter((an) => an.playState === 'running').length).toBeGreaterThan(0);
  for (const el of mounted.splice(0)) motion.unmountAgentMark(el);
  expect(made.filter((an) => an.playState === 'running' || an.playState === 'paused')).toEqual([]);
  expect(motion.agentPointerActivity()).toEqual({ listening: false, frame: false });
  expect(marks.every((el) => el.innerHTML === '')).toBe(true);
  const after = made.length;
  pointerTo(100, 300);
  await wait(120);
  expect(made.length).toBe(after);
  expect(motion.agentPointerActivity().frame).toBe(false);
});

const turnOf = (an: FakeAnimation) => {
  const deg = (f: Keyframe | undefined) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(f?.transform ?? ''))?.[1] ?? NaN);
  return deg(an.frames[an.frames.length - 1]) - deg(an.frames[0]);
};

test.skipIf(!hasDom)('Claude: nothing runs between gestures, no turn goes on and on, each turn is small, and it still gestures by itself', async () => {
  motion.agentMotionOptions.clock = 400;
  const [star] = handSidebar(['claude']) as [HTMLElement];
  expect(made.filter((an) => star.contains(an.target) && an.options.iterations === Infinity)).toEqual([]);
  const spin = star.querySelector('.am-spin')!;
  await until(() => made.filter((an) => an.target === spin).length >= 3, 'three part turns');
  const own = made.filter((an) => star.contains(an.target));
  expect(own.every((an) => an.options.iterations === undefined || an.options.iterations === 1)).toBe(true);
  for (const an of own.filter((a) => a.target === spin)) {
    expect(Math.abs(turnOf(an))).toBeGreaterThan(1);
    expect(Math.abs(turnOf(an))).toBeLessThanOrEqual(motion.CLAUDE_CALM.turn[1] + 0.01);
    expect(Number(an.options.duration)).toBeGreaterThanOrEqual(motion.CLAUDE_CALM.turnMs[0]);
  }
});

test.skipIf(!hasDom)('Claude under reduced motion: it holds still, no gesture and no turn ever starts', async () => {
  reduce = true;
  motion.agentMotionOptions.clock = 400;
  const [star] = handSidebar(['claude']) as [HTMLElement];
  // At 400 times the clock its first gesture would come within about 20 ms; give it ten times that.
  await wait(250);
  expect(made.filter((an) => star.contains(an.target))).toEqual([]);
  reduce = false;
  const [moving] = handSidebar(['claude']) as [HTMLElement];
  await until(() => made.some((an) => moving.contains(an.target)), 'a gesture with motion allowed');
});

test.skipIf(!hasDom)('several Claude marks never move in step: each starts its gestures on its own schedule, and a turn picks up where the last one left the star', async () => {
  motion.agentMotionOptions.clock = 400;
  const stars = handSidebar(['claude', 'claude', 'claude']);
  const firsts = () => stars.map((el) => made.find((an) => el.contains(an.target))?.at);
  await until(() => firsts().every((at) => at !== undefined), 'a gesture from each');
  expect(new Set(firsts()).size).toBe(3);
  const spin = stars[0]!.querySelector('.am-spin')!;
  await until(() => made.filter((an) => an.target === spin).length >= 3, 'three turns of one star');
  const turns = made.filter((an) => an.target === spin);
  const deg = (f: Keyframe | undefined) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(f?.transform ?? ''))?.[1]);
  for (let i = 1; i < turns.length; i++) {
    const end = (((deg(turns[i - 1]!.frames.at(-1)) % 360) + 360) % 360).toFixed(1);
    const start = (((deg(turns[i]!.frames[0]) % 360) + 360) % 360).toFixed(1);
    expect(start).toBe(end);
  }
});

test.skipIf(!hasDom)('a Glass face keeps its rounded tile while it moves: every frame scales both axes alike and never skews', async () => {
  motion.agentMotionOptions.clock = 300;
  motion.setAgentFaceArt(Object.fromEntries(motion.AGENT_FACES.filter((f) => f !== 'agent').map((f) => [f, `<img class="am-art" data-art="${f}" alt="">`])) as Parameters<typeof motion.setAgentFaceArt>[0]);
  const [el] = handSidebar([null]) as [HTMLElement];
  motion.showAgentFace(el, 'glass-blue', false);
  const face = el.querySelector('.am-f-glass-blue')!;
  const gestures = () => made.filter((an) => face.contains(an.target) && an.options.iterations !== Infinity);
  await until(() => gestures().length >= 12, 'a dozen gestures of the Glass face');
  const frames = made.filter((an) => face.contains(an.target)).flatMap((an) => an.frames.map((f) => String(f.transform ?? '')));
  expect(frames.length).toBeGreaterThan(50);
  let squashes = 0;
  for (const t of frames) {
    for (const m of t.matchAll(/scale\(([-\d.]+),([-\d.]+)\)/g)) {
      expect(Math.abs(Number(m[1]) - Number(m[2]))).toBeLessThan(0.0015);
      if (Number(m[1]) !== 1) squashes++;
    }
    for (const m of t.matchAll(/skewX\(([-\d.]+)deg\)/g)) expect(Number(m[1])).toBe(0);
  }
  expect(squashes).toBeGreaterThan(0);
});
