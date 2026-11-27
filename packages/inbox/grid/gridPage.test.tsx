/**
 * Grid in the window (approval "inbox-agent-grid"; experimental, off by default). What regresses:
 * - a trace of Grid while its switch is off: a sidebar row, a read, a write (a sidebar save or the cookie naming
 *   `grid`), or a `#grid` address that does not go to the Inbox;
 * - the row under Inbox while on, and the page's groups, counts and the question under a name;
 * - Grid reading anything of its own: the PRs' times, checks and review ride the list's rows, so a page of PR threads
 *   and a burst of list reads make no request, and a burst of PR events makes one list read;
 * - "seen" meaning anything but shown: a line counts only once it was on screen in a tab that shows, a line behind
 *   "N more" never does, and a look is kept with the thread on its own computer (a linked one's through its forward,
 *   on its own clock); a look made elsewhere (the row's `grid_seen`) counts here;
 * - a screen reader missing the states or the times (the bar stays hidden from it);
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
const { GridRoute, useGridOn } = (hasDom ? await import('./GridPage') : {}) as typeof import('./GridPage');
const { forgetGridSeen } = (hasDom ? await import('./gridSeen') : {}) as typeof import('./gridSeen');
const { gridHeard } = (hasDom ? await import('./gridOn') : {}) as typeof import('./gridOn');
const { listGridAsked } = (hasDom ? await import('../listRead') : {}) as typeof import('../listRead');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { putList } = (hasDom ? await import('../data/queries/list') : {}) as typeof import('../data/queries/list');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { writeSidebarLayout, resetSidebarLayoutForTests, SIDEBAR_LAYOUT_COOKIE } = (hasDom ? await import('../sidebarLayout') : {}) as typeof import('../sidebarLayout');
const { INBOX_SIDEBAR_DEFAULT } = (hasDom ? await import('@plannotator/core/inbox-sidebar') : {}) as typeof import('@plannotator/core/inbox-sidebar');
const { setStorageBackend, resetStorageBackend } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

/** This browser's cookies, in a map; put back after the test. */
function cookieJar(): Map<string, string> {
  const cookie = new Map<string, string>();
  setStorageBackend({ getItem: (k) => cookie.get(k) ?? null, setItem: (k, v) => void cookie.set(k, v), removeItem: (k) => void cookie.delete(k) });
  resetSidebarLayoutForTests();
  return cookie;
}
const { QueryClient, QueryClientProvider } = (hasDom ? await import('@tanstack/react-query') : {}) as typeof import('@tanstack/react-query');

let root: Root | null = null;
const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;
let hidden = false;
if (hasDom) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.IntersectionObserver = realObserver;
  hidden = false;
  if (hasDom) resetStorageBackend();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
  if (hasDom) {
    forgetGridSeen();
    setInboxAgents([]);
  }
});

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SELF = 'ibx_macbook';
const MINI = 'ibx_macmini';
/** The Mac mini's clock runs 30 minutes behind (`clock_ms` is how far ahead). */
const MINI_AHEAD = -30 * 60_000;

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
    machine: SELF,
    ...over,
  } as InboxListRow;
}
const pr = (n: number, state: 'open' | 'merged', added: number, read: number | null, checks: 'running' | null = null) => ({
  count: 1,
  headline: { key: `github.com/ada/harbor#${n}`, state },
  items: [{ key: `github.com/ada/harbor#${n}`, state, added_at: ago(added), read_at: read === null ? null : ago(read), checks, review: null }],
});

const agents: InboxAgentsGroup[] = [
  { machine: SELF, total: 1, ended_today: 0, agents: [{ id: 'ses_ops', session: 'ses_ops', host: 'claude-code', label: 'harbor ops', project: { id: 'prj_harbor', name: 'harbor' }, state: 'working', waiting: 0, live: true, started_at: ago(200), last_seen_at: ago(1) }] },
  { machine: MINI, total: 1, ended_today: 0, agents: [{ id: 'ses_ledger', session: 'ses_ledger', host: 'claude-code', label: 'ledger', project: { id: 'prj_ledger', name: 'ledger' }, state: 'idle', waiting: 0, live: true, started_at: ago(300), last_seen_at: ago(2) }] },
];

