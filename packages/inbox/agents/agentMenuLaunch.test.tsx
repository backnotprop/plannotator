/**
 * Stop and Delete … session… on a sidebar agent's menu (⋯, right-click, the phone's sheet), as the launch's thread
 * offers them (Thread.tsx `launchMenu`, the rule in core `inboxLaunchStops`).
 *
 * What this catches: Stop or Delete offered for an agent the Inbox did not launch, Stop offered for a launch that is
 * stopped, waits on a prompt in the window or never started, the items out of order or without their separator, a
 * linked machine's launched agent losing Stop and Delete (or gaining Rename…, which its machine would not keep), the
 * wrong machine handed to the action. Delete's dialog (AgentDeleteDialog): its words and box, Cancel, Escape and a
 * click outside deleting anything, focus not on Cancel; the delete (agentDelete.ts) archiving threads without the
 * tick, missing one with it, or sending a linked machine's Delete or Archive to this Inbox.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxListRow, InboxRunState } from '@plannotator/core/inbox-types';
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
const { AgentDeleteDialog } = (hasDom ? await import('./AgentDeleteDialog') : {}) as typeof import('./AgentDeleteDialog');
const { agentDeleteThreads, deleteAgentSession } = await import('./agentDelete');
const { rememberMachine, resetMachineRoutes, setSelfMachine } = await import('../inboxUrl');
const { machinesModel } = await import('../machines');

let root: Root | null = null;
let realFetch: typeof fetch;
let stopped: [string, string | null][] = [];
let deleted: [string, string | null][] = [];

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ faces: {}, rev: 0 })) as unknown as typeof fetch;
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
  resetMachineRoutes();
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
  globalThis.fetch = (async () => Response.json({ faces: { lch_a: { face: 'agent', sessions: ['ses_lch_a'], name: 'Retry worker' } }, rev: 1 })) as unknown as typeof fetch;
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

/** Draw the dialog; what its Cancel and Delete were called with. */
function dialog(props: { host?: string; scratch?: string | null; threads: number }) {
  const said = { cancel: 0, delete: [] as boolean[] };
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentDeleteDialog host={props.host ?? 'claude-code'} scratch={props.scratch ?? null} threads={props.threads} onCancel={() => said.cancel++} onDelete={(archive) => said.delete.push(archive)} />,
    ),
  );
  const el = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="agent-delete"]')!;
  const words = () => `${el().querySelector('h2')!.textContent} | ${el().querySelector('.ib-sum')!.textContent}`;
  return { said, el, words };
}

test.skipIf(!hasDom)("Delete's dialog: the thread's words, its threads stay unless the box is ticked, focus on Cancel", async () => {
  const { said, el, words } = dialog({ threads: 3 });
  await settle();
  expect(words()).toBe('Delete the Claude Code session? | It stops, and its session files are removed. Its threads stay.');
  expect(document.activeElement?.hasAttribute('data-agent-delete-cancel')).toBe(true);
  const box = el().querySelector<HTMLInputElement>('[data-agent-delete-archive] input')!;
  expect(el().querySelector('[data-agent-delete-archive]')!.textContent).toBe('Also archive its 3 threads');
  expect(box.checked).toBe(false);
  expect(el().querySelector('[data-agent-delete-go]')!.className).toContain('ib-danger');
  await press(el().querySelector('[data-agent-delete-go]')!);
  expect(said.delete).toEqual([false]);
  await press(box);
  expect(words()).toBe('Delete the Claude Code session? | It stops, and its session files are removed.');
  await press(el().querySelector('[data-agent-delete-go]')!);
  expect(said.delete).toEqual([false, true]);
  expect(said.cancel).toBe(0);
});

test.skipIf(!hasDom)('Cancel, Escape and a click outside cancel, and delete nothing', async () => {
  const { said, el } = dialog({ threads: 2 });
  await settle();
  await press(el().querySelector('[data-agent-delete-cancel]')!);
  await act(async () => el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  // Outside the box: the click lands on the dialog element itself (its backdrop).
  await act(async () => el().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(said.cancel).toBe(3);
  expect(said.delete).toEqual([]);
});

test.skipIf(!hasDom)("one thread, a scratch folder: the thread confirm's scratch words, the box in the singular; none: no box", async () => {
  const one = dialog({ host: 'pi', scratch: 'palette-helper', threads: 1 });
  await settle();
  expect(one.words()).toBe('Delete the Pi session? | It stops, and its session files and its scratch folder palette-helper, with everything in it, are removed. Its thread stays.');
  expect(one.el().querySelector('[data-agent-delete-archive]')!.textContent).toBe('Also archive its thread');
  act(() => root?.unmount());
  document.body.innerHTML = '';
  const none = dialog({ threads: 0 });
  await settle();
  expect(none.words()).toBe('Delete the Claude Code session? | It stops, and its session files are removed.');
  expect(none.el().querySelector('[data-agent-delete-archive]')).toBeNull();
});

/** Every request the delete makes: method, path and body (a linked machine's write key left out). */
function recordFetch(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { idempotency_key: _key, ...body } = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push(`${init?.method ?? 'GET'} ${String(input)} ${JSON.stringify(body)}`);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return calls;
}

test.skipIf(!hasDom)('the delete: without the tick, the launch only; with it, then each thread archived as a row\'s Archive is', async () => {
  let calls = recordFetch();
  expect(await deleteAgentSession('lch_a', null, ['msg_a', 'msg_b'], false)).toEqual({ scratchKept: false, archived: [], archiveError: null });
  expect(calls).toEqual(['POST /api/inbox/launch/lch_a/delete {}']);
  calls = recordFetch();
  expect((await deleteAgentSession('lch_a', null, ['msg_a', 'msg_b'], true)).archived).toEqual(['msg_a', 'msg_b']);
  expect(calls).toEqual(['POST /api/inbox/launch/lch_a/delete {}', 'POST /api/inbox/messages/msg_a/resolve {"resolved":true}', 'POST /api/inbox/messages/msg_b/resolve {"resolved":true}']);
});

test.skipIf(!hasDom)("a linked machine's agent: its Delete and its threads' Archive go to that machine, and its threads are its machine's only", async () => {
  setSelfMachine(SELF);
  rememberMachine(['msg_there'], MAC);
  const calls = recordFetch();
  await deleteAgentSession('lch_there', MAC, ['msg_there'], true);
  expect(calls).toEqual([`POST /api/inbox/m/${MAC}/launch/lch_there/delete {}`, `POST /api/inbox/m/${MAC}/messages/msg_there/resolve {"resolved":true}`]);

  const machines = machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook')]);
  const there = launched('lch_there', null);
  const groups = [group([launched('lch_here', null)], SELF), group([there], MAC)];
  const row = (id: string, session: string, machine: string): InboxListRow =>
    ({ thread_id: id, subject: id, thread_name: null, author: { kind: 'agent', host: 'claude-code', session, name: null }, last_at: '2026-11-09T09:00:00.000Z', waiting_on_person: false, machine }) as InboxListRow;
  // The launch's thread, one it wrote since, and a thread on this Inbox by a session of the same id: only the first two.
  const rows = [row('msg_lch_there', 'ses_lch_there', MAC), row('msg_later', 'ses_lch_there', MAC), row('msg_same_id_here', 'ses_lch_there', SELF)];
  expect(agentDeleteThreads(there, groups, machines, rows).map((r) => r.thread_id)).toEqual(['msg_lch_there', 'msg_later']);
});
