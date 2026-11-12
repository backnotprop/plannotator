import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxComposeLaunch, InboxListRow } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import type { SidebarProps } from '../components/Sidebar';

const hasDom = typeof document !== 'undefined';

let reduce = false;
interface FakeAnimation {
  target: Element;
  options: KeyframeAnimationOptions;
  frames: Keyframe[];
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
    const record: FakeAnimation = { target: this, options: opts, frames: (frames ?? []) as Keyframe[], playState: 'running' };
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
const { ComposeDialog } = (hasDom ? await import('../compose/ComposeDialog') : {}) as typeof import('../compose/ComposeDialog');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('../inboxUrl') : {}) as typeof import('../inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('../compose/useMachineLaunches') : {}) as typeof import('../compose/useMachineLaunches');
const { setInboxAgents } = await import('../agentsList');
const { machinesModel } = await import('../machines');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const MINI = `ibx_01K${'0'.repeat(22)}N`;
const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;
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
const group = (agents: InboxAgent[], machine?: string): InboxAgentsGroup => ({ ...(machine ? { machine } : {}), agents, total: agents.length, ended_today: 0 });
const threadRow = (id: string, session: string, subject: string, machine?: string): InboxListRow =>
  ({ thread_id: id, subject, thread_name: null, author: { kind: 'agent', host: 'claude-code', session, name: null }, last_at: '2026-11-09T09:00:00.000Z', waiting_on_person: false, ...(machine ? { machine } : {}) }) as InboxListRow;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  reduce = false;
  made.length = 0;
  motion.agentMotionOptions.clock = 1;
  motion.agentMotionOptions.simulatedDom = true;
  window.localStorage.clear();
  faces.resetAgentFaces();
  setInboxAgents(null);
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  setInboxAgents(null);
});

function mount(node: React.ReactNode) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<SidebarProvider>{node}</SidebarProvider>));
}
function unmountAll() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const noop = () => {};
function sidebarProps(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    page: 'inbox',
    projectId: null,
    inboxCount: 2,
    projects: [] as never,
    projectCounts: new Map(),
    update: null,
    restarting: false,
    updated: null,
    pins: [],
    onInbox: noop,
    onProject: noop,
    onSettings: noop,
    onUpdate: noop,
    onWhatsNew: noop,
    onMachine: noop,
    ...over,
  } as SidebarProps;
}

const three = () => machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook', { state: 'offline' }), view(MINI, 'Mini')]);
const surface = () => document.querySelector<HTMLElement>('[data-agents-surface]');
const names = (scope: ParentNode) => [...scope.querySelectorAll('.ib-name')].map((el) => el.textContent);
const mark = (id: string) => document.querySelector<HTMLElement>(`[data-agent-mark="${id}"]`)!;

test.skipIf(!hasDom)("Agents takes Machines' place above Projects: each machine a quiet caption with its agents under it, no counts, no ended agent", () => {
  setInboxAgents([group([agent('ses_s1', { label: 'Fix login redirect' }), agent('ses_s2', { host: 'codex', state: 'working' })], SELF), group([agent('ses_m1', { host: 'pi' }), agent('ses_m2', { state: 'ended', live: false })], MAC)]);
  const picked: string[] = [];
  mount(<Sidebar {...sidebarProps({ machines: three(), machineCounts: new Map([[SELF, 3]]), onMachine: (id) => picked.push(id) })} />);
  const headers = [...document.querySelectorAll('[data-sidebar-section]')].map((h) => h.getAttribute('data-sidebar-section'));
  expect(headers).toContain('agents');
  expect(headers).not.toContain('machines');
  expect(headers.indexOf('agents')).toBeLessThan(headers.indexOf('projects'));
  expect(document.querySelector('[data-sidebar-section="agents"]')!.textContent).toBe('Agents');
  const groups = [...surface()!.querySelectorAll<HTMLElement>('[data-agents-machine]')];
  expect(groups.map((g) => g.querySelector('[data-machine] .ib-name')!.textContent)).toEqual(['Studio', 'MacBook']);
  expect(groups.map((g) => [...g.querySelectorAll('[data-sidebar-agent]')].map((r) => r.getAttribute('data-sidebar-agent')))).toEqual([['ses_s1', 'ses_s2'], ['ses_m1']]);
  expect(names(groups[0]!.querySelector('[data-sidebar-agent]')!)).toEqual(['Fix login redirect']);
  for (const caption of surface()!.querySelectorAll('[data-machine]')) expect(caption.classList.contains('ib-proj-quiet')).toBe(true);
  expect(surface()!.querySelector(`[data-machine="${MAC}"]`)!.hasAttribute('data-away')).toBe(true);
  expect(surface()!.querySelector(`[data-machine="${MAC}"]`)!.textContent).toContain('MacBook asleep since');
  expect(surface()!.querySelector('.ib-n')).toBeNull();
  act(() => surface()!.querySelector<HTMLButtonElement>(`[data-machine="${MAC}"]`)!.click());
  expect(picked).toEqual([MAC]);
  mount(<Sidebar {...sidebarProps({ machines: three(), machineId: MAC })} />);
  expect(surface()!.querySelector(`[data-machine="${MAC}"]`)!.getAttribute('aria-current')).toBe('page');
});

