/**
 * Linked machines in the window (docs/agent-guides/inbox-machines.md), on the
 * window's own components: a row from another machine reads its machine where
 * it reads its project ("billing-svc · MacBook"); an asleep machine's rows are
 * greyed under one "MacBook asleep since …" line; the sidebar's Agents section
 * names each machine, a filter beside Projects; the list's ⋯ menu offers "Hide offline
 * machines"; Settings → Machines lists each machine with its state and
 * version, Unlink asks twice, and the link form sends a pasted link or an
 * address and six digits. With no machine linked none of it is drawn. Tags:
 * Add tag on a machine's rows only when it takes tags, sent there by name; one
 * sidebar tag per name across machines; a held tag says it waits.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxMachineTags, type InboxInitiative, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { InboxHeldError, inboxApi, type MachineView, type OutboxView } from './api';
import { machineOf, rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import { canTagThread, filterTagRows, rowTagsHere, tagWaitingCounts, tagWrite, ThreadTagsContext, type ListTag, type ThreadTagsHost } from './threadTags';
import { errorToast } from './toastError';
import type { SidebarProps } from './components/Sidebar';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { MachinesSection } = (hasDom ? await import('./components/Machines') : {}) as typeof import('./components/Machines');
const { ThreadWait } = (hasDom ? await import('./components/ThreadWait') : {}) as typeof import('./components/ThreadWait');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { machinesModel, machineProjectNames } = await import('./machines');
const { setInboxAgents } = await import('./agentsList');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const SINCE = '2026-10-30T10:42:00.000Z';

function machine(id: string, name: string, state: MachineView['state'], extra: Partial<MachineView> = {}): MachineView {
  return { id, name, self: id === SELF, state, since: SINCE, reason: null, version: '0.28.39', address: null, both_ways: true, waiting: 0, ...extra };
}

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
function row(id: string, projectId: string, owner?: string): InboxListRow {
  return {
    thread_id: id,
    project_id: projectId,
    subject: `Thread ${id}`,
    author: AGENT,
    created_at: '2026-10-30T10:00:00.000Z',
    last_at: '2026-10-30T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: projectId, name: 'billing-svc' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...(owner ? { machine: owner } : {}),
  } as InboxListRow;
}

const OWN = row('msg_own', 'prj_own');
const FAR = row('msg_far', 'prj_far', MAC);
const PROJECTS = [
  { id: 'prj_own', root: '/work/billing-svc', name: 'billing-svc' },
  { id: 'prj_far', root: '/work/billing-svc', name: 'billing-svc', machine: MAC },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
let savedFetch: typeof fetch;
const posted: { url: string; body: Record<string, unknown> }[] = [];
let unlinkTold = true;
let notices: OutboxView[] = [];

beforeEach(() => {
  if (!hasDom) return;
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  posted.length = 0;
  unlinkTold = true;
  notices = [];
  savedFetch = globalThis.fetch;
  // Settings → Machines' writes: recorded, answered as the server does.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Reads (the outbox Settings → Machines shows) are answered, not recorded.
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(url.endsWith('/outbox') ? { waiting: [], notices } : {}), { status: 200 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    posted.push({ url, body });
    if (url.endsWith('/machines/link')) {
      if (body.link === 'plannotator://link?v=1&old') return new Response(JSON.stringify({ error: 'This link code is no longer open. Make a new one on the other machine.', code: 'offer_expired' }), { status: 409 });
      return new Response(JSON.stringify({ machine: machine(MAC, 'MacBook', 'online') }), { status: 201 });
    }
    if (url.includes('/unlink')) return new Response(JSON.stringify({ unlinked: { id: MAC, name: 'MacBook' }, told: unlinkTold }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
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
  resetStorageBackend();
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

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

function list(machines: MachineView[], rows: InboxListRow[], extra: Partial<Parameters<typeof InboxList>[0]> = {}) {
  const model = machinesModel(machines);
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: rows }];
  const projects = PROJECTS.filter((p) => rows.some((r) => r.project.id === p.id));
  const projectNames = machineProjectNames({ projects, sidebar: projects, sections }, model, true);
  mount(
    <InboxList
      title="Inbox"
      path={null}
      sections={sections}
      filtered={false}
      narrow={false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      projectNames={projectNames}
      machines={model}
      tidy={{ surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} }}
      onHideAway={() => {}}
      {...extra}
    />,
  );
}

const label = (id: string) => document.querySelector(`[data-thread-id="${id}"] .ib-p`)?.textContent;

async function menuHasHideOffline(): Promise<boolean> {
  act(() => document.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  const found = document.querySelector('[data-hide-offline-machines]') !== null;
  act(() => document.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  return found;
}

test.skipIf(!hasDom)('never linked: no machine label, no away line, no greyed row, no "Hide offline machines", no machine in the sidebar', async () => {
  // A never-linked Inbox's merged list names this machine alone.
  list([machine(SELF, 'Studio', 'online')], [OWN]);
  expect(label('msg_own')).toBe('billing-svc');
  expect(document.querySelector('[data-machine-away]')).toBeNull();
  expect(document.querySelector('[data-away]')).toBeNull();
  expect(await menuHasHideOffline()).toBe(false);

  act(() => root?.unmount());
  host?.remove();
  host = null;
  mount(<Sidebar {...sidebarProps({ machines: machinesModel([machine(SELF, 'Studio', 'online')]) })} />);
  expect(document.querySelector('[data-sidebar-section="agents"]')).toBeNull();
  expect(document.querySelector('[data-machine]')).toBeNull();
  expect(document.querySelector('[data-sidebar-section="projects"]')).not.toBeNull();
});

test.skipIf(!hasDom)("another machine's row reads its machine beside its project; this machine's row with the same folder does not", () => {
  list([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online')], [OWN, FAR]);
  expect(label('msg_own')).toBe('billing-svc');
  expect(label('msg_far')).toBe('billing-svc · MacBook');
  // Online: nothing greyed, no line.
  expect(document.querySelector('[data-away]')).toBeNull();
  expect(document.querySelector('[data-machine-away]')).toBeNull();
});

test.skipIf(!hasDom)("Star is offered on another machine's row only when that machine takes stars from here; an older one's row has none", async () => {
  const OLD = `ibx_01K${'0'.repeat(22)}O`;
  const old = row('msg_old', 'prj_far', OLD);
  list([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online', { marks: ['star'] }), machine(OLD, 'Mini', 'online', { marks: [] })], [OWN, FAR, old], { pinned: new Set(['msg_far']), onRowAction: () => {} });
  const offered = async (id: string) => {
    await act(async () => {
      document.querySelector(`.ib-lbody [data-thread-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
    });
    await settle();
    const menu = document.querySelector(`[data-row-menu="${id}"]`);
    expect(menu).not.toBeNull();
    const found = ['pin', 'unpin'].filter((action) => menu!.querySelector(`[data-row-action="${action}"]`) !== null);
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    return found;
  };
  expect(await offered('msg_own')).toEqual(['pin']);
  expect(await offered('msg_far')).toEqual(['unpin']);
  expect(await offered('msg_old')).toEqual([]);
});

test.skipIf(!hasDom)("Add to Priority is offered on another machine's row only when that machine takes it from here; Remove on one in that machine's Priority", async () => {
  const OLD = `ibx_01K${'0'.repeat(22)}O`;
  const inPriority = { ...row('msg_far', 'prj_far', MAC), priority: { person: true, at: '2026-11-12T10:00:00Z', ask: null } } as InboxListRow;
  const plain = { ...row('msg_far2', 'prj_far', MAC), priority: null } as InboxListRow;
  const old = { ...row('msg_old', 'prj_far', OLD), priority: null } as InboxListRow;
  const own = { ...OWN, priority: null } as InboxListRow;
  list([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online', { marks: ['star', 'priority'] }), machine(OLD, 'Mini', 'online', { marks: ['star'] })], [own, inPriority, plain, old], { onRowAction: () => {} });
  const offered = async (id: string) => {
    await act(async () => {
      document.querySelector(`.ib-lbody [data-thread-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
    });
    await settle();
    const menu = document.querySelector(`[data-row-menu="${id}"]`);
    expect(menu).not.toBeNull();
    const found = ['priority-add', 'priority-remove'].filter((action) => menu!.querySelector(`[data-row-action="${action}"]`) !== null);
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    return found;
  };
  expect(await offered('msg_own')).toEqual(['priority-add']);
  expect(await offered('msg_far')).toEqual(['priority-remove']);
  expect(await offered('msg_far2')).toEqual(['priority-add']);
  expect(await offered('msg_old')).toEqual([]);
});

test.skipIf(!hasDom)("an asleep machine's rows are greyed under one line saying since when; the menu offers Hide offline machines", async () => {
  const hidden: boolean[] = [];
  list([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'offline')], [OWN, FAR], { onHideAway: (hide) => void hidden.push(hide) });
  const line = document.querySelector(`[data-machine-away="${MAC}"]`);
  expect(line?.textContent).toStartWith('MacBook asleep since ');
  expect(document.querySelectorAll('[data-machine-away]')).toHaveLength(1);
  expect(document.querySelector('[data-thread-id="msg_far"]')!.hasAttribute('data-away')).toBe(true);
  expect(document.querySelector('[data-thread-id="msg_own"]')!.hasAttribute('data-away')).toBe(false);

  act(() => document.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  const item = document.querySelector<HTMLElement>('[data-hide-offline-machines]');
  expect(item?.textContent).toContain('Hide offline machines');
  expect(item?.getAttribute('aria-checked')).toBe('false');
  act(() => item!.click());
  await settle();
  expect(hidden).toEqual([true]);
});

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

/** An agent running on each of the two machines: a machine's name shows in the sidebar only while agents show from more than one. */
const anAgent = (id: string) => ({ id, session: id, host: 'claude-code', project: { id: 'prj_a', name: 'web-app' }, state: 'idle' as const, waiting: 0, live: true, started_at: '2026-11-09T09:14:00.000Z', last_seen_at: '2026-11-09T09:46:00.000Z' });
const agentsOnBoth = () => act(() => setInboxAgents([{ machine: SELF, agents: [anAgent('ses_s1')], total: 1, ended_today: 0 }, { machine: MAC, agents: [anAgent('ses_m1')], total: 1, ended_today: 0 }]));

