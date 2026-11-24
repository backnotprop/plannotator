/**
 * Grid in the window (approval "inbox-agent-grid"; experimental, off by default). What regresses:
 * - a trace of Grid while its switch is off (no row in the sidebar, no read, a `#grid` address goes to the Inbox);
 * - the row under Inbox while on, and the page's groups, counts and the question under a name;
 * - a linked computer's thread missing from the page, or named without its computer in the readout;
 * - its PRs read more than once each, or a thread with no PR read at all (no second poller: the thread-PR read only);
 * - a click that does not open the thread; on a phone, a tap that does not open the readout with Open thread.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { GridRoute } = (hasDom ? await import('./GridPage') : {}) as typeof import('./GridPage');
const { forgetGridPulls } = (hasDom ? await import('./gridPulls') : {}) as typeof import('./gridPulls');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { putList } = (hasDom ? await import('../data/queries/list') : {}) as typeof import('../data/queries/list');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { QueryClient, QueryClientProvider } = (hasDom ? await import('@tanstack/react-query') : {}) as typeof import('@tanstack/react-query');

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
  if (hasDom) {
    forgetGridPulls();
    setInboxAgents([]);
  }
});

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SELF = 'ibx_macbook';
const MINI = 'ibx_macmini';

function row(over: Partial<InboxListRow> & { thread_id: string }): InboxListRow {
  return {
    project_id: 'prj_harbor',
    project: { id: 'prj_harbor', name: 'harbor' },
    subject: null,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_ops', name: null },
    created_at: ago(120),
    last_at: ago(4),
    last_agent_at: ago(4),
    last_author: 'agent',
    message_count: 3,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    section: 'sent',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: { at: ago(6), checked_at: ago(5) },
    guide: false,
    ...over,
  } as InboxListRow;
}

const agents: InboxAgentsGroup[] = [
  { machine: SELF, total: 1, ended_today: 0, agents: [{ id: 'ses_ops', session: 'ses_ops', host: 'claude-code', label: 'harbor ops', project: { id: 'prj_harbor', name: 'harbor' }, state: 'working', waiting: 0, live: true, started_at: ago(200), last_seen_at: ago(1) }] },
  { machine: MINI, total: 1, ended_today: 0, agents: [{ id: 'ses_ledger', session: 'ses_ledger', host: 'claude-code', label: 'ledger', project: { id: 'prj_ledger', name: 'ledger' }, state: 'idle', waiting: 0, live: true, started_at: ago(300), last_seen_at: ago(2) }] },
];

const rows = [
  row({ thread_id: 'msg_page', thread_name: 'Pagination cursors', section: 'stopped', waiting_since: ago(32), questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: 'Keep the old page param?' }, sent: null }),
  row({ thread_id: 'msg_rate', thread_name: 'Rate limit the export', pulls: { count: 1, headline: { key: 'github.com/ada/harbor#418', state: 'open' } } }),
  row({ thread_id: 'msg_push', thread_name: 'Push notification settings', machine: MINI, author: { kind: 'agent', host: 'claude-code', session: 'ses_ledger', name: null }, project: { id: 'prj_ledger', name: 'ledger' } }),
  // The talk is done: answered, nothing asked, no PR. Not on the page.
  row({ thread_id: 'msg_chat', thread_name: 'What is a monad', section: 'quiet', sent: null }),
];

function mount(options: { on: boolean; phone?: boolean; opened?: string[] }) {
  const client = new QueryClient();
  putList(client, {
    sections: [{ id: 'sent', label: 'Sent', threads: rows }],
    machines: [
      { id: SELF, name: 'MacBook', self: true, state: 'online', since: null },
      { id: MINI, name: 'Mac mini', self: false, state: 'online', since: null },
    ],
    self: SELF,
  } as never);
  setInboxAgents(agents);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <GridRoute on={options.on} settingsKnown phone={options.phone === true} onOpen={(thread) => options.opened?.push(thread)} />
        </SidebarProvider>
      </QueryClientProvider>,
    ),
  );
  return host;
}

function readsOf(): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const thread = /threads\/([^/?]+)\/pulls/.exec(url)?.[1];
    const pulls = thread === 'msg_rate' ? [{ id: 'msg_rate:k', thread_id: 'msg_rate', pull: 'github.com/ada/harbor#418', label: '#418', state: 'open', added_at: ago(37), read_at: ago(1), checks: 'running', review: null, number: 418 }] : [];
    return new Response(JSON.stringify({ pulls, groups: [], removed: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};

test.skipIf(!hasDom)('off: no Grid row in the sidebar, no read, and `#grid` goes to the Inbox', async () => {
  const noop = () => {};
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar page="inbox" projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} />
      </SidebarProvider>,
    ),
  );
  expect(host.querySelector('[data-grid-nav]')).toBeNull();
  act(() => root!.unmount());
  const asked = readsOf();
  window.location.hash = '#grid';
  const page = mount({ on: false });
  await settle();
  expect(page.querySelector('[data-grid-page]')).toBeNull();
  expect(asked).toEqual([]);
  expect(readRoute().page).toBe('inbox');
});

test.skipIf(!hasDom)('on: the row under Inbox opens Grid', () => {
  const noop = () => {};
  let opened = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar page="inbox" projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onGrid={() => opened++} />
      </SidebarProvider>,
    ),
  );
  const nav = host.querySelector<HTMLButtonElement>('[data-grid-nav]')!;
  expect(nav.textContent).toBe('Grid');
  expect(nav.closest('nav, div')!.textContent!.indexOf('Inbox')).toBeLessThan(nav.closest('nav, div')!.textContent!.indexOf('Grid'));
  act(() => nav.click());
  expect(opened).toBe(1);
});

test.skipIf(!hasDom)("on: every computer's work in its groups, the question under its name, each PR read once, and a click opens the thread", async () => {
  const asked = readsOf();
  const opened: string[] = [];
  const host = mount({ on: true, opened });
  await settle();
  const page = host.querySelector('[data-grid-page]')!;
  expect([...page.querySelectorAll('.ib-grid-gh')].map((h) => h.textContent)).toEqual(['Needs you1', 'Moving2']);
  expect(page.querySelector('[data-grid-counts]')!.textContent).toBe('1 needs you·2 moving');
  const asks = page.querySelector('[data-grid-line="msg_page"]')!;
  expect(asks.querySelector('.ib-grid-q')!.textContent).toBe('Keep the old page param?');
  expect(page.querySelector('[data-grid-line="msg_chat"]')).toBeNull();
  // The PR's words come from its one read: the PR piece, then the checks.
  const rate = page.querySelector('[data-grid-line="msg_rate"]')!;
  expect(rate.querySelector('.ib-grid-s')!.textContent).toContain('PR 37 min · tests running');
  expect(asked.filter((u) => u.includes('/pulls'))).toEqual([expect.stringContaining('/threads/msg_rate/pulls')]);
  // The linked computer's thread is here, and its readout names its computer.
  const far = page.querySelector('[data-grid-line="msg_push"]')!;
  expect(far.querySelector('[data-grid-readout]')!.textContent).toContain('ledger · Mac mini');
  act(() => rate.querySelector<HTMLButtonElement>('.ib-grid-name')!.click());
  expect(opened).toEqual(['msg_rate']);
});

test.skipIf(!hasDom)('phone: a tap opens the readout under the line, with Open thread', async () => {
  readsOf();
  const opened: string[] = [];
  const host = mount({ on: true, phone: true, opened });
  await settle();
  const line = () => host.querySelector('[data-grid-line="msg_page"]')!;
  expect(line().querySelector('[data-grid-readout]')).toBeNull();
  act(() => line().querySelector<HTMLButtonElement>('.ib-grid-name')!.click());
  expect(opened).toEqual([]);
  const readout = line().querySelector('[data-grid-readout]')!;
  expect(readout.textContent).toContain('Needs you');
  act(() => readout.querySelector<HTMLButtonElement>('.ib-grid-ro-open')!.click());
  expect(opened).toEqual(['msg_page']);
});