test.skipIf(!hasDom)('with no machine linked the agents are one flat list; an Inbox with no agents field and no link has no section', () => {
  const alone = machinesModel([view(SELF, 'Studio')]);
  mount(<Sidebar {...sidebarProps({ machines: alone })} />);
  expect(surface()).toBeNull();
  act(() => setInboxAgents([group([agent('ses_a'), agent('ses_b', { host: 'opencode' })])]));
  expect(surface()).not.toBeNull();
  expect(surface()!.querySelector('[data-agents-section]')!.hasAttribute('data-flat')).toBe(true);
  expect(surface()!.querySelector('[data-machine]')).toBeNull();
  expect(surface()!.querySelectorAll('[data-sidebar-agent]')).toHaveLength(2);
  act(() => setInboxAgents([group([])]));
  expect(surface()!.textContent).toContain('Agents show here while they run.');
});

test.skipIf(!hasDom)('Add agent and Add machine are always-shown buttons with their own routes; an agent row filters the list, or messages a live agent with no thread', () => {
  setInboxAgents([group([agent('ses_s1'), agent('ses_s2')], SELF)]);
  const calls: string[] = [];
  let opener: HTMLElement | null = null;
  const rows = [threadRow('thr_1', 'ses_s1', 'Invoice retries')];
  mount(
    <Sidebar
      {...sidebarProps({
        machines: three(),
        agentRows: rows,
        onAddAgent: (el) => {
          opener = el;
          calls.push('add-agent');
        },
        onAddMachine: () => calls.push('add-machine'),
        onAgentFilter: (id) => calls.push(`filter:${id}`),
        onMessageAgent: (session) => calls.push(`message:${session}`),
      })}
    />,
  );
  const add = surface()!.querySelector<HTMLButtonElement>('[data-agents-add="agent"]')!;
  const machine = surface()!.querySelector<HTMLButtonElement>('[data-agents-add="machine"]')!;
  expect([add.getAttribute('aria-label'), machine.getAttribute('aria-label')]).toEqual(['Add agent', 'Add machine']);
  expect(add.closest('[data-sidebar-section]')).toBeNull();
  act(() => add.click());
  expect(opener === add).toBe(true);
  act(() => machine.click());
  act(() => surface()!.querySelector<HTMLButtonElement>('[data-sidebar-agent="ses_s1"] .ib-proj')!.click());
  act(() => surface()!.querySelector<HTMLButtonElement>('[data-sidebar-agent="ses_s2"] .ib-proj')!.click());
  expect(calls).toEqual(['add-agent', 'add-machine', 'filter:ses_s1', 'message:ses_s2']);
  expect(names(surface()!.querySelector('[data-sidebar-agent="ses_s1"]')!)).toEqual(['Invoice retries']);
  mount(<Sidebar {...sidebarProps({ machines: three(), onAddAgent: noop })} />);
  expect(surface()!.querySelectorAll('[data-agents-add]')).toHaveLength(1);
});