test.skipIf(!hasDom)('the word beside a machine that is behind shows only on a page that offers updates: a tailnet guest gets none, in the sidebar or on its Settings row', () => {
  const update = { phase: 'behind' as const, target: '0.28.49', from: '0.28.39', can_update: true, self_update: true };
  const list = [machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online', { update })];
  const model = machinesModel(list);
  const fresh = () => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  };
  // No agent on it: the machine is not named in the sidebar, so its word is not there either (it is in Settings).
  mount(<Sidebar {...sidebarProps({ machines: model, onMachineUpdate: noop })} />);
  expect(host!.querySelector('[data-machine]')).toBeNull();
  expect(host!.querySelector('.ib-mthing')).toBeNull();
  fresh();
  agentsOnBoth();
  mount(<Sidebar {...sidebarProps({ machines: model, onMachineUpdate: noop })} />);
  expect(host!.querySelector('.ib-mthing')?.textContent).toBe('Update');
  fresh();
  mount(<Sidebar {...sidebarProps({ machines: model })} />);
  expect(host!.querySelector('[data-machine]')).not.toBeNull();
  expect(host!.querySelector('.ib-mthing')).toBeNull();
  expect(host!.querySelector('[data-machine-notice]')).toBeNull();
  fresh();
  mount(<MachinesSection machines={list} guest={false} onChanged={noop} onMachineUpdate={noop} />);
  expect(host!.textContent).toContain('0.28.49 is out');
  fresh();
  mount(<MachinesSection machines={list} guest onChanged={noop} />);
  expect(host!.textContent).toContain('MacBook');
  expect(host!.textContent).not.toContain('0.28.49');
  expect(host!.textContent).not.toContain('is out');
});

