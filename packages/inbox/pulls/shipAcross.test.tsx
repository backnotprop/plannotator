/**
 * Ship across computers, and from the review thread's own view (approval "inbox-ship-mode": shot 3's "Mac mini" group,
 * item 7's ship log). What regresses:
 *  - Ship's list offering only the review thread's computer's agents (a linked computer's are missing, or not under
 *    its name, or out of the approved order: the thread's live agents, the other computer's, then New … session);
 *  - a linked computer's agent shipping in a thread it cannot work in (the review's thread here) instead of a new
 *    thread on its own computer, or that ship's record not made there with who it was started with;
 *  - the review thread's ⋯ menu not offering Ship log and Stop shipping while its pull request ships, on this computer
 *    or on a linked one; Stop not going to the computer that holds the ship; the log not opening from there;
 *  - a thread with no pull request reading ships at all.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Every read is a stubbed fetch, put back
 * after each test.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull, type InboxReviewRow, type InboxThread } from '@plannotator/core/inbox-types';
import type { InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import type { ShipHandlers } from './ReviewsList';
import type { ShipOption, ShipTarget } from './shipStart';

const hasDom = typeof document !== 'undefined';
const { ReviewsMenu } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');
const { ThreadMore } = (hasDom ? await import('../components/CopyMenus') : {}) as typeof import('../components/CopyMenus');
const { shipPull, shipOptions } = (hasDom ? await import('./shipStart') : {}) as typeof import('./shipStart');
const { resetShipsForTests } = (hasDom ? await import('../data/ships') : {}) as typeof import('../data/ships');
const { resetMachineLaunchesForTests } = (hasDom ? await import('../compose/useMachineLaunches') : {}) as typeof import('../compose/useMachineLaunches');
const { resetMachineRoutes, setSelfMachine } = (hasDom ? await import('../inboxUrl') : {}) as typeof import('../inboxUrl');
const { inboxApi, resetListReads } = (hasDom ? await import('../api') : {}) as typeof import('../api');

const SELF = 'ibx_01M62DTW6WCYD3ZH6Z17MFMA8G';
const MINI = 'ibx_01M62DTW6WCYD3ZH6Z17MFMA9H';
const THREAD = 'msg_01M62DTT05NJ59ZR4AJCDJ70XK';
const REPO = 'harbor/fern-api';
const KEY = `github.com/${REPO}#614`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const PULL = {
  key: KEY,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number: 614,
  url: `https://github.com/${REPO}/pull/614`,
  title: 'Send a receipt after checkout',
  author: 'ada-novak',
  mine: true,
  requested: false,
  state: 'open',
  base: 'main',
  head: 'b614',
  head_repo: REPO,
  head_sha: 'a'.repeat(40),
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: ago(60_000),
  merged_at: null,
} as InboxPull;
const STACK = inboxPullStacks([PULL])[0]!;
const ROW = {
  id: THREAD,
  reviewed: true,
  move: 'on_you',
  reason: 'review_ready',
  thread_id: THREAD,
  review: null,
  stacks: [STACK],
  pull_keys: [KEY],
  link: { via: 'owner', thread_id: THREAD, thread_subject: null, project_id: 'prj_fern', agent: { host: 'claude-code', session: 'ses_review', name: 'Claude Code' }, last: null, guide: null },
  pull_reason: null,
  landed: [],
  updated_at: ago(60_000),
} as unknown as InboxReviewRow;
const TARGET: ShipTarget = { pull: PULL, stack: STACK, threadId: THREAD, machine: null, projects: ['prj_fern'], agent: { host: 'claude-code', session: 'ses_review', name: 'Claude Code' } };

const session = (id: string, host: string, label: string) => ({ session: id, host, started_at: ago(3_600_000), last_seen_at: ago(5_000), busy: false, idle_since: ago(60_000), last_thread: null, label });
const HERE = {
  serverSession: 'here',
  home: '/home/charlie',
  projects: [{ project: { id: 'prj_fern', name: 'fern-api', root: '/home/charlie/fern-api' }, sessions: [session('ses_review', 'claude-code', 'Receipt email review'), session('ses_export', 'codex', 'Export rate limits')] }],
  launch: { agents: [{ agent: 'claude-code' as const, name: 'Claude Code' }], projects: [{ id: 'prj_fern', name: 'fern-api', root: '/home/charlie/fern-api', exists: true }] },
};
const THERE = {
  serverSession: 'there',
  home: '/Users/charlie',
  projects: [{ project: { id: 'prj_mini', name: 'fern-api', root: '/Users/charlie/fern-api' }, sessions: [session('ses_triage', 'claude-code', 'Nightly e2e triage')] }],
};

function ship(fields: Partial<InboxShipView> = {}): InboxShipView {
  return { id: 'shp_614', key: KEY, url: PULL.url, title: PULL.title, number: 614, repo: REPO, host: 'github.com', thread_id: THREAD, project_id: 'prj_fern', agent: { host: 'claude-code', session: 'ses_review', name: 'Claude Code' }, started_at: ago(60_000), state: 'shipping', reason: null, ended_at: null, merged_at: null, ...fields };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let answers: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
function stub(routes: Record<string, unknown>) {
  answers = routes;
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const key = `${method} ${url.split('?')[0]}`;
    if (!(key in answers)) return Response.json({ error: 'no route', code: 'not_found' }, { status: 404 });
    const answer = answers[key];
    return Response.json(typeof answer === 'function' ? (answer as (c: Call) => unknown)(calls.at(-1)!) : answer);
  }) as typeof fetch;
}

/** This computer, and "Mac mini" linked, taking ships. */
function linkMini() {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'MacBook' },
    { id: MINI, name: 'Mac mini', marks: ['ships'], state: 'online', list_cursor: 1 },
  ]);
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  resetMachineRoutes();
  resetShipsForTests();
  resetMachineLaunchesForTests();
  resetListReads();
});