test.skipIf(!hasDom)("a starred thread that is also an agent's thread shows under Starred and under Agents: the star opens it, the agent filters to it", () => {
  setInboxAgents([group([agent('ses_s1'), agent('ses_s2')])]);
  const starred = { ...threadRow('thr_star', 'ses_s1', 'Starred and running'), project: { id: 'prj_bill', name: 'billing-svc' }, section: 'waiting', unread: false, unseen: 0, read_at: null, resolved_at: null, questions: { open: 2, holds_up: [] } } as unknown as InboxListRow;
  const opened: string[] = [];
  mount(<Sidebar {...sidebarProps({ pins: [starred], agentRows: [starred, threadRow('thr_other', 'ses_s2', 'Only running')], onOpenPin: (row) => opened.push(`pin:${row.thread_id}`), onAgentFilter: (id) => opened.push(`agent:${id}`) })} />);
  expect(document.querySelectorAll('[data-pinned-row="thr_star"]')).toHaveLength(1);
  expect(names(surface()!)).toEqual(['Starred and running', 'Only running']);
  act(() => document.querySelector<HTMLElement>('[data-pinned-row="thr_star"]')!.click());
  act(() => surface()!.querySelector<HTMLElement>('[data-sidebar-agent="ses_s1"] .ib-proj')!.click());
  expect(opened).toEqual(['pin:thr_star', 'agent:ses_s1']);
});

test.skipIf(!hasDom)('a click on an agent filters the list to it and opens no thread, even its only one; a second click clears; a caption still filters by machine', async () => {
  const { useState } = await import('react');
  setInboxAgents([group([agent('ses_many'), agent('ses_one'), agent('ses_none')], SELF), group([agent('ses_m1')], MAC)]);
  const rows = [threadRow('thr_a', 'ses_many', 'Invoice retries'), threadRow('thr_b', 'ses_many', 'Refund flow'), threadRow('thr_c', 'ses_many', 'Docs pass'), threadRow('thr_d', 'ses_one', 'Only one'), threadRow('thr_m', 'ses_m1', 'On the MacBook', MAC)];
  const calls: string[] = [];
  function Window() {
    const [on, setOn] = useState<string | null>(null);
    return (
      <Sidebar
        {...sidebarProps({
          machines: three(),
          agentRows: rows,
          agentFilter: on ? { id: on, name: on } : null,
          onAgentFilter: (id) => {
            calls.push(`filter:${id}`);
            setOn(id);
          },
          onMessageAgent: (session) => calls.push(`message:${session}`),
          onOpenPin: (row) => calls.push(`open:${row.thread_id}`),
          onMachine: (id) => calls.push(`machine:${id}`),
        })}
      />
    );
  }
  mount(<Window />);
  const button = (id: string) => surface()!.querySelector<HTMLButtonElement>(`[data-sidebar-agent="${id}"] .ib-proj`)!;
  const pressed = () => [...surface()!.querySelectorAll<HTMLElement>('[data-sidebar-agent] .ib-proj[aria-pressed="true"]')].map((b) => b.closest('[data-sidebar-agent]')!.getAttribute('data-sidebar-agent'));
  expect(button('ses_many').getAttribute('aria-pressed')).toBe('false');
  act(() => button('ses_many').click());
  expect([calls, pressed(), button('ses_many').classList.contains('ib-on')]).toEqual([['filter:ses_many'], ['ses_many'], true]);
  act(() => button('ses_one').click());
  expect(pressed()).toEqual(['ses_one']);
  act(() => button('ses_one').click());
  expect(pressed()).toEqual([]);
  act(() => button('ses_none').click());
  expect(pressed()).toEqual([]);
  act(() => surface()!.querySelector<HTMLButtonElement>(`[data-machine="${MAC}"]`)!.click());
  expect(calls).toEqual(['filter:ses_many', 'filter:ses_one', 'filter:null', 'message:ses_none', `machine:${MAC}`]);
  expect(calls.some((c) => c.startsWith('open:'))).toBe(false);
});