const far = { machine: MINI, author: { kind: 'agent', host: 'claude-code', session: 'ses_ledger', name: null }, project: { id: 'prj_ledger', name: 'ledger' } } as const;
const baseRows = () => [
  row({ thread_id: 'msg_page', thread_name: 'Pagination cursors', section: 'stopped', waiting_since: ago(32), questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: 'Keep the old page param?' }, sent: null }),
  row({ thread_id: 'msg_rate', thread_name: 'Rate limit the export', pulls: pr(418, 'open', 37, null, 'running') }),
  // A linked computer's thread, its times on its own clock (30 minutes behind): it moved a minute ago, not 31.
  row({ thread_id: 'msg_push', thread_name: 'Push notification settings', ...far, last_at: new Date(NOW - 60_000 + MINI_AHEAD).toISOString(), last_agent_at: new Date(NOW - 60_000 + MINI_AHEAD).toISOString(), sent: null, created_at: new Date(NOW - 50 * 60_000 + MINI_AHEAD).toISOString() }),
];

function mount(options: { on: boolean; phone?: boolean; opened?: string[]; rows?: InboxListRow[] }) {
  const client = new QueryClient();
  const put = (rows: InboxListRow[]) =>
    putList(client, {
      sections: [{ id: 'sent', label: 'Sent', threads: rows }],
      machines: [
        { id: SELF, name: 'MacBook', self: true, state: 'online', since: null },
        { id: MINI, name: 'Mac mini', self: false, state: 'online', since: null, clock_ms: MINI_AHEAD },
      ],
      self: SELF,
    } as never);
  put(options.rows ?? baseRows());
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
  return { host, put };
}

function requests(): { url: string; body: unknown }[] {
  const asked: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ seen: {}, sidebar: null, sidebar_rev: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

/** IntersectionObserver as the page uses it: `show(id)` puts a line on screen. */
function fakeScreen() {
  const watched = new Set<Element>();
  let report: ((entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[]) => void) | null = null;
  globalThis.IntersectionObserver = class {
    constructor(callback: typeof report) {
      report = callback;
    }
    observe(el: Element) {
      watched.add(el);
    }
    unobserve(el: Element) {
      watched.delete(el);
    }
    disconnect() {
      watched.clear();
    }
  } as never;
  return {
    watched: () => [...watched].map((el) => (el as HTMLElement).dataset.gridLine ?? 'since'),
    show: (ids: string[]) => act(() => report!([...watched].filter((el) => ids.includes((el as HTMLElement).dataset.gridLine ?? 'since')).map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 })))),
  };
}