test.skipIf(!hasDom)("the sidebar's Agents names the machines before Projects, this machine first; a machine is a filter, marked while shown; an asleep one reads quiet", () => {
  const picked: string[] = [];
  const model = machinesModel([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'offline')]);
  agentsOnBoth();
  mount(<Sidebar {...sidebarProps({ machines: model, machineCounts: new Map([[SELF, 1], [MAC, 2]]), onMachine: (id) => picked.push(id) })} />);
  const headers = [...document.querySelectorAll('[data-sidebar-section]')].map((h) => h.getAttribute('data-sidebar-section'));
  expect(headers.indexOf('agents')).toBeGreaterThanOrEqual(0);
  expect(headers.indexOf('agents')).toBeLessThan(headers.indexOf('projects'));
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-machine]')];
  expect(rows.map((r) => r.querySelector('.ib-name')!.textContent)).toEqual(['Studio', 'MacBook']);
  expect(rows[1]!.hasAttribute('data-away')).toBe(true);
  expect(rows[1]!.classList.contains('ib-proj-quiet')).toBe(true);
  expect(rows[1]!.textContent).toContain('MacBook asleep since');
  act(() => rows[1]!.click());
  expect(picked).toEqual([MAC]);

  mount(<Sidebar {...sidebarProps({ machines: model, machineId: MAC })} />);
  expect(document.querySelector(`[data-machine="${MAC}"]`)!.getAttribute('aria-current')).toBe('page');
  // Inbox is not "current" while one machine's list is shown.
  expect(document.querySelector('.ib-nav-inbox')!.getAttribute('aria-current')).toBeNull();
});