test.skipIf(!hasDom)('closed, Agents is its heading alone, whatever is open: no row for the open thread, no machine name, no Add buttons; only a press on the heading opens it', async () => {
  const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) });
  try {
    await closedAgents();
  } finally {
    resetStorageBackend();
  }
});

async function closedAgents() {
  const both = (state: InboxAgent['state'] = 'idle') => [group([agent('ses_s1', { state }), agent('ses_s2')], SELF), group([agent('ses_m1')], MAC)];
  setInboxAgents(both());
  const rowsOf = [threadRow('thr_1', 'ses_s1', 'Invoice retries')];
  const props = (over: Partial<SidebarProps> = {}) => sidebarProps({ machines: three(), agentRows: rowsOf, onAddAgent: noop, onAddMachine: noop, ...over });
  mount(<Sidebar {...props()} />);
  const header = () => document.querySelector<HTMLButtonElement>('[data-sidebar-section="agents"]')!;
  const state = () => ({
    open: header().getAttribute('aria-expanded'),
    buttons: [...surface()!.querySelectorAll('[data-agents-add]')].map((b) => b.getAttribute('data-agents-add')),
    rows: [...surface()!.querySelectorAll('[data-sidebar-agent]')].map((r) => r.getAttribute('data-sidebar-agent')),
    captions: surface()!.querySelectorAll('[data-machine]').length,
    under: surface()!.querySelector('[data-agents-section]')!.childElementCount,
  });
  const shut = { open: 'false', buttons: [], rows: [], captions: 0, under: 0 };
  expect(state()).toEqual({ open: 'true', buttons: ['agent', 'machine'], rows: ['ses_s1', 'ses_s2', 'ses_m1'], captions: 2, under: 2 });
  act(() => header().click());
  expect(state()).toEqual(shut);
  expect(surface()!.querySelector('[data-sidebar-section="agents"] .ib-agents-mk')).not.toBeNull();
  mount(<Sidebar {...props({ openThreadId: 'thr_1' })} />);
  expect(state()).toEqual(shut);
  mount(<Sidebar {...props({ openThreadId: 'thr_1', machineId: MAC })} />);
  expect(state()).toEqual(shut);
  act(() => setInboxAgents([...both('waiting'), group([agent('ses_n1')], MINI)]));
  expect(state()).toEqual(shut);
  act(() => setInboxAgents([group([], SELF)]));
  expect(state()).toEqual(shut);
  act(() => setInboxAgents(both()));
  unmountAll();
  mount(<Sidebar {...props({ openThreadId: 'thr_1' })} />);
  expect(state()).toEqual(shut);
  act(() => header().click());
  expect(state()).toEqual({ open: 'true', buttons: ['agent', 'machine'], rows: ['ses_s1', 'ses_s2', 'ses_m1'], captions: 2, under: 2 });
  expect(surface()!.querySelector('[data-sidebar-agent="ses_s1"] .ib-proj')!.getAttribute('aria-pressed')).toBe('false');
  mount(<Sidebar {...props({ openThreadId: 'thr_1', agentFilter: { id: 'ses_s1', name: 'Invoice retries' } })} />);
  expect(surface()!.querySelector('[data-sidebar-agent="ses_s1"] .ib-proj')!.getAttribute('aria-pressed')).toBe('true');
}

