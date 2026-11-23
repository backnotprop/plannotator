/**
 * Start review thread on the Pull requests board (approval "inbox-pr-board-bulk": one thread per repository; do what
 * can be done and say plainly what could not). What regresses:
 *  - one thread per PR, or one thread across two repositories or two machines;
 *  - a second review thread for a PR that has one, or for one started a moment ago before the list says so;
 *  - a linked machine's PRs started on this machine (its agents, its checkout), or held for an asleep machine;
 *  - a pick that could not start leaving the selection, or a report without its threads one click away;
 *  - a phone's report as one wrapped sentence of 44 px links instead of a row per thread;
 *  - one PR's hand-off changing: its message and name stay today's `pullHandoffMessage` and `pullHandoffThreadName`;
 *  - an agent that is working given the review instead of a new one;
 *  - a second thread for PRs whose tie to theirs failed, after a reload; a press again after a Send that failed with a
 *    new key (a machine that took the first late starts a second), or with the key of a hold that was cancelled;
 *  - an older linked machine's door words ("Not a phone route.") said instead of the update it needs.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh and no agent: the window's fetch
 * is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxComposeLaunch, type InboxComposeProject, type InboxPull, type InboxPullLink, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import { pullHandoffMessage, pullHandoffThreadName } from '../pulls/model';
import type { SheetPageProps } from './SheetPage';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('./SheetPage') : {}) as typeof import('./SheetPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const MINI = 'ibx_01K0000000000000000000000B';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/ledger';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    head_sha: String(number).padStart(40, 'a'),
    additions: number,
    deletions: 1,
    files: 1,
    review: 'approved',
    approved_by: 'jun',
    reviewers: ['jun'],
    checks: 'success',
    conflicts: false,
    updated_at: '2026-11-08T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const key = (n: number, repo = 'northwind/ledger') => `github.com/${repo}#${n}`;
const API = 'northwind/api';
// ledger #7 #8 #9 and web #20 here; api #30 #31 only on the Mac mini; tool #40 in no project.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(7), pull(8), pull(9), pull(20, { repo: 'northwind/web' }), pull(30, { repo: API, machine: MINI }), pull(31, { repo: API, machine: MINI, mine: false, author: 'tomas' }), pull(40, { repo: 'acme/tool' })],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'], 'github.com/northwind/web': ['prj_web'], 'github.com/northwind/api': ['prj_api'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};

const launchOf = (ids: string[]): InboxComposeLaunch => ({ agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: ids.map((id) => ({ id, name: id.slice(4), root: `/w/${id}`, exists: true })) });
/** What each machine's compose read answers: its live sessions and what it can start. Absent: 503, asleep. */
let sessions: Record<string, { projects: InboxComposeProject[]; launch?: InboxComposeLaunch }> = {};
let sent: { method: string; url: string; body: Record<string, any> }[] = [];
let threads = 0;
let toasts: { toast: Omit<InboxToastModel, 'id'>; ms: number }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** A refusal for a request the test chooses; null lets the fake answer. */
let refuse: (request: { url: string; body: Record<string, any> }) => Response | null = () => null;