test.skipIf(!hasDom)('Settings → Machines: each machine with its state and version; Unlink asks twice, then unlinks', async () => {
  let changed = 0;
  mount(
    <MachinesSection
      machines={[machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'offline', { waiting: 1 }), machine(`ibx_01K${'0'.repeat(22)}N`, 'Mini', 'needs_update', { version: '0.28.30' })]}
      guest={false}
      onChanged={() => changed++}
    />,
  );
  const rows = [...document.querySelectorAll('[data-machine-row]')];
  expect(rows).toHaveLength(2);
  const desc = rows.map((r) => r.querySelector('.ib-desc')!.textContent);
  expect(desc[0]).toStartWith('Asleep · last seen ');
  expect(desc[0]).toEndWith('· Plannotator 0.28.39 · 1 waiting to send');
  expect(desc[1]).toBe('Needs update · runs 0.28.30');

  // MacBook holds an answer: the confirm says it will be lost before the second click. Mini holds none: no warning.
  const unlink = rows[0]!.querySelector<HTMLButtonElement>('.ib-del-l')!;
  expect(unlink.textContent).toBe('Unlink');
  expect(unlink.getAttribute('aria-label')).toBe('Unlink MacBook');
  act(() => unlink.click());
  expect(unlink.textContent).toBe('Unlink? 1 waiting to send will be lost. Click again');
  expect(unlink.getAttribute('aria-label')).toBe('Unlink MacBook: 1 waiting to send will be lost. Click again to unlink');
  const unlinkMini = rows[1]!.querySelector<HTMLButtonElement>('.ib-del-l')!;
  act(() => unlinkMini.click());
  expect(unlinkMini.textContent).toBe('Unlink? Click again');
  expect(unlinkMini.getAttribute('aria-label')).toBe('Unlink Mini: click again to unlink');
  // No door error while this machine is on the tailnet.
  expect(document.querySelector('[data-machines-door-error]')).toBeNull();
  expect(posted).toHaveLength(0);
  // MacBook asleep could not be told: the section says it drops the link at its next contact.
  unlinkTold = false;
  act(() => unlink.click());
  await settle();
  expect(posted.map((p) => p.url)).toEqual([`/api/inbox/machines/${MAC}/unlink`]);
  expect(changed).toBe(1);
  expect(document.querySelector('[data-machine-unlinked]')!.textContent).toContain('MacBook could not be reached, so it drops the link the next time it is in touch');
});