function frame(children: ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(children);
  });
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, what: string) {
  const end = Date.now() + 3_000;
  while (!done() && Date.now() < end) await wait(10);
  if (!done()) throw new Error(`never: ${what}`);
}
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
}
const items = (menu: HTMLElement) => [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());

test.skipIf(!hasDom)("Ship's list: the review's computer's live agents, the linked computer's under its name, then New … session", () => {
  const { options, chosen } = shipOptions(HERE, TARGET, [{ machine: MINI, name: 'Mac mini', model: THERE, projects: ['prj_mini'] }]);
  expect(options.map((o) => [o.group, o.row.start ? o.row.label : o.row.session])).toEqual([
    [null, 'ses_review'],
    [null, 'ses_export'],
    ['Mac mini', 'ses_triage'],
    [null, 'New Claude Code session'],
  ]);
  // The review's agent is still the one ticked; the far one ships on its computer, in its project there.
  expect(chosen).toBe('ses_review');
  const far = options.find((o) => o.group === 'Mac mini')!;
  expect(far.machine).toBe(MINI);
  expect(far.project).toBe('prj_mini');
  expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
});

test.skipIf(!hasDom)("the row menu's Ship submenu shows the linked computer's agents under its name", async () => {
  linkMini();
  stub({
    'GET /api/inbox/sessions': HERE,
    'GET /api/inbox/machines': { self: SELF, machines: [{ id: SELF, self: true, name: 'MacBook', state: 'online' }, { id: MINI, self: false, name: 'Mac mini', state: 'online', launch: false, marks: ['ships'] }] },
    [`GET /api/inbox/m/${MINI}/sessions`]: THERE,
  });
  const shipped: ShipOption[] = [];
  const handlers: ShipHandlers = { ships: new Map(), repoProjects: { [`github.com/${REPO}`]: ['prj_fern'] }, projectsOf: (m) => (m ? { [`github.com/${REPO}`]: ['prj_mini'] } : { [`github.com/${REPO}`]: ['prj_fern'] }), onShip: (_t, o) => shipped.push(o), onLog: () => {}, onStop: () => {} };
  frame(
    <ReviewsMenu className="ib-lbody" rows={[ROW]} links={{}} phone={false} onTarget={() => {}} onHide={() => {}} ship={handlers}>
      <div data-reviews-row={THREAD} data-reviews-item={THREAD}>
        row
      </div>
    </ReviewsMenu>,
  );
  await act(async () => {
    $(`[data-reviews-item="${THREAD}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
  await until(() => !!$('[data-ship]'), 'Ship in the menu');
  await act(async () => {
    $('[data-ship]')!.focus();
    $('[data-ship]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await until(() => !!$('[data-ship-group="Mac mini"] [data-ship-agent]'), "Mac mini's agents");
  expect($('[data-ship-group="Mac mini"] .ib-pm-glabel')!.textContent).toBe('Mac mini');
  const far = $('[data-ship-group="Mac mini"] [data-ship-agent]')!;
  expect(far.getAttribute('data-ship-machine')).toBe(MINI);
  await press(far);
  expect(shipped.map((o) => [o.machine, o.to])).toEqual([[MINI, { host: 'claude-code', session: 'ses_triage' }]]);
});

test.skipIf(!hasDom)("the window's list reads, whole and then as a change, keep the linked computer that takes ships in Ship's list", async () => {
  // Each list read names the machines: the whole one, and each later one answered as a change (`delta`, #2593).
  // Mac mini is linked on both; on a third read it is not any more.
  const machinesNow = [
    [{ id: SELF, self: true, name: 'MacBook', state: 'online' }, { id: MINI, self: false, name: 'Mac mini', state: 'online', list_cursor: 1, marks: ['artifact-pins', 'ships'] }],
    [{ id: SELF, self: true, name: 'MacBook', state: 'online' }, { id: MINI, self: false, name: 'Mac mini', state: 'online', list_cursor: 1, marks: ['artifact-pins', 'ships'] }],
    [{ id: SELF, self: true, name: 'MacBook', state: 'online' }],
  ];
  let reads = 0;
  stub({
    'GET /api/inbox/threads': (call: Call) => {
      const since = new URL(call.url, 'http://x').searchParams.get('since');
      const machines = machinesNow[Math.min(reads, machinesNow.length - 1)];
      const version = `v${++reads}`;
      const rest = { list_version: version, projects: [], self: SELF, machines };
      return since ? { ...rest, delta: { since, rows: [], sections: [], lists: {} } } : { ...rest, sections: [] };
    },
    'GET /api/inbox/sessions': HERE,
    'GET /api/inbox/machines': { self: SELF, machines: [{ id: SELF, self: true, name: 'MacBook', state: 'online' }, { id: MINI, self: false, name: 'Mac mini', state: 'online', launch: false, marks: ['ships'] }] },
    [`GET /api/inbox/m/${MINI}/sessions`]: THERE,
  });
  await act(() => inboxApi.list());
  await act(() => inboxApi.list());
  expect(calls.filter((c) => c.url.startsWith('/api/inbox/threads')).map((c) => new URL(c.url, 'http://x').searchParams.get('since'))).toEqual(['', 'v1']);
  const handlers: ShipHandlers = { ships: new Map(), repoProjects: { [`github.com/${REPO}`]: ['prj_fern'] }, projectsOf: (m) => (m ? { [`github.com/${REPO}`]: ['prj_mini'] } : { [`github.com/${REPO}`]: ['prj_fern'] }), onShip: () => {}, onLog: () => {}, onStop: () => {} };
  frame(
    <ReviewsMenu className="ib-lbody" rows={[ROW]} links={{}} phone={false} onTarget={() => {}} onHide={() => {}} ship={handlers}>
      <div data-reviews-row={THREAD} data-reviews-item={THREAD}>
        row
      </div>
    </ReviewsMenu>,
  );
  await act(async () => {
    $(`[data-reviews-item="${THREAD}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
  await until(() => !!$('[data-ship]'), 'Ship in the menu');
  await act(async () => {
    $('[data-ship]')!.focus();
    $('[data-ship]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await until(() => !!$('[data-ship-group="Mac mini"] [data-ship-agent]'), "Mac mini's agents after a read answered as a change");
  expect($('[data-ship-group="Mac mini"] [data-ship-agent]')!.getAttribute('data-ship-machine')).toBe(MINI);
  // Unlinked since: the next read, a change too, takes its agents out of Ship.
  await act(() => inboxApi.list());
  await until(() => !$('[data-ship-group="Mac mini"]'), 'Mac mini gone once unlinked');
});

test.skipIf(!hasDom)("a linked computer's agent ships in a new thread on its computer, tied to the PR and recorded there", async () => {
  linkMini();
  stub({
    [`POST /api/inbox/m/${MINI}/pulls/owner`]: (call: Call) => (call.body?.validate_only ? { ok: true, owner: null } : { ok: true }),
    [`POST /api/inbox/m/${MINI}/messages`]: { thread_id: 'msg_far', message: {}, replayed: false },
    [`POST /api/inbox/m/${MINI}/ships`]: { ok: true, ship: ship({ thread_id: 'msg_far' }) },
    [`GET /api/inbox/m/${MINI}/ships`]: { ships: [], projects: {} },
  });
  const [far] = shipOptions(HERE, TARGET, [{ machine: MINI, name: 'Mac mini', model: THERE, projects: ['prj_mini'] }]).options.filter((o) => o.machine === MINI);
  await act(async () => {
    expect(await shipPull(TARGET, far!, 'Mac mini')).toBe('msg_far');
  });
  const writes = calls.filter((c) => c.method === 'POST');
  expect(writes.map((c) => c.url)).toEqual([`/api/inbox/m/${MINI}/pulls/owner`, `/api/inbox/m/${MINI}/messages`, `/api/inbox/m/${MINI}/pulls/owner`, `/api/inbox/m/${MINI}/ships`]);
  expect(writes[0]!.body).toMatchObject({ keys: [KEY], project_id: 'prj_mini', validate_only: true });
  expect(writes[1]!.body).toMatchObject({ to: { host: 'claude-code', session: 'ses_triage' } });
  expect(String(writes[1]!.body!.body)).toContain('Ship this pull request');
  expect(writes[2]!.body).toMatchObject({ keys: [KEY], thread_id: 'msg_far' });
  expect(writes[3]!.body).toMatchObject({ key: KEY, thread_id: 'msg_far', started: true, to: { host: 'claude-code', session: 'ses_triage' } });
  // Nothing went to this computer: the review's thread here is not where the far agent works.
  expect(calls.some((c) => c.url.startsWith('/api/inbox/ships') || c.url.startsWith('/api/inbox/messages'))).toBe(false);
});

const THREAD_VIEW = { thread_id: THREAD, subject: 'Send a receipt after checkout', project: { id: 'prj_fern', name: 'fern-api' }, messages: [{ id: THREAD, questions: [] }], pull_keys: [KEY] } as unknown as InboxThread;
const LOG = [
  { at: ago(60_000), by: 'agent', kind: 'step', text: 'Pushed a fix', sha: 'a3f9c21' },
  { at: ago(5 * 60_000), by: 'inbox', kind: 'started', text: 'Started' },
];

async function openMore() {
  await press($('[data-thread-more]')!);
  await until(() => !!$('[data-thread-menu]'), 'the ⋯ menu');
  return $('[data-thread-menu]')!;
}

test.skipIf(!hasDom)("the review thread's ⋯ menu: Ship log and Stop shipping first while its PR ships here; the log opens; Stop stops it", async () => {
  stub({
    'GET /api/inbox/ships': { ships: [ship()], projects: {} },
    'GET /api/inbox/ships/log': { ship: ship(), log: LOG },
    'POST /api/inbox/ships/stop': { ok: true, ship: ship({ state: 'stopped' }) },
  });
  frame(<ThreadMore thread={THREAD_VIEW} linkOf={() => ''} phone={false} />);
  await until(() => calls.some((c) => c.url === '/api/inbox/ships'), 'the ships read');
  await wait(20);
  let menu = await openMore();
  expect(items(menu).slice(0, 2)).toEqual(['Ship log', 'Stop shipping']);
  await press(menu.querySelector<HTMLElement>('[data-ship-log-open]')!);
  await until(() => document.querySelectorAll('[data-ship-log] .ib-shp-e').length === 2, 'the log');
  expect([...document.querySelectorAll('[data-ship-log] .ib-shp-e')].map((e) => e.textContent)).toEqual([expect.stringContaining('Pushed a fix'), expect.stringContaining('Started')]);
  expect($('[data-ship-log-stop]')).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  menu = await openMore();
  await press(menu.querySelector<HTMLElement>('[data-ship-stop]')!);
  await until(() => calls.some((c) => c.method === 'POST'), 'the stop');
  expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([['/api/inbox/ships/stop', { id: 'shp_614' }]]);
});

test.skipIf(!hasDom)("the review thread's ⋯ menu offers the ship of its PR on a linked computer, and Stop goes there", async () => {
  linkMini();
  stub({
    'GET /api/inbox/ships': { ships: [], projects: {} },
    [`GET /api/inbox/m/${MINI}/ships`]: { ships: [ship({ thread_id: 'msg_far', agent: { host: 'claude-code', session: 'ses_triage', name: 'Claude Code' } })], projects: {} },
    [`POST /api/inbox/m/${MINI}/ships/stop`]: { ok: true, ship: ship({ thread_id: 'msg_far', state: 'stopped' }) },
  });
  frame(<ThreadMore thread={THREAD_VIEW} linkOf={() => ''} phone={false} />);
  await until(() => calls.some((c) => c.url === `/api/inbox/m/${MINI}/ships`), "the linked computer's ships read");
  await wait(20);
  const menu = await openMore();
  expect(items(menu).slice(0, 2)).toEqual(['Ship log', 'Stop shipping']);
  await press(menu.querySelector<HTMLElement>('[data-ship-stop]')!);
  await until(() => calls.some((c) => c.method === 'POST'), 'the stop');
  expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/inbox/m/${MINI}/ships/stop`]);
});

test.skipIf(!hasDom)('a thread with no pull request reads no ships and offers no Ship items', async () => {
  stub({ 'GET /api/inbox/ships': { ships: [ship()], projects: {} } });
  frame(<ThreadMore thread={{ ...THREAD_VIEW, pull_keys: undefined } as InboxThread} linkOf={() => ''} phone={false} />);
  const menu = await openMore();
  expect(items(menu)).not.toContain('Ship log');
  expect(calls.some((c) => c.url.includes('/ships'))).toBe(false);
});