const settle = async (ms = 0) => {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const seenPosts = (asked: { url: string; body: unknown }[]) => asked.filter((r) => r.url.includes('/grid/seen'));

test.skipIf(!hasDom)('off: no Grid row in the sidebar, no read, no write, and `#grid` goes to the Inbox', async () => {
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
  const asked = requests();
  window.location.hash = '#grid';
  const { host: page } = mount({ on: false });
  await settle();
  expect(page.querySelector('[data-grid-page]')).toBeNull();
  expect(asked).toEqual([]);
  expect(readRoute().page).toBe('inbox');
  // A Customize save while Grid is off: the cookie never names it (the server leaves it out of config.json too).
  const cookie = cookieJar();
  await writeSidebarLayout({ ...INBOX_SIDEBAR_DEFAULT, top: [...INBOX_SIDEBAR_DEFAULT.top].reverse() });
  expect(cookie.get(SIDEBAR_LAYOUT_COOKIE)).toContain('inbox');
  expect(cookie.get(SIDEBAR_LAYOUT_COOKIE)).not.toContain('grid');
});

test.skipIf(!hasDom)('on: the row under Inbox opens Grid, and the cookie keeps its place', async () => {
  const noop = () => {};
  let opened = 0;
  const cookie = cookieJar();
  function On() {
    useGridOn({ experimental: { decision_mode: { on: false, env: null }, grid: { on: true, env: null } } }, noop);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <On />
        <Sidebar page="inbox" projectId={null} inboxCount={0} projects={[]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onGrid={() => opened++} />
      </SidebarProvider>,
    ),
  );
  const nav = host.querySelector<HTMLButtonElement>('[data-grid-nav]')!;
  expect(nav.textContent).toBe('Grid');
  expect(nav.closest('nav, div')!.textContent!.indexOf('Inbox')).toBeLessThan(nav.closest('nav, div')!.textContent!.indexOf('Grid'));
  act(() => nav.click());
  expect(opened).toBe(1);
  requests();
  await writeSidebarLayout({ ...INBOX_SIDEBAR_DEFAULT, top: [...INBOX_SIDEBAR_DEFAULT.top].reverse() });
  expect(cookie.get(SIDEBAR_LAYOUT_COOKIE)).toContain('grid');
});

test.skipIf(!hasDom)("on: every computer's work in its groups, the question under its name, PR words from the list, and a click opens the thread", async () => {
  fakeScreen();
  const asked = requests();
  const opened: string[] = [];
  const { host } = mount({ on: true, opened });
  await settle();
  const page = host.querySelector('[data-grid-page]')!;
  expect([...page.querySelectorAll('.ib-grid-gh')].map((h) => h.textContent)).toEqual(['Needs you1', 'Moving2']);
  expect(page.querySelector('[data-grid-counts]')!.textContent).toBe('1 needs you·2 moving');
  const asks = page.querySelector('[data-grid-line="msg_page"]')!;
  expect(asks.querySelector('.ib-grid-q')!.textContent).toBe('Keep the old page param?');
  // The PR's words come from the row's summary: the PR piece, then the checks. Nothing was read for them.
  const rate = page.querySelector('[data-grid-line="msg_rate"]')!;
  expect(rate.querySelector('.ib-grid-s')!.textContent).toContain('PR 37 min · tests running');
  expect(asked).toEqual([]);
  // The linked computer's thread is here, moving by its own clock, and its readout names its computer.
  const farLine = page.querySelector('[data-grid-line="msg_push"]')!;
  expect(farLine.getAttribute('data-group')).toBe('move');
  expect(farLine.querySelector('[data-grid-readout]')!.textContent).toContain('ledger · Mac mini');
  act(() => rate.querySelector<HTMLButtonElement>('.ib-grid-name')!.click());
  expect(opened).toEqual(['msg_rate']);
});

test.skipIf(!hasDom)('many PR threads and a burst of list reads: no request of its own; a burst of PR events: one list read', async () => {
  fakeScreen();
  const asked = requests();
  const rows = Array.from({ length: 40 }, (_, i) => row({ thread_id: `msg_pr${i}`, thread_name: `Work ${i}`, pulls: pr(500 + i, 'open', 30, null) }));
  const { host, put } = mount({ on: true, rows });
  for (let i = 0; i < 30; i++) act(() => put(rows.map((r) => ({ ...r, last_at: ago(i % 3) }))));
  await settle();
  expect(host.querySelectorAll('[data-grid-line]').length).toBe(40);
  expect(asked).toEqual([]);

  let reads = 0;
  function On() {
    useGridOn({ experimental: { decision_mode: { on: false, env: null }, grid: { on: true, env: null } } }, () => reads++);
    return null;
  }
  const other = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => other.render(<On />));
  // While Grid shows (the page above), PR events read the list once for the burst.
  for (let i = 0; i < 20; i++) gridHeard('thread-pulls');
  await settle(200);
  expect(reads).toBe(1);
  // Only while Grid is on and shows do the list reads ask for Grid's fields.
  expect(listGridAsked()).toBe(true);
  act(() => root!.unmount());
  root = null;
  expect(listGridAsked()).toBe(false);
  // Not showing: PR events read nothing; a look made elsewhere still reads the list once.
  for (let i = 0; i < 5; i++) gridHeard('thread-pulls');
  await settle(200);
  expect(reads).toBe(1);
  for (let i = 0; i < 5; i++) gridHeard('grid-seen');
  await settle(200);
  expect(reads).toBe(2);
  act(() => other.unmount());

  // Grid off: a PR's checks changing, or a look, reads no list, and no read asks for Grid's fields.
  function Off() {
    useGridOn({ experimental: { decision_mode: { on: false, env: null }, grid: { on: false, env: null } } }, () => reads++);
    return null;
  }
  const off = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => off.render(<Off />));
  const before = reads;
  for (let i = 0; i < 5; i++) {
    gridHeard('thread-pulls');
    gridHeard('grid-seen');
  }
  await settle(200);
  expect(reads).toBe(before);
  expect(listGridAsked()).toBe(false);
  act(() => off.unmount());
});