test.skipIf(!hasDom)("Settings → Machines says why this machine is not on the tailnet when its door's port is held, as an alert", () => {
  const reason = 'Another tailscale serve mapping now uses port 8444, where linked machines reach this Inbox.';
  mount(<MachinesSection machines={[machine(SELF, 'Studio', 'online', { reason }), machine(MAC, 'MacBook', 'offline')]} guest={false} onChanged={noop} />);
  const alert = document.querySelector('[data-machines-door-error]')!;
  expect(alert.getAttribute('role')).toBe('alert');
  expect(alert.textContent).toContain(reason);
  expect(alert.textContent).toContain('linked machines cannot reach it');
});

test.skipIf(!hasDom)("a thread that cannot open because its machine sleeps still shows the person's held answer, waiting, never delivered", () => {
  const held: OutboxView = {
    key: 'k1',
    machine: MAC,
    route: 'messages/msg_far/reply',
    state: 'queued',
    queued_at: SINCE,
    settled_at: null,
    status: null,
    answer: null,
    notice: null,
    dismissed: false,
    words: 'Ship the ledger fix',
    thread: 'msg_far',
  };
  mount(
    <ThreadWait
      load={{ state: 'failed', error: 'machine_offline' }}
      onRetry={noop}
      onClose={noop}
      onFocusLeaving={noop}
      away="MacBook asleep since 10:42 AM. The thread opens when it is back."
      held={{ entries: [held], machine: machine(MAC, 'MacBook', 'offline') }}
    />,
  );
  expect(document.querySelector('[data-thread-wait-away]')).not.toBeNull();
  const shown = document.querySelector('[data-thread-wait-held] [data-outbox="k1"]')!;
  expect(shown.querySelector('.ib-held-words')!.textContent).toBe('Ship the ledger fix');
  expect(shown.querySelector('[data-outbox-line]')!.textContent).toBe('Will send when MacBook is back');
});