beforeEach(() => {
  if (!hasDom) return;
  sent = [];
  threads = 0;
  toasts = [];
  sessions = { here: { projects: [], launch: launchOf(['prj_ledger', 'prj_web']) } };
  refuse = () => null;
  window.localStorage.clear();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const machine = /\/api\/inbox\/m\/([^/]+)\//.exec(url)?.[1] ?? 'here';
    if (!/\/(sessions|pulls\/owner|messages|launch\/[^/]+\/stop|outbox\/[^/]+\/cancel)(\?|$)/.test(url)) return Response.json({});
    sent.push({ method, url, body });
    const refused = refuse({ url, body });
    if (refused) return refused;
    if (url.includes('/sessions')) {
      const answer = sessions[machine];
      return answer ? Response.json({ serverSession: 's', home: '/home', ...answer }) : Response.json({ error: 'Mac mini cannot be reached now.', code: 'machine_offline' }, { status: 503 });
    }
    if (url.includes('/pulls/owner')) return Response.json({ ok: true });
    if (url.includes('/stop')) return Response.json({ run: null });
    if (url.includes('/cancel')) return Response.json({ entry: { key: 'held', state: 'cancelled' } });
    threads += 1;
    const launch = 'launch' in body.to ? { launch: { id: `lau_${threads}`, state: 'starting' } } : {};
    return Response.json({ thread_id: `msg_${machine === 'here' ? '' : 'mini_'}${threads}`, message: {}, replayed: false, ...launch });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

function draw(over: Partial<SheetPageProps> = {}) {
  const opened: string[] = [];
  const refreshed: number[] = [];
  const props: SheetPageProps = {
    mode: 'pane',
    model: MODEL,
    error: null,
    loading: false,
    phone: false,
    view: 'open',
    risk: {},
    now: NOW,
    layout: 'grid',
    onLayout: () => {},
    onView: () => {},
    onOpenPull: () => {},
    onOpenStack: () => {},
    onMerged: () => refreshed.push(1),
    onToast: (toast, ms) => toasts.push({ toast, ms }),
    onOpenThread: (id) => opened.push(id),
    ...over,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider><SheetPage {...props} /></SidebarProvider></div>));
  return { opened, refreshed };
}

const click = (el: HTMLElement) => act(() => el.click());
/** The window loads again: a new board over the same list. */
function reload(over: Partial<SheetPageProps> = {}) {
  act(() => root?.unmount());
  host?.remove();
  return draw(over);
}
const tile = (k: string) => $(`[data-pr-tile="${k}"]`);
const pickedTiles = () => $$('[data-pr-tile][aria-checked="true"]').map((t) => t.dataset.prTile).sort();
const row = (kind: string) => $$(`[data-pr-review-row="${kind}"]`).map((r) => r.textContent);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const messages = () => sent.filter((s) => s.url.endsWith('/messages'));
const owners = () => sent.filter((s) => s.url.endsWith('/pulls/owner') && !s.body.validate_only);

/** Select, pick these, and press Start review thread. */
async function start(keys: string[], words: string) {
  click($('[data-pr-select="select"]')!);
  for (const k of keys) click(tile(k)!);
  const button = $('[data-pr-review]')!;
  // The full words, and its title for when a narrow bar says "Review".
  expect(button.querySelector('.ib-prs-long')!.textContent).toBe(words);
  expect(button.title).toBe(words);
  click(button);
  await settle();
}

test('one thread per repository: several PRs get the several-PR hand-off, one PR keeps today’s; the report links each thread', async () => {
  if (!hasDom) return;
  const { opened, refreshed } = draw();
  await start([key(7), key(9), key(20, 'northwind/web')], 'Start 2 review threads');

  expect(messages().map((m) => m.url)).toEqual(['/api/inbox/messages', '/api/inbox/messages']);
  const [ledger, web] = messages().map((m) => m.body);
  // No agent was live: a new one in each repository's project, as New review fills in.
  expect(ledger!.to).toEqual({ launch: { agent: 'claude-code', project_id: 'prj_ledger' } });
  expect(ledger!.body).toStartWith("You're being asked to help me review and discuss 2 pull requests in northwind/ledger.\n\nPull requests\n- #7 Change 7 · https://github.com/northwind/ledger/pull/7 · branch b7 into main · by me\n- #9 ");
  expect(ledger!.thread_name).toBe('Review #7 and #9');
  // One PR: exactly today's message and name.
  const one = inboxPullStacks([MODEL.pulls[3]!])[0]!;
  expect(web!.body).toBe(pullHandoffMessage(one));
  expect(web!.thread_name).toBe(pullHandoffThreadName(one, null));
  expect(web!.to).toEqual({ launch: { agent: 'claude-code', project_id: 'prj_web' } });
  // Each thread's PRs are checked with its project before it starts, then kept as its own.
  expect(sent.filter((s) => s.body.validate_only).map((s) => [s.body.keys, s.body.project_id])).toEqual([
    [[key(7), key(9)], 'prj_ledger'],
    [[key(20, 'northwind/web')], 'prj_web'],
  ]);
  expect(owners().map((s) => [s.body.keys, s.body.thread_id, s.body.ask])).toEqual([
    [[key(7), key(9)], 'msg_1', 'guide'],
    [[key(20, 'northwind/web')], 'msg_2', 'guide'],
  ]);

  expect(row('started')).toEqual(['Started 2 reviews: ledger (2 PRs), web (1 PR)']);
  expect(pickedTiles()).toEqual([]);
  expect(refreshed).toEqual([1]);
  click($$('[data-pr-thread-link]')[1]!);
  expect(opened).toEqual(['msg_2']);
  // Only new agents started: the toast offers Stop, which stops exactly those.
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast).toMatchObject({ lead: 'Started 2 reviews', action: { label: 'Stop' } });
  act(() => toasts[0]!.toast.action!.onPress());
  await settle();
  expect(sent.filter((s) => s.url.includes('/stop')).map((s) => s.url)).toEqual(['/api/inbox/launch/lau_1/stop', '/api/inbox/launch/lau_2/stop']);
  expect(toasts.at(-1)!.toast.lead).toBe('Stopped 2');
});