test.skipIf(!hasDom)('seen: only a line on screen in a tab that shows; kept on its own computer; a line behind "N more" never', async () => {
  const screen = fakeScreen();
  const asked = requests();
  const landed = Array.from({ length: 7 }, (_, i) =>
    row({ thread_id: `msg_land${i}`, thread_name: `Landed ${i}`, section: 'quiet', sent: null, pulls: pr(700 + i, 'merged', 120, 10 + i) }),
  );
  const farLanded = row({ thread_id: 'msg_farland', thread_name: 'Far landed', ...far, section: 'quiet', sent: null, pulls: { ...pr(900, 'merged', 120, 0), items: [{ key: 'github.com/ada/harbor#900', state: 'merged', added_at: ago(120), read_at: new Date(NOW - 3 * 60_000 + MINI_AHEAD).toISOString(), checks: null, review: null }] } });
  const { host } = mount({ on: true, rows: [farLanded, ...landed] });
  await settle();
  // Five of the eight landed lines show; the rest are behind "3 more" and never watched.
  expect(host.querySelectorAll('[data-grid-group="land"] [data-grid-line]').length).toBe(5);
  expect(screen.watched()).not.toContain('msg_land6');
  // On screen while the tab is hidden: nothing yet.
  hidden = true;
  screen.show(['msg_land0', 'msg_farland']);
  await settle(1100);
  expect(seenPosts(asked)).toEqual([]);
  // The tab shows again: those two are sent, each to its own computer.
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle(1100);
  const posts = seenPosts(asked);
  expect(posts.map((p) => p.url).sort()).toEqual(['/api/inbox/grid/seen', `/api/inbox/m/${MINI}/grid/seen`]);
  const own = posts.find((p) => p.url === '/api/inbox/grid/seen')!.body as { seen: { thread: string; through: number }[] };
  expect(own.seen.map((s) => s.thread)).toEqual(['msg_land0']);
  expect(own.seen[0]!.through).toBe(Date.parse(ago(10)));
  // The linked computer's look is on its own clock: its merge time as it wrote it.
  const sentFar = posts.find((p) => p.url.includes(MINI))!.body as { seen: { thread: string; through: number }[] };
  expect(sentFar.seen).toEqual([expect.objectContaining({ thread: 'msg_farland', through: NOW - 3 * 60_000 + MINI_AHEAD })]);
  // Shown again: not sent twice.
  screen.show(['msg_land0']);
  await settle(1100);
  expect(seenPosts(asked).length).toBe(2);
});

test.skipIf(!hasDom)('a look made on another device (the row\'s `grid_seen`) counts here: the line is not bold and not in Since', async () => {
  fakeScreen();
  requests();
  const merged = pr(418, 'merged', 120, 10);
  const { host } = mount({
    on: true,
    rows: [
      row({ thread_id: 'msg_seen', thread_name: 'Seen on the phone', section: 'quiet', sent: null, pulls: merged, grid_seen: { through: Date.parse(ago(10)), at: Date.parse(ago(5)) } }),
      row({ thread_id: 'msg_new', thread_name: 'Not seen', section: 'quiet', sent: null, pulls: pr(419, 'merged', 120, 3), grid_seen: { through: 0, at: Date.parse(ago(5)) } }),
    ],
  });
  await settle();
  expect(host.querySelector('[data-grid-line="msg_seen"]')!.hasAttribute('data-fresh')).toBe(false);
  expect(host.querySelector('[data-grid-line="msg_new"]')!.hasAttribute('data-fresh')).toBe(true);
  expect(host.querySelector('[data-grid-since]')!.textContent).toContain('1 merged');
});

test.skipIf(!hasDom)('a screen reader hears the states and the times; the bar stays hidden from it', async () => {
  fakeScreen();
  requests();
  const { host } = mount({ on: true });
  await settle();
  const line = host.querySelector('[data-grid-line="msg_page"]')!;
  const name = line.querySelector<HTMLButtonElement>('.ib-grid-name')!;
  expect(name.getAttribute('aria-label')).toBe('Pagination cursors. Needs you. Working 1.5 hours, Needs you 32 minutes. Keep the old page param?');
  const readout = document.getElementById(name.getAttribute('aria-describedby')!)!;
  expect(readout.closest('[aria-hidden="true"]')).toBeNull();
  expect(readout.textContent).toMatch(/\d{1,2}:\d{2}/);
  expect(line.querySelector('.ib-grid-bar')!.getAttribute('aria-hidden')).toBe('true');
});

test.skipIf(!hasDom)('phone: a tap opens the readout under the line, with Open thread', async () => {
  fakeScreen();
  requests();
  const opened: string[] = [];
  const { host } = mount({ on: true, phone: true, opened });
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