test.skipIf(!hasDom)("a machine's name shows only while agents show from more than one machine, and a machine with no agent shows nothing", () => {
  const captions = () => [...surface()!.querySelectorAll('[data-machine] .ib-name')].map((el) => el.textContent);
  const rows = () => [...surface()!.querySelectorAll('[data-sidebar-agent]')].map((r) => r.getAttribute('data-sidebar-agent'));
  const flush = () => surface()!.querySelector('[data-agents-section]')!.hasAttribute('data-flat');
  const draw = (groups: InboxAgentsGroup[], machineId: string | null = null) => {
    act(() => setInboxAgents(groups));
    mount(<Sidebar {...sidebarProps({ machines: three(), machineId })} />);
  };
  draw([group([agent('ses_s1'), agent('ses_s2')], SELF), group([], MAC), group([], MINI)]);
  expect([captions(), rows(), flush()]).toEqual([[], ['ses_s1', 'ses_s2'], true]);
  expect(surface()!.querySelectorAll('[data-agents-machine]')).toHaveLength(1);
  draw([group([], SELF), group([agent('ses_m1')], MAC)]);
  expect([captions(), rows(), flush()]).toEqual([[], ['ses_m1'], true]);
  draw([group([], SELF), group([agent('ses_m1')], MAC)], MAC);
  expect(captions()).toEqual([]);
  draw([group([agent('ses_s1')], SELF), group([agent('ses_m1')], MAC), group([], MINI)]);
  expect([captions(), rows(), flush()]).toEqual([['Studio', 'MacBook'], ['ses_s1', 'ses_m1'], false]);
  draw([group([agent('ses_s1')], SELF), group([agent('ses_m2', { state: 'ended', live: false })], MAC)]);
  expect([captions(), rows()]).toEqual([[], ['ses_s1']]);
  draw([group([], SELF), group([], MAC), group([], MINI)]);
  expect(captions()).toEqual([]);
  expect(surface()!.querySelectorAll('.ib-agents-empty')).toHaveLength(1);
  expect(surface()!.textContent).toContain('Agents show here while they run.');
});

const HERE: InboxComposeLaunch = {
  agents: [
    { agent: 'claude-code', name: 'Claude Code' },
    { agent: 'pi', name: 'Pi' },
  ],
  projects: [
    { id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true },
    { id: 'prj_bill', name: 'billing-svc', root: '/Users/me/code/billing-svc', exists: true },
  ],
};

test.skipIf(!hasDom)('Add agent opens New message with "New … session" chosen: the agent started last in the project looked at, else the first; the cursor in the message', async () => {
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines: [view(SELF, 'Studio', { launch: null })] });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], launch: HERE });
    return Response.json({});
  }) as typeof fetch;
  const open = (agentId: string | null, current: { id: string; root: string; name: string } | null) =>
    mount(<ComposeDialog request={{ launch: { agent: agentId } }} phone={false} current={current} lastSent={null} home="/Users/me" onSent={noop} onHeld={noop} onSaved={noop} onDeleted={noop} onClose={noop} />);
  const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;
  open('pi', { id: 'prj_bill', root: '/Users/me/code/billing-svc', name: 'billing-svc' });
  await until(() => inDialog('[data-compose-folder="prj_bill"]') !== null, 'the project looked at in To');
  expect(inDialog('[data-compose-to]')!.textContent).toContain('New Pi session');
  expect(document.activeElement).toBe(inDialog('textarea'));
  unmountAll();
  open(null, null);
  await until(() => inDialog('[data-compose-folder="prj_web"]') !== null, 'the first project in To');
  expect(inDialog('[data-compose-to]')!.textContent).toContain('New Claude Code session');
});

const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((face) => face !== 'agent').map((face) => [face, `<i data-art="${face}"></i>`])) as Parameters<typeof motion.setAgentFaceArt>[0];