test('a PR with a review thread is linked to it, never given a second; one started here a moment ago counts too', async () => {
  if (!hasDom) return;
  const link: InboxPullLink = { via: 'owner', thread_id: 'msg_codex', thread_subject: null, project_id: 'prj_ledger', agent: { host: 'codex', session: 'ses_c', name: null }, last: null, guide: null };
  const { opened } = draw({ model: { ...MODEL, links: { [key(8)]: link } } });
  await start([key(7), key(8)], 'Start review thread');
  expect(messages().map((m) => m.body.thread_name)).toEqual([pullHandoffThreadName(inboxPullStacks([MODEL.pulls[0]!])[0]!, null)]);
  expect(owners().map((s) => s.body.keys)).toEqual([[key(7)]]);
  expect(row('started')).toEqual(['Started 1 review: ledger (1 PR)']);
  expect(row('already')).toEqual(['Already in review: #8 with Codex.']);
  click($('[data-pr-review-row="already"] [data-pr-thread-link]')!);
  expect(opened).toEqual(['msg_codex']);

  // #7 again before the list brings its link: its thread is the one just started.
  click($('[data-pr-select="done"]')!);
  sent = [];
  await start([key(7)], 'Start review thread');
  expect(messages()).toEqual([]);
  expect(row('already')).toEqual(['Already in review: #7.']);
});

test('PRs whose tie to their thread failed stay in review across a reload, never given a second thread; the tie is tried again until it holds', async () => {
  if (!hasDom) return;
  refuse = ({ url, body }) => (url.endsWith('/pulls/owner') && !body.validate_only ? Response.json({ error: 'The Inbox is busy.', code: 'busy' }, { status: 500 }) : null);
  draw();
  await start([key(7), key(9)], 'Start review thread');
  expect(messages()).toHaveLength(1);
  expect(row('untied')).toEqual(['#7, #9 Not tied to its thread: The Inbox is busy.']);

  sent = [];
  reload();
  await settle();
  expect(owners().map((s) => [s.body.keys, s.body.thread_id])).toEqual([[[key(7), key(9)], 'msg_1']]);
  sent = [];
  await start([key(7), key(9)], 'Start review thread');
  expect(messages()).toEqual([]);
  expect(row('already')).toEqual(['Already in review: #7, #9.']);

  refuse = () => null;
  sent = [];
  const { refreshed } = reload();
  await settle();
  expect(owners()).toHaveLength(1);
  expect(refreshed).toEqual([1]);
  sent = [];
  reload();
  await settle();
  expect(owners()).toEqual([]);
});

test('a press again after a Send that failed replays it with its key; after a hold that was cancelled it sends anew', async () => {
  if (!hasDom) return;
  sessions[MINI] = { projects: [], launch: launchOf(['prj_api']) };
  let first = true;
  refuse = ({ url }) => {
    if (!url.endsWith(`/m/${MINI}/messages`) || !first) return null;
    first = false;
    return Response.json({ error: 'Mac mini did not answer in time.', code: 'machine_timeout' }, { status: 504 });
  };
  draw();
  await start([key(30, API), key(31, API)], 'Start review thread');
  expect(row('failed')).toEqual(['#30, #31 Not started: Mac mini did not answer in time.']);
  click($('[data-pr-review]')!);
  await settle();
  const sends = messages().map((m) => m.body.idempotency_key as string);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toBe(sends[0]!);
  expect(row('started')).toEqual(['Started 1 review: api (2 PRs)']);

  // Held for an asleep machine and cancelled: that key answers the cancelled hold, so the next press has its own.
  sent = [];
  first = true;
  refuse = ({ url }) => {
    if (!url.endsWith(`/m/${MINI}/messages`) || !first) return null;
    first = false;
    return Response.json({ outbox: { key: 'held', state: 'queued' }, machine: { id: MINI, name: 'Mac mini', state: 'offline' } }, { status: 202 });
  };
  window.localStorage.clear();
  reload();
  click($('[data-pr-select="select"]')!);
  click(tile(key(30, API))!);
  click($('[data-pr-review]')!);
  await settle();
  expect(row('failed')).toEqual(['#30 Not started: Mac mini cannot be reached now.']);
  expect(sent.some((s) => s.url.endsWith('/outbox/held/cancel'))).toBe(true);
  click($('[data-pr-review]')!);
  await settle();
  const again = messages().map((m) => m.body.idempotency_key as string);
  expect(again).toHaveLength(2);
  expect(again[1]).not.toBe(again[0]!);
});

test('a linked machine too old for the route says it needs updating, in the words used for its agents', async () => {
  if (!hasDom) return;
  sessions[MINI] = { projects: [], launch: launchOf(['prj_api']) };
  refuse = ({ url }) => (url.includes(`/m/${MINI}/pulls/owner`) ? Response.json({ error: 'Not a phone route.', code: 'device_route_not_found' }, { status: 404 }) : null);
  draw({ machineName: (id) => (id === MINI ? 'Mac mini' : null) });
  await start([key(30, API)], 'Start review thread');
  expect(row('failed')).toEqual(['#30 Not started: Update Plannotator on Mac mini to start agents there.']);
  expect(messages()).toEqual([]);
});

