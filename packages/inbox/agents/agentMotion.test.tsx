/**
 * The agent marks' life (approval "inbox-agent-icon-motion", the owner 2026-11-09: always alive, never the agent's
 * state, a subtle lean toward the pointer), on motion.ts and on the window's own Sidebar.
 *
 * What this catches: a mark that moves differently (or restarts) when its agent's state changes; two marks of one
 * kind running the same loop, so a list moves in unison; a mark with nothing to do between state changes (no gesture
 * of its own); a plain mark (a host with no rig) left still; the lean toward the pointer going past its small bound,
 * snapping, following a touch, following outside the sidebar, or never letting go (the pointer gone, or still);
 * reduced motion or an off-screen mark following the pointer; an unmounted list leaving animations, a frame or the
 * page's pointer listener behind.
 *
 * Web Animations and IntersectionObserver are stood in for (happy-dom has neither to watch). DOM-gated: runs under
 * DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server, no fetch.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import type { SidebarProps } from '../components/Sidebar';

const hasDom = typeof document !== 'undefined';

/* ---------- stand-ins, before motion.ts reads them at load ---------- */
let reduce = false;
interface FakeAnimation {
  target: Element;
  options: KeyframeAnimationOptions;
  playState: 'running' | 'paused' | 'finished' | 'idle';
}
const made: FakeAnimation[] = [];
const watchers: { cb: IntersectionObserverCallback; seen: Set<Element> }[] = [];
if (hasDom) {
  const query = { media: '(prefers-reduced-motion: reduce)', get matches() { return reduce; }, addEventListener() {}, removeEventListener() {} };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = window.matchMedia;
  Element.prototype.animate = function (this: Element, _frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    const opts = (typeof options === 'number' ? { duration: options } : (options ?? {})) as KeyframeAnimationOptions;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    finished.catch(() => {});
    const record: FakeAnimation = { target: this, options: opts, playState: 'running' };
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
    // A finite animation ends on its own (soon, here); a loop runs until paused or cancelled.
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

/* ---------- a sidebar drawn by hand, with places on the page (happy-dom lays nothing out) ---------- */
const place = (el: Element, left: number, top: number, width: number, height: number) => {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
};
/** A 232 px sidebar with a mark in every row from y = 100, 36 px apart, each 24 px at x = 17. */
function handSidebar(rigs: (import('./rigs').AgentRigKind | null)[]): HTMLElement[] {
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
/** What the pointer has done to a mark: its lean in px and degrees, and its eyes' shift in px (all 0 at rest). */
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
  // (An ended agent leaves the list, and its mark with it.)
  for (const state of ['working', 'waiting', 'idle'] as const) {
    sidebar([agent('ses_c', { state, waiting: state === 'waiting' ? 1 : 0 }), agent('ses_x', { host: 'codex', state })]);
    await wait(20);
    // The same animations, still running; none made for the new state.
    expect(made.length).toBe(before);
    expect(live.every((an) => an.playState === 'running')).toBe(true);
  }
  // The row still says the state in words (its hover card); the mark carries none.
  expect(document.querySelector('[data-sidebar-agent="ses_c"]')!.getAttribute('data-agent-state')).toBe('idle');
  expect(mark('ses_c').hasAttribute('data-state')).toBe(false);
});

test.skipIf(!hasDom)('every mark has a life of its own: an idle agent gestures by itself, a plain mark moves too, and two marks of one kind never run the same loop', async () => {
  motion.agentMotionOptions.clock = 200;
  sidebar([agent('ses_a'), agent('ses_b'), agent('ses_plain', { host: 'some-new-agent' })]);
  await wait(20);
  // The host with no rig draws its plain mark inside a moving layer.
  expect(mark('ses_plain').getAttribute('data-rig')).toBe('plain');
  expect(mark('ses_plain').querySelector('.am-plain .ib-mk')).not.toBeNull();
  expect(loops(mark('ses_plain')).length).toBeGreaterThan(0);
  // Same kind, same state, different agents: their loops differ in length, so they never line up.
  const lengths = (id: string) => [...new Set(loops(mark(id)).map((an) => Number(an.options.duration)))].sort().join();
  expect(lengths('ses_a')).not.toBe(lengths('ses_b'));
  // Left alone (no state change, no pointer), each does something now and then.
  for (const id of ['ses_a', 'ses_plain']) {
    const el = mark(id);
    const start = made.filter((an) => el.contains(an.target)).length;
    await until(() => made.filter((an) => el.contains(an.target)).length > start, `a gesture of ${id}`);
  }
});

test.skipIf(!hasDom)('the pointer in the sidebar: each mark leans toward it within the small bound, at its own pace, and its eyes look too', async () => {
  motion.agentMotionOptions.fidgets = false;
  motion.agentMotionOptions.clock = 6;
  const [claude, codex, plain] = handSidebar(['claude', 'codex', null]) as [HTMLElement, HTMLElement, HTMLElement];
  expect(motion.agentPointerActivity().listening).toBe(true);
  expect(atRest(codex)).toBe(true);
  // Below and to the right of all three, inside the sidebar.
  pointerTo(200, 600);
  const seen: ReturnType<typeof lean>[] = [];
  let apart = false;
  for (let i = 0; i < 30; i++) {
    await wait(8);
    const now = [lean(claude), lean(codex), lean(plain)];
    seen.push(...now);
    // On the way there they are not at the same place: each has its own lag.
    if (now[1]!.body.y > 0.2 && now[1]!.body.y < 1.2 && Math.abs(now[1]!.body.y - now[2]!.body.y) > 0.02) apart = true;
  }
  expect(apart).toBe(true);
  const { shift, turn, eyes } = motion.AGENT_LOOK;
  for (const at of seen) {
    expect(Math.hypot(at.body.x, at.body.y)).toBeLessThanOrEqual(shift + 0.001);
    expect(Math.abs(at.body.turn)).toBeLessThanOrEqual(turn + 0.001);
    expect(Math.hypot(at.eyes.x, at.eyes.y)).toBeLessThanOrEqual(eyes + 0.001);
  }
  // Arrived (the pointer stirs, so it is not taken for still): toward it (right and down), by a pixel or so, the body
  // turned a little that way.
  pointerTo(201, 600);
  await until(() => lean(codex).body.y > 1.2 && lean(claude).body.y > 1.2, 'the marks to arrive');
  const there = lean(codex);
  expect(there.body.x).toBeGreaterThan(0.3);
  expect(there.body.turn).toBeGreaterThan(0.5);
  expect(there.eyes.y).toBeGreaterThan(1);
  // The star turns anyway: it shifts and does not lean.
  expect(lean(claude).body.turn).toBe(0);
  // Its own life goes on under the lean: nothing was stopped for it.
  expect(loops(codex).length).toBeGreaterThan(0);
  // Right over a mark it looks straight ahead, while its neighbour looks up at the pointer.
  pointerTo(17 + 12, 100 + 36 + 12);
  await until(() => lean(plain).body.y < -0.4 && Math.hypot(lean(codex).body.x, lean(codex).body.y) < 0.05, 'codex to look straight, its neighbour up');
  // Settled, no frame is left running.
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
  // Out over the thread list: not theirs to watch.
  pointerTo(600, 300);
  await until(() => atRest(codex) && atRest(pi), 'both to drift back');
  await until(() => !motion.agentPointerActivity().frame, 'the frames to stop');
  // Back in, then still (stillMs, at this clock half a second): they let go by themselves.
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
  // A pointer move now reaches no one, and no gesture timer fires later.
  const after = made.length;
  pointerTo(100, 300);
  await wait(120);
  expect(made.length).toBe(after);
  expect(motion.agentPointerActivity().frame).toBe(false);
});
