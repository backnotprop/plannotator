/**
 * New message… on a sidebar agent's menu (right-click, ⋯, the phone's sheet): New message with that agent in To.
 *
 * What this catches: the item missing, not first, or offered where To would not take the agent (an ended agent, one
 * heard only over MCP whose thread waits on the person, a launch's placeholder, a stopped launch, an agent that never
 * said where it works, a linked machine's agent while launch is off here or that machine is away or too old to say), or
 * missing for a polled agent whose thread waits on the person; a pick that does not hand the agent's session to New
 * message; New message opened that way not showing the agent in To (this computer's, or a linked machine's) with the
 * cursor in the message.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxComposeLaunch, InboxRunState } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
  Element.prototype.animate = function () {
    const finished = Promise.resolve();
    return { currentTime: 0, playbackRate: 1, finished, playState: 'running', play() {}, pause() {}, cancel() {}, finish() {} } as unknown as Animation;
  } as typeof Element.prototype.animate;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { AgentsSection } = (hasDom ? await import('./AgentsSection') : {}) as typeof import('./AgentsSection');
const { ComposeDialog } = (hasDom ? await import('../compose/ComposeDialog') : {}) as typeof import('../compose/ComposeDialog');
const { resetMachineLaunchesForTests } = (hasDom ? await import('../compose/useMachineLaunches') : {}) as typeof import('../compose/useMachineLaunches');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { resetMachineRoutes, setSelfMachine } = await import('../inboxUrl');
const { machinesModel } = await import('../machines');
const { AGENT_NEW_MESSAGE_LABEL } = await import('./agentNewMessage');

let root: Root | null = null;
let realFetch: typeof fetch;
let messaged: [string, HTMLElement][] = [];
let picks = 0;

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ faces: {}, rev: 0 })) as unknown as typeof fetch;
  messaged = [];
  picks = 0;
  window.localStorage.clear();
  motion.agentMotionOptions.simulatedDom = true;
  setInboxAgents(null);
  faces.resetAgentFaces();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  setInboxAgents(null);
  faces.resetAgentFaces();
  resetMachineRoutes();
  resetMachineLaunchesForTests();
});

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;

// The agents as the server sends them (packages/server/inbox-agents-list.ts `inboxAgentsGroup`). A session that polls
// (or that the Inbox wakes): its sessions branch, live, its project from its root, its start and last poll.
const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_harbor', name: 'harbor' }, state: 'idle', waiting: 0, live: true, started_at: '2026-11-09T09:14:00.000Z', last_seen_at: '2026-11-09T09:46:00.000Z', ...over });
// A launch: its launches branch, the launch's id, `scratch` null in a project.
const launched = (id: string, run: InboxRunState | null, started = true): InboxAgent => agent(id, { session: started ? `ses_${id}` : `launch:${id}`, launch: { id, thread_id: `msg_${id}`, started, run, scratch: null } });
// A thread waiting on the person adds to its owner (the waits branch) and marks it blocked in the Inbox. An owner
// that is no polled session (one heard only over MCP: `plannotator inbox mcp` with nothing that wakes it) is listed by
// that alone: not live, no start, last heard when it wrote.
const WAITS = { state: 'waiting', waiting: 1, status_mark: { state: 'blocked', where: 'inbox' } } as const;
const waitsOnly = (id: string): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_billing', name: 'billing-svc' }, ...WAITS, live: false, started_at: null, last_seen_at: '2026-11-09T09:46:00.000Z' });
const group = (agents: InboxAgent[], machine?: string): InboxAgentsGroup => ({ agents, total: agents.length, ended_today: 0, ...(machine ? { machine } : {}) });

function mount(groups: InboxAgentsGroup[], options: { phone?: boolean; machines?: MachineView[]; newMessage?: { linked: boolean } | null } = {}) {
  setInboxAgents(groups);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentsSection
        machines={machinesModel(options.machines ?? [])}
        rows={[]}
        machineId={null}
        agentId={null}
        page="inbox"
        closed={false}
        onToggle={() => {}}
        labelId="l"
        bodyId="b"
        header={() => null}
        onAgentFilter={() => {}}
        onMessageAgent={(session, opener) => messaged.push([session, opener])}
        newMessage={options.newMessage === null ? undefined : (options.newMessage ?? { linked: true })}
        onAddAgent={() => {}}
        pick={(go) => () => {
          picks++;
          go();
        }}
        phone={options.phone === true}
        onRename={async () => true}
        onStop={() => {}}
        onDelete={() => {}}
      />,
    ),
  );
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};
const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-agent="${id}"]`);

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
  await settle();
}

async function rightClick(id: string) {
  await act(async () => {
    row(id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
  });
  await settle();
}

/** The open menu's items and separators, top to bottom: each item's words, a separator as "—". */
const menu = () =>
  [...document.querySelectorAll('[data-agent-menu] [role="menuitem"], [data-agent-menu] [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '—' : el.textContent?.trim()));

/** The menu's items from ⋯, closed again after; null when the row has no menu. */
async function itemsOf(id: string): Promise<string[] | null> {
  const more = row(id)?.querySelector('[data-agent-more]');
  if (!more) return null;
  await press(more);
  const items = menu() as string[];
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  return items;
}

test.skipIf(!hasDom)('a right-click on an agent To takes: New message… first, with the compose icon; a running launch keeps its separator before Stop', async () => {
  mount([group([agent('ses_ch'), launched('lch_run', 'working')])]);
  await settle();
  await rightClick('ses_ch');
  expect(menu()).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…']);
  expect(document.querySelector('[data-agent-menu] [data-agent-action="message"] [data-icon="compose"], [data-agent-menu] [data-agent-action="message"] svg')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  expect(await itemsOf('lch_run')).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…', '—', 'Stop Claude Code', 'Delete Claude Code session…']);
});

test.skipIf(!hasDom)("picking it hands the agent's session to New message, through the sheet-closing pick, with ⋯ as the opener", async () => {
  mount([group([agent('ses_ch'), agent('ses_bt', { host: 'codex' })])]);
  await settle();
  await rightClick('ses_bt');
  await act(async () => {
    (document.querySelector('[data-agent-menu] [data-agent-action="message"]') as HTMLElement).click();
  });
  await settle();
  expect(messaged.map(([session]) => session)).toEqual(['ses_bt']);
  expect(messaged[0]![1] === row('ses_bt')!.querySelector<HTMLElement>('[data-agent-more]')).toBe(true);
  expect(picks).toBe(1);
  expect(document.querySelector('[data-agent-menu]')).toBeNull();
});

test.skipIf(!hasDom)('not offered where To would not take the agent: ended, a launch not started or stopped, no project; nor without the prop', async () => {
  mount([
    group([
      // Ended, still owning a thread that waits on the person (an ended agent with none is not drawn).
      waitsOnly('ses_ended'),
      launched('lch_new', 'starting', false),
      launched('lch_stop', 'stopped'),
      launched('lch_card', 'waiting_answer'),
      agent('ses_nowhere', { project: null }),
      agent('ses_here'),
    ]),
  ]);
  await settle();
  expect(await itemsOf('ses_ended')).toEqual(['Rename…']);
  expect(await itemsOf('lch_new')).toEqual(['Rename…', '—', 'Delete Claude Code session…']);
  expect(await itemsOf('lch_stop')).toEqual(['Rename…', '—', 'Delete Claude Code session…']);
  // A prompt waiting in the window: its session still polls, so To takes it.
  expect(await itemsOf('lch_card')).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…', '—', 'Delete Claude Code session…']);
  expect(await itemsOf('ses_nowhere')).toEqual(['Rename…']);
  expect(await itemsOf('ses_here')).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…']);
  act(() => root?.unmount());
  document.body.innerHTML = '';
  mount([group([agent('ses_here')])], { newMessage: null });
  await settle();
  expect(await itemsOf('ses_here')).toEqual(['Rename…']);
});

test.skipIf(!hasDom)('an agent whose question waits on the person: offered while its session polls; not for one heard only over MCP, which To leaves out', async () => {
  mount([group([agent('ses_polls', WAITS), waitsOnly('ses_mcp')])]);
  await settle();
  await rightClick('ses_polls');
  expect(menu()).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…']);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  await rightClick('ses_mcp');
  expect(menu()).toEqual(['Rename…']);
});

test.skipIf(!hasDom)("a linked machine's agent: offered while To lists that machine (launch on here, the machine online and new enough to say), else no item", async () => {
  const there = (over: Partial<MachineView> = {}) => [view(SELF, 'Studio'), view(MAC, 'MacBook', over)];
  const groups = () => [group([agent('ses_here')], SELF), group([agent('ses_there', { host: 'codex', project: { id: 'prj_fern', name: 'fern-api' } })], MAC)];
  const itemThere = async (machines: MachineView[], linked: boolean) => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(groups(), { machines, newMessage: { linked } });
    await settle();
    return itemsOf('ses_there');
  };
  // Its menu is the item alone: a linked machine's agent the Inbox did not launch has no other.
  expect(await itemThere(there(), true)).toEqual([AGENT_NEW_MESSAGE_LABEL]);
  expect(await itemThere(there({ launch: false }), true)).toEqual([AGENT_NEW_MESSAGE_LABEL]);
  expect(await itemThere(there(), false)).toBeNull();
  expect(await itemThere(there({ state: 'offline' }), true)).toBeNull();
  expect(await itemThere(there({ launch: null }), true)).toBeNull();
  // This computer's own agent is not held to the linked rule.
  expect(await itemsOf('ses_here')).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…']);
});

test.skipIf(!hasDom)("a phone: the ⋯ sheet has it first, and a pick hands the session to New message", async () => {
  mount([group([agent('ses_ch')])], { phone: true });
  await settle();
  await press(row('ses_ch')!.querySelector('[data-agent-more]')!);
  expect(menu()).toEqual([AGENT_NEW_MESSAGE_LABEL, 'Rename…']);
  expect(document.querySelector('.ib-pm-pos[data-phone] [data-agent-menu]')).not.toBeNull();
  await press(document.querySelector('[data-agent-menu] [data-agent-action="message"]')!);
  expect(messaged.map(([session]) => session)).toEqual(['ses_ch']);
});

/* ---------- New message as the item opens it: `{ session }` (App.tsx `onMessageAgent`) ---------- */

const HERE_LAUNCH: InboxComposeLaunch = { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [{ id: 'prj_harbor', name: 'harbor', root: '/Users/me/code/harbor', exists: true }] };
const session = (id: string, host: string) => ({ session: id, host, started_at: '2026-11-09T09:14:00.000Z', last_seen_at: '2026-11-09T09:46:00.000Z', busy: false, idle_since: '2026-11-09T09:40:00.000Z', last_thread: null });

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => await new Promise((done) => setTimeout(done, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function openCompose(sessionId: string) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const noop = () => {};
  act(() => root!.render(<ComposeDialog request={{ session: sessionId }} phone={false} current={null} lastSent={null} home="/Users/me" onSent={noop} onHeld={noop} onSaved={noop} onDeleted={noop} onClose={noop} />));
}
const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;

test.skipIf(!hasDom)("New message opened for this computer's agent: To is that agent in its project, the cursor in the message", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith('/api/inbox/sessions'))
      return Response.json({
        serverSession: 's',
        home: '/Users/me',
        projects: [
          { project: { id: 'prj_quill', name: 'quill-docs', root: '/Users/me/code/quill-docs' }, sessions: [session('ses_other', 'pi')] },
          { project: { id: 'prj_harbor', name: 'harbor', root: '/Users/me/code/harbor' }, sessions: [session('ses_ch', 'claude-code')] },
        ],
      });
    return Response.json({});
  }) as typeof fetch;
  openCompose('ses_ch');
  await until(() => inDialog('[data-compose-to="ses_ch"]') !== null, 'the agent in To');
  expect(inDialog('[data-compose-to]')!.textContent).toContain('harbor');
  expect(document.activeElement === inDialog('textarea')).toBe(true);
});

test.skipIf(!hasDom)("New message opened for a linked machine's agent (launch on here): To is that agent on that machine", async () => {
  setSelfMachine(SELF);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines: [view(SELF, 'Studio', { launch: null }), view(MAC, 'MacBook')] });
    if (path.startsWith(`/api/inbox/m/${MAC}/sessions`))
      return Response.json({ serverSession: 'm', home: '/Users/me', projects: [{ project: { id: 'prj_fern', name: 'fern-api', root: '/Users/me/code/fern-api' }, sessions: [session('ses_there', 'codex')] }], launch: HERE_LAUNCH });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], launch: HERE_LAUNCH });
    return Response.json({});
  }) as typeof fetch;
  openCompose('ses_there');
  await until(() => inDialog('[data-compose-to="ses_there"]') !== null, "the linked machine's agent in To");
  expect(inDialog('[data-compose-to]')!.textContent).toContain('fern-api');
  expect(document.activeElement === inDialog('textarea')).toBe(true);
});