test("a phone's report: a heading, then one row per thread, each its own link", async () => {
  if (!hasDom) return;
  const link: InboxPullLink = { via: 'owner', thread_id: 'msg_codex', thread_subject: null, project_id: 'prj_ledger', agent: { host: 'codex', session: 'ses_c', name: null }, last: null, guide: null };
  const { opened } = draw({ phone: true, model: { ...MODEL, links: { [key(8)]: link } } });
  await start([key(7), key(8), key(9), key(20, 'northwind/web')], 'Start 2 review threads');
  expect(row('started')).toEqual(['Started 2 reviews']);
  expect(row('started-thread')).toEqual(['ledger (2 PRs)', 'web (1 PR)']);
  expect(row('already')).toEqual(['Already in review']);
  expect(row('already-thread')).toEqual(['#8 with Codex']);
  expect($$('[data-pr-review-row$="-thread"]').map((r) => r.querySelectorAll('[data-pr-thread-link]').length)).toEqual([1, 1, 1]);
  click($('[data-pr-review-row="already-thread"] [data-pr-thread-link]')!);
  expect(opened).toEqual(['msg_codex']);
});

test("two repositories on two machines: the Mac mini's PRs start there, to its free agent, never to one that is working", async () => {
  if (!hasDom) return;
  const busy = { session: 'ses_busy', host: 'claude-code', started_at: '', last_seen_at: '', busy: true, idle_since: null, last_thread: null };
  const free = { ...busy, session: 'ses_free', host: 'codex', busy: false };
  sessions[MINI] = { projects: [{ project: { id: 'prj_api', name: 'api', root: '/w/api' }, sessions: [busy, free] }], launch: launchOf(['prj_api']) };
  draw();
  await start([key(7), key(30, API), key(31, API)], 'Start 2 review threads');
  expect(sent.map((s) => `${s.method} ${s.url.replace(/\?.*/, '')}`)).toEqual([
    'GET /api/inbox/sessions',
    'POST /api/inbox/pulls/owner',
    'POST /api/inbox/messages',
    'POST /api/inbox/pulls/owner',
    `GET /api/inbox/m/${MINI}/sessions`,
    `POST /api/inbox/m/${MINI}/pulls/owner`,
    `POST /api/inbox/m/${MINI}/messages`,
    `POST /api/inbox/m/${MINI}/pulls/owner`,
  ]);
  const mini = messages()[1]!.body;
  expect(mini.to).toEqual({ host: 'codex', session: 'ses_free' });
  // A teammate's PR among them: no code changes unless asked, no push.
  expect(mini.body).toContain("in northwind/api. Don't change any code unless I explicitly tell you to.");
  expect(mini.body).toContain("Don't push to the branches, comment on the pull requests, approve them or merge them.");
  expect(owners()[1]!.body).toMatchObject({ keys: [key(30, API), key(31, API)], thread_id: 'msg_mini_2' });
  expect(row('started')).toEqual(['Started 2 reviews: ledger (1 PR), api (2 PRs)']);
  // One went to a live agent: Stop would not stop it, so the toast offers none (the report says what started).
  expect(toasts).toEqual([]);
});

test('an asleep machine starts nothing and says why; the others start; a repository that is no project is said too; what could not stays picked', async () => {
  if (!hasDom) return;
  draw();
  await start([key(9), key(30, API), key(31, API), key(40, 'acme/tool')], 'Start 2 review threads');
  expect(messages().map((m) => m.url)).toEqual(['/api/inbox/messages']);
  expect(sent.some((s) => s.url.includes(`/m/${MINI}/messages`) || s.url.includes(`/m/${MINI}/pulls/owner`))).toBe(false);
  expect(row('started')).toEqual(['Started 1 review: ledger (1 PR)']);
  expect(row('failed')).toEqual(['#30, #31 Not started: Mac mini cannot be reached now.', '#40 Not started: tool is not a project.']);
  expect(pickedTiles()).toEqual([key(30, API), key(31, API), key(40, 'acme/tool')].sort());
});

test("a tile's popover opens its review thread once it has one, and offers nothing without one", async () => {
  if (!hasDom) return;
  const link: InboxPullLink = { via: 'owner', thread_id: 'msg_codex', thread_subject: null, project_id: 'prj_ledger', agent: { host: 'codex', session: 'ses_c', name: null }, last: null, guide: null };
  const { opened } = draw({ phone: true, model: { ...MODEL, links: { [key(8)]: link } } });
  click(tile(key(8))!);
  click($('[data-pr-pop-thread]')!);
  expect(opened).toEqual(['msg_codex']);
  click(tile(key(7))!);
  expect($('[data-pr-pop]')).not.toBeNull();
  expect($('[data-pr-pop-thread]')).toBeNull();
});
