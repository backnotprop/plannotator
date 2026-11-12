/**
 * Stop and Delete … session… on a sidebar agent's menu (⋯, right-click, the phone's sheet), as the launch's thread
 * offers them (Thread.tsx `launchMenu`, the rule in core `inboxLaunchStops`).
 *
 * What this catches: Stop or Delete offered for an agent the Inbox did not launch, Stop offered for a launch that is
 * stopped, waits on a prompt in the window or never started, the items out of order or without their separator, a
 * linked machine's launched agent losing Stop and Delete (or gaining Rename…, which its machine would never keep), the
 * wrong machine handed to the action, and the sidebar's Delete not opening the thread's own confirm.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxAuthor, InboxMessageWire, InboxProject, InboxRun, InboxRunState, InboxThread } from '@plannotator/core/inbox-types';
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
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { machinesModel } = await import('../machines');

let root: Root | null = null;
let realFetch: typeof fetch;
let stopped: [string, string | null][] = [];
let deleted: [string, string | null][] = [];

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ faces: {}, rev: 0 })) as typeof fetch;
  stopped = [];
  deleted = [];
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
});

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const view = (id: string, name: string): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true }) as MachineView;

const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_bill', name: 'billing-svc' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const launched = (id: string, run: InboxRunState | null, started = true, over: Partial<InboxAgent> = {}): InboxAgent =>
  agent(id, { session: started ? `ses_${id}` : `launch:${id}`, launch: { id, thread_id: `msg_${id}`, started, run }, ...over });
const group = (agents: InboxAgent[], machine?: string): InboxAgentsGroup => ({ agents, total: agents.length, ended_today: 0, ...(machine ? { machine } : {}) });

function mount(groups: InboxAgentsGroup[], options: { phone?: boolean; linked?: boolean } = {}) {
  setInboxAgents(groups);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentsSection
        machines={options.linked ? machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook')]) : machinesModel([])}
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
        onMessageAgent={() => {}}
        onAddAgent={() => {}}
        pick={(go) => go}
        phone={options.phone === true}
        onRename={async () => true}
        onStop={(a, machine) => stopped.push([a.id, machine])}
        onDelete={(a, machine) => deleted.push([a.id, machine])}
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

/** The open menu's items and separators, top to bottom: each item's words, a separator as "—". */
const menu = () =>
  [...document.querySelectorAll('[data-agent-menu] [role="menuitem"], [data-agent-menu] [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '—' : el.textContent?.trim()));

async function itemsOf(id: string): Promise<string[] | null> {
  const more = row(id)?.querySelector('[data-agent-more]');
  if (!more) return null;
  await press(more);
  const items = menu() as string[];
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  return items;
}

test.skipIf(!hasDom)('this Inbox: a running launch has Rename…, a separator, Stop and Delete; a stopped or unstarted one Delete only; an agent it did not launch Rename… only', async () => {
  mount([
    group([
      launched('lch_rest', null),
      launched('lch_work', 'working'),
      launched('lch_term', 'waiting_terminal'),
      launched('lch_stop', 'stopped'),
      launched('lch_card', 'waiting_answer'),
      launched('lch_new', 'starting', false),
      agent('ses_own'),
    ]),
  ]);
  await settle();
  const full = ['Rename…', '—', 'Stop Claude Code', 'Delete Claude Code session…'];
  expect(await itemsOf('lch_rest')).toEqual(full);
  expect(await itemsOf('lch_work')).toEqual(full);
  expect(await itemsOf('lch_term')).toEqual(full);
  expect(await itemsOf('lch_stop')).toEqual(['Rename…', '—', 'Delete Claude Code session…']);
  expect(await itemsOf('lch_card')).toEqual(['Rename…', '—', 'Delete Claude Code session…']);
  expect(await itemsOf('lch_new')).toEqual(['Rename…', '—', 'Delete Claude Code session…']);
  expect(await itemsOf('ses_own')).toEqual(['Rename…']);
});

test.skipIf(!hasDom)('a named launch: Rename…, Reset name, then Stop and Delete; each calls its action for this Inbox (no machine)', async () => {
  // The Inbox keeps the name with the agent's face (agents/agentFaces.ts).
  globalThis.fetch = (async () => Response.json({ faces: { lch_a: { face: 'agent', sessions: ['ses_lch_a'], name: 'Retry worker' } }, rev: 1 })) as typeof fetch;
  await faces.readAgentFaces();
  mount([group([launched('lch_a', 'working', true, { host: 'pi' })])]);
  await settle();
  expect(await itemsOf('lch_a')).toEqual(['Rename…', 'Reset name', '—', 'Stop Pi', 'Delete Pi session…']);
  await press(row('lch_a')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="stop"]')!);
  await press(row('lch_a')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="delete"]')!);
  expect(stopped).toEqual([['lch_a', null]]);
  expect(deleted).toEqual([['lch_a', null]]);
});

test.skipIf(!hasDom)("a linked machine's launch: Stop and Delete for that machine, no Rename…; its agent the Inbox did not launch has no menu", async () => {
  mount([group([launched('lch_here', 'working')], SELF), group([launched('lch_there', 'working'), agent('ses_there', { host: 'codex' })], MAC)], { linked: true });
  await settle();
  expect(await itemsOf('lch_here')).toEqual(['Rename…', '—', 'Stop Claude Code', 'Delete Claude Code session…']);
  expect(await itemsOf('lch_there')).toEqual(['Stop Claude Code', 'Delete Claude Code session…']);
  expect(row('ses_there')!.querySelector('[data-agent-more]')).toBeNull();
  await press(row('lch_there')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="stop"]')!);
  await press(row('lch_there')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="delete"]')!);
  await press(row('lch_here')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="stop"]')!);
  expect(stopped).toEqual([
    ['lch_there', MAC],
    ['lch_here', null],
  ]);
  expect(deleted).toEqual([['lch_there', MAC]]);
});

test.skipIf(!hasDom)("a right-click opens the same items; an ended launch has no row", async () => {
  mount([group([launched('lch_a', 'working'), launched('lch_gone', 'failed', true, { state: 'ended', live: false })])]);
  await settle();
  expect(row('lch_gone')).toBeNull();
  await act(async () => {
    row('lch_a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
  });
  await settle();
  expect(menu()).toEqual(['Rename…', '—', 'Stop Claude Code', 'Delete Claude Code session…']);
});

test.skipIf(!hasDom)("a phone: the sheet has the same items, over the sheet's scrim", async () => {
  mount([group([launched('lch_a', null)])], { phone: true });
  await settle();
  await press(row('lch_a')!.querySelector('[data-agent-more]')!);
  expect(menu()).toEqual(['Rename…', '—', 'Stop Claude Code', 'Delete Claude Code session…']);
  expect(document.querySelector('.ib-pm-pos[data-phone] [data-agent-menu]')).not.toBeNull();
  expect(document.querySelector('.ib-pm-scrim')).not.toBeNull();
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'app-abcdef', name: 'app', root: '/work/app', created_at: '2026-10-20T09:00:00.000Z' };
const LAUNCHED: InboxThread = {
  thread_id: 'msg_L1',
  project: PROJECT,
  subject: 'Fix the build',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: 'msg_L1',
      project_id: PROJECT.id,
      thread_id: 'msg_L1',
      reply_to: null,
      author: { kind: 'person' } as InboxAuthor,
      to: { host: 'claude-code', session: 'sess-a' },
      subject: 'Fix the build',
      subject_question: null,
      body: 'Fix the build.',
      created_at: '2026-10-20T18:10:00.000Z',
      resolved_at: null,
      idempotency_key: 'k-a',
      launch: { id: 'lch_a', agent: 'claude-code', session_ref: 'sa', folder: '/work/app', scratch: false, started_at: '2026-10-20T18:10:00.000Z' },
    } as InboxMessageWire,
  ],
};

test.skipIf(!hasDom)("the sidebar's Delete opens the thread's own confirm once its launch is read, and says it was asked", async () => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  let asked = 0;
  const draw = (run: InboxRun | null | undefined) =>
    act(() =>
      root!.render(
        <ThreadPane
          thread={LAUNCHED}
          sent={null}
          onQuestions={() => {}}
          onChanged={async () => {}}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
          run={run}
          deleteAsk
          onDeleteAsked={() => asked++}
        />,
      ),
    );
  // The run not read yet: no launch menu, so nothing is asked.
  draw(undefined);
  await settle();
  expect(host.querySelector('[data-launch-confirm]')).toBeNull();
  expect(asked).toBe(0);
  draw(null);
  await settle();
  const confirm = host.querySelector('[data-launch-confirm]');
  expect(confirm?.querySelector('b')?.textContent).toBe('Delete the Claude Code session?');
  expect(confirm?.textContent).toContain('It stops, and its session files are removed. This thread stays.');
  expect(asked).toBe(1);
});