test.skipIf(!hasDom)('Settings → Machines keeps what was not sent to a machine no longer linked: its words to copy, until dismissed', async () => {
  const MINI = `ibx_01K${'0'.repeat(22)}N`;
  const dropped = (key: string, owner: string, words: string | null, name: string | null): OutboxView => ({
    key,
    machine: owner,
    route: words ? 'messages/msg_far/reply' : 'threads/msg_far/read',
    state: 'dropped',
    queued_at: SINCE,
    settled_at: SINCE,
    status: null,
    answer: null,
    notice: { kind: 'not_delivered', at: SINCE },
    dismissed: false,
    words,
    thread: 'msg_far',
    machine_name: name,
  });
  // Mini unlinked this computer while two writes waited for it; MacBook is still linked (its notice shows in its thread).
  notices = [dropped('k-mini', MINI, 'Rotate the certs Thursday.', 'Mini'), dropped('k-read', MINI, null, 'Mini'), dropped('k-mac', MAC, 'Keep the order.', null)];
  mount(<MachinesSection machines={[machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online')]} guest={false} onChanged={noop} />);
  await settle();
  const rows = [...document.querySelectorAll('[data-machines-unsent] [data-unsent]')];
  expect(rows.map((r) => r.getAttribute('data-unsent'))).toEqual(['k-mini', 'k-read']);
  expect(rows[0]!.querySelector('.ib-l')!.textContent).toStartWith('Not sent to Mini');
  expect(rows[0]!.querySelector('.ib-held-words')!.textContent).toBe('Rotate the certs Thursday.');
  expect(rows[0]!.querySelector('.ib-copy')).not.toBeNull();
  act(() => rows[0]!.querySelector<HTMLButtonElement>('[data-unsent-dismiss]')!.click());
  await settle();
  expect(posted.map((p) => p.url)).toEqual(['/api/inbox/outbox/k-mini/dismiss']);
  expect([...document.querySelectorAll('[data-unsent]')].map((r) => r.getAttribute('data-unsent'))).toEqual(['k-read']);
});

test.skipIf(!hasDom)('a thread two linked machines both claim says so in its place, with Close and no "Try again"', () => {
  mount(<ThreadWait load={{ state: 'refused', error: 'Two linked machines both claim this thread, so it opens on neither.' }} onRetry={noop} onClose={noop} onFocusLeaving={noop} />);
  expect(document.querySelector('[data-thread-wait-refused]')!.textContent).toBe('Two linked machines both claim this thread, so it opens on neither.');
  expect(document.querySelector('[data-thread-wait-close]')).not.toBeNull();
  expect(document.querySelector('[data-thread-wait-retry]')).toBeNull();
});

test.skipIf(!hasDom)("a 404 while a linked machine's list is not in yet says what it waits for, never the read's error", () => {
  mount(<ThreadWait load={{ state: 'failed', error: 'No thread msg_x.', waiting: 'Waiting for MacBook: this thread may be there.' }} onRetry={noop} onClose={noop} onFocusLeaving={noop} />);
  expect(document.querySelector('[data-thread-wait-unlisted]')!.textContent).toBe('Waiting for MacBook: this thread may be there.');
  expect(document.querySelector('[data-thread-wait]')!.textContent).not.toContain('No thread');
  expect(document.querySelector('[data-thread-wait-close]')).not.toBeNull();
});

test.skipIf(!hasDom)('"Show link code" says, before the click, that it puts this Inbox on the tailnet', () => {
  mount(<MachinesSection machines={[machine(SELF, 'Studio', 'online')]} guest={false} onChanged={noop} />);
  expect(document.querySelector('[data-machine-offer-row] .ib-desc')!.textContent).toContain('puts this Inbox on your tailnet');
});

test.skipIf(!hasDom)('linking: a pasted link, or an address and six digits; only the Link button sends; a refusal is said', async () => {
  let changed = 0;
  mount(<MachinesSection machines={[machine(SELF, 'Studio', 'online')]} guest={false} onChanged={() => changed++} />);
  expect(document.querySelector('[data-machine-start] .ib-l')!.textContent).toBe('No machine linked yet');
  act(() => document.querySelector<HTMLButtonElement>('[data-machine-link]')!.click());
  const form = document.querySelector('[data-machine-link-form]')!;
  const type = (selector: string, value: string) => {
    const input = form.querySelector<HTMLInputElement>(selector)!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = () => form.querySelector<HTMLButtonElement>('[data-machine-link-submit]')!;
  // Nothing typed: Link does nothing.
  expect(submit().getAttribute('aria-disabled')).toBe('true');
  act(() => submit().click());
  await settle();
  expect(posted).toHaveLength(0);

  // A stale code: the server's reason is shown, and nothing changed.
  type('[data-machine-link-code]', 'plannotator://link?v=1&old');
  act(() => submit().click());
  await settle();
  expect(document.querySelector('[data-machine-link-error]')!.textContent).toContain('no longer open');
  expect(changed).toBe(0);

  // Address and six digits (the paste cleared): those two go, and the section reads the machines again.
  type('[data-machine-link-code]', '');
  type('[data-machine-link-address]', 'mac.tail1234.ts.net:8443');
  type('[data-machine-link-digits]', '12a3456');
  act(() => submit().click());
  await settle();
  expect(posted.at(-1)).toEqual({ url: '/api/inbox/machines/link', body: expect.objectContaining({ address: 'mac.tail1234.ts.net:8443', code: '123456' }) });
  expect(posted.at(-1)!.body.link).toBeUndefined();
  expect(changed).toBe(1);
  expect(document.querySelector('[data-machine-linked]')!.textContent).toContain('Linked with MacBook');
});

test.skipIf(!hasDom)("a tailnet guest's page: no Unlink, the buttons are disabled, and it says why; the owner's page links as on the computer", () => {
  const machines = [machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online')];
  mount(<MachinesSection machines={machines} guest onChanged={noop} />);
  expect(document.querySelector('[data-machines-remote]')).not.toBeNull();
  expect(document.querySelector('[data-machine-row] .ib-del-l')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-machine-link]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[data-machine-offer-start]')!.disabled).toBe(true);
  // The owner over the tailnet is not a guest: the same section as on the computer.
  mount(<MachinesSection machines={machines} guest={false} onChanged={noop} />);
  expect(document.querySelector('[data-machines-remote]')).toBeNull();
  expect(document.querySelector('[data-machine-row] .ib-del-l')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-machine-link]')!.disabled).toBe(false);
});

test.skipIf(!hasDom)('a link code asked for on a dropped connection says the Inbox did not answer, never the browser’s own words', async () => {
  const { linkErrorText } = await import('./components/Machines');
  const { INBOX_UNREACHABLE } = await import('./toastError');
  for (const words of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) expect(linkErrorText(new TypeError(words))).toBe(INBOX_UNREACHABLE);
});

// ── Tags across machines (approval "inbox-thread-tags"): one tag per name, a thread's tag on its own machine. ──

const tagRecord = (id: string, name: string): InboxInitiative => ({ id, name, created_at: '2026-11-12T09:00:00.000Z', created_by: { kind: 'person' }, updated_at: '2026-11-12T09:00:00.000Z', deleted_at: null });
const OLD = `ibx_01K${'0'.repeat(22)}O`;

/** The list inside a tags host built as App builds it: the real rules (canTagThread, rowTagsHere, tagWrite) and the real write. */
function taggedList(machines: MachineView[], rows: InboxListRow[], tags: ListTag[]) {
  const model = machinesModel(machines);
  for (const row of rows) if (row.machine) rememberMachine([row.thread_id], row.machine);
  const host: ThreadTagsHost = {
    tags,
    tagsOf: (id) => rowTagsHere(rows.find((r) => r.thread_id === id)!, model, new Map()),
    counts: new Map(),
    can: (id) => canTagThread(id, rows, model, machineOf(id)),
    set: (id, tag, on) => void inboxApi.setThreadTag(id, tagWrite(tag, machineOf(id), model.self), on).catch(() => {}),
    createAndSet: () => {},
    listed: null,
  };
  mount(<ThreadTagsContext.Provider value={host}>{rowsList(machines, rows)}</ThreadTagsContext.Provider>);
}
function rowsList(machines: MachineView[], rows: InboxListRow[]) {
  const model = machinesModel(machines);
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: rows }];
  const projects = PROJECTS.filter((p) => rows.some((r) => r.project.id === p.id));
  return (
    <InboxList
      title="Inbox"
      path={null}
      sections={sections}
      filtered={false}
      narrow={false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      projectNames={machineProjectNames({ projects, sidebar: projects, sections }, model, true)}
      machines={model}
      tidy={{ surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} }}
      onHideAway={() => {}}
      onRowAction={() => {}}
    />
  );
}
async function rowMenu(id: string) {
  await act(async () => {
    document.querySelector(`.ib-lbody [data-thread-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
  await settle();
  return document.querySelector<HTMLElement>(`[data-row-menu="${id}"]`);
}
async function closeMenu() {
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
}

test.skipIf(!hasDom)("Add tag is offered on another machine's row only when that machine takes tags from here; a tick there tags it on that machine, by name", async () => {
  setSelfMachine(SELF);
  try {
    const old = row('msg_old', 'prj_far', OLD);
    const release = { ...tagRecord('ini_s_rel', 'Release'), machines: { [SELF]: 'ini_s_rel' } };
    taggedList([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online', { marks: ['star', 'priority', 'tags'] }), machine(OLD, 'Mini', 'online', { marks: ['star', 'priority'] })], [OWN, FAR, old], [release]);
    for (const [id, offered] of [['msg_own', true], ['msg_old', false], ['msg_far', true]] as const) {
      const menu = await rowMenu(id);
      expect(menu).not.toBeNull();
      expect(menu!.querySelector('[data-add-tag-item]') !== null).toBe(offered);
      if (id !== 'msg_far') await closeMenu();
    }
    // The far row's list shows this Inbox's tags; a tick goes to MacBook, naming the tag (MacBook makes it there).
    await act(async () => document.querySelector<HTMLElement>('[data-add-tag-item]')!.click());
    await settle();
    expect(document.querySelector(`[data-tag-pick="${release.id}"]`)?.textContent).toContain('Release');
    posted.length = 0;
    await act(async () => document.querySelector<HTMLElement>(`[data-tag-pick="${release.id}"]`)!.click());
    await settle();
    expect(posted).toEqual([{ url: `/api/inbox/m/${MAC}/threads/msg_far/tags`, body: expect.objectContaining({ name: 'Release', on: true }) }]);
    await closeMenu();
    // This Inbox's own thread names this Inbox's id.
    posted.length = 0;
    await rowMenu('msg_own');
    await act(async () => document.querySelector<HTMLElement>('[data-add-tag-item]')!.click());
    await settle();
    await act(async () => document.querySelector<HTMLElement>(`[data-tag-pick="${release.id}"]`)!.click());
    await settle();
    expect(posted).toEqual([{ url: '/api/inbox/threads/msg_own/tags', body: expect.objectContaining({ tag: release.id, on: true }) }]);
  } finally {
    resetMachineRoutes();
  }
});

test.skipIf(!hasDom)('a tag of the same name on two machines is ONE sidebar tag: its list holds both machines’ threads and its count includes them; an older machine’s tagged row stays out', async () => {
  const merged = inboxMachineTags(SELF, [tagRecord('ini_s_rel', 'Release')], [{ machine: MAC, tags: [tagRecord('ini_m_rel', 'release'), tagRecord('ini_m_bill', 'Billing')] }]);
  expect(merged.tags.map((t) => t.name)).toEqual(['Release', 'Billing']);
  const model = machinesModel([machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'online', { marks: ['tags'] }), machine(OLD, 'Mini', 'online', { marks: [] })]);
  // As the merged list sends them: a far row's tags read as the merged ids. (An older machine's row arrives with none;
  // one that still carried a tag id stays out here too.)
  const rows = [
    { ...OWN, tags: [merged.idOn(SELF, 'ini_s_rel')!] },
    { ...FAR, tags: [merged.idOn(MAC, 'ini_m_rel')!] },
    { ...row('msg_far2', 'prj_far', MAC), tags: [merged.idOn(MAC, 'ini_m_bill')!] },
    { ...row('msg_old', 'prj_far', OLD), tags: ['ini_s_rel'] },
  ] as InboxListRow[];
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: rows }];
  const tagsOf = (r: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(r, model, new Map());
  expect(filterTagRows(sections, 'ini_s_rel', tagsOf)[0]!.threads.map((r) => r.thread_id)).toEqual(['msg_own', 'msg_far']);
  const waiting = tagWaitingCounts(sections, tagsOf);
  expect(waiting.get('ini_s_rel')).toBe(2);
  expect(waiting.get('ini_m_bill')).toBe(1);
  mount(<Sidebar {...sidebarProps({ machines: model, tags: { tags: merged.tags, waiting, shown: true, tagId: null, onOpen: noop, onCreate: async () => null, onRename: async () => true, onDelete: noop } })} />);
  const names = [...document.querySelectorAll('[data-tag-row]')].map((el) => el.getAttribute('data-tag-row'));
  expect(names).toEqual(['ini_s_rel', 'ini_m_bill']);
  expect(document.querySelector('[data-tag-row="ini_s_rel"]')!.textContent).toContain('2');
});

test.skipIf(!hasDom)('a tag for an asleep machine’s thread waits there and says so, as Priority’s does; nothing is drawn as done', async () => {
  setSelfMachine(SELF);
  rememberMachine(['msg_far'], MAC);
  const before = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ outbox: { key: 'k1', machine: MAC, route: 'threads/msg_far/tags', state: 'queued', queued_at: '2026-11-13T09:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, words: null, thread: 'msg_far', machine_name: null }, machine: machine(MAC, 'MacBook', 'offline') }, { status: 202 });
  }) as typeof fetch;
  try {
    const held = await inboxApi.setThreadTag('msg_far', { name: 'Release' }, true).then(() => null, (cause: unknown) => cause);
    expect(urls).toEqual([`/api/inbox/m/${MAC}/threads/msg_far/tags`]);
    expect(held).toBeInstanceOf(InboxHeldError);
    expect(errorToast(held, 'x')).toEqual({ icon: 'clock', lead: 'Waiting for MacBook: this applies when MacBook is back.', wrap: true });
  } finally {
    globalThis.fetch = before;
    resetMachineRoutes();
  }
});