test.skipIf(!hasDom)('a click on a mark shows the next face (agent, Glass, Yellow, Transparent, Face, agent), never opens the row, and the face is kept until the next click', async () => {
  motion.setAgentFaceArt(ART);
  setInboxAgents([group([agent('ses_s1')], SELF)]);
  const opened: string[] = [];
  const props = sidebarProps({ machines: three(), agentRows: [threadRow('thr_1', 'ses_s1', 'Invoice retries')], onAgentFilter: (id) => opened.push(String(id)) });
  mount(<Sidebar {...props} />);
  expect(mark('ses_s1').dataset.face).toBe('agent');
  const seen: string[] = [];
  for (let i = 0; i < 2; i++) {
    act(() => mark('ses_s1').click());
    await wait(20);
    seen.push(mark('ses_s1').dataset.face!);
  }
  expect(opened).toEqual([]);
  unmountAll();
  faces.resetAgentFaces();
  mount(<Sidebar {...props} />);
  await wait(20);
  expect(mark('ses_s1').dataset.face).toBe('yellow');
  for (let i = 0; i < 3; i++) {
    act(() => mark('ses_s1').click());
    await wait(20);
    seen.push(mark('ses_s1').dataset.face!);
  }
  expect(seen).toEqual(['glass', 'yellow', 'transparent', 'totman', 'agent']);
  expect(JSON.parse(window.localStorage.getItem(faces.AGENT_FACES_PAINT_KEY)!).faces).toEqual({});
  expect(opened).toEqual([]);
});

test.skipIf(!hasDom)('reduced motion: every mark holds still (no loop, no spin, no fidget), and a face swap is a plain fade', async () => {
  reduce = true;
  motion.setAgentFaceArt(ART);
  motion.agentMotionOptions.clock = 200;
  setInboxAgents([group([agent('ses_c', { state: 'working' }), agent('ses_x', { host: 'codex', state: 'waiting', waiting: 1 }), agent('ses_p', { host: 'pi' }), agent('ses_o', { host: 'opencode' })], SELF)]);
  mount(<Sidebar {...sidebarProps({ machines: three() })} />);
  await wait(60);
  expect(document.querySelectorAll('[data-agent-mark]')).toHaveLength(4);
  expect(made).toEqual([]);
  expect(mark('ses_c').querySelector<HTMLElement>('.am-p')!.style.transform).not.toBe('');
  const before = made.length;
  await wait(120);
  expect(made.length).toBe(before);
  act(() => mark('ses_c').click());
  await wait(20);
  const swap = made.slice(before);
  expect(swap.length).toBeGreaterThan(0);
  expect(swap.every((an) => an.frames.every((f) => !('transform' in f)))).toBe(true);
});

test.skipIf(!hasDom)('perf: off screen a mark pauses everything and starts no fidget; back on screen it plays; a hidden face stops; unmount cancels all', async () => {
  motion.setAgentFaceArt(ART);
  motion.agentMotionOptions.clock = 200;
  setInboxAgents([group([agent('ses_c', { host: 'codex', state: 'working' })], SELF)]);
  mount(<Sidebar {...sidebarProps({ machines: three() })} />);
  await wait(20);
  const el = mark('ses_c');
  const own = () => made.filter((an) => el.contains(an.target));
  expect(motion.agentMarkActivity(el)!.playing).toBeGreaterThan(0);
  const marks = watchers.filter((w) => [...w.seen].some((seen) => seen instanceof HTMLElement && seen.hasAttribute('data-agent-mark')));
  expect(marks).toHaveLength(1);
  const watcher = marks[0]!;
  const observe = (on: boolean) => act(() => watcher.cb([{ target: el, isIntersecting: on } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  observe(false);
  expect(motion.agentMarkActivity(el)).toMatchObject({ playing: 0, off: true });
  const offAt = own().length;
  await wait(150);
  expect(own().length).toBe(offAt);
  expect(own().filter((an) => an.playState === 'running')).toEqual([]);
  observe(true);
  expect(motion.agentMarkActivity(el)!.playing).toBeGreaterThan(0);
  motion.agentMotionOptions.clock = 1;
  act(() => el.click());
  await wait(60);
  const agentFace = el.querySelector('.am-f-agent')!;
  expect((agentFace as HTMLElement).hidden).toBe(true);
  expect(made.filter((an) => agentFace.contains(an.target) && an.playState !== 'idle' && an.playState !== 'finished')).toEqual([]);
  unmountAll();
  expect(made.filter((an) => an.playState === 'running' || an.playState === 'paused')).toEqual([]);
  expect([...watcher.seen].filter((seen) => (seen as HTMLElement).hasAttribute?.('data-agent-mark'))).toEqual([]);
});
