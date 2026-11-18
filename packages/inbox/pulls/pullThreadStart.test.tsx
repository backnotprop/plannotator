/**
 * A PR page's Start a thread (PullThreadStart.tsx, mock "V1, slim line"), in the window, with the Inbox's doors stubbed
 * at `fetch`. What regresses:
 *  - the page not turning, in place, into an empty thread for the PR (its line, the one quiet line, the reply box
 *    empty and focused, To in the box's row on New review's choice);
 *  - anything created before Send: a thread, a link, a check; leaving (Escape, the bin) or closing leaving something;
 *  - the words typed and left lost, or kept after they were sent;
 *  - Send not checking the PR with To's project first, not starting the thread with the person's words FIRST and the
 *    PR's details after, asking for a guided review, or keeping the PR with an ask other than `thread`;
 *  - a double press, or a press again after a failure, starting a second thread (one key per press series);
 *  - the window not opening the started thread in place of the page, or a PR whose thread started there opening its
 *    launchpad again rather than the thread;
 *  - a phone's To not being the box's own agent control and sheet;
 *  - the thread's first message showing the PR's details instead of folding them under "Sent with: this PR's details".
 *
 * Element checks are booleans: a failing match on a happy-dom node prints the whole window.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { PullsPageProps } from './PullsPage';
import { pullsStateOf } from './reviewsTestState';

const hasDom = typeof document !== 'undefined';
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { forgetUnsentPullThreads } = (hasDom ? await import('./PullThreadStart') : {}) as typeof import('./PullThreadStart');
const { MessageBody } = (hasDom ? await import('../parts/MessageBody/MessageBody') : {}) as typeof import('../parts/MessageBody/MessageBody');
const { pullThreadMessage } = (hasDom ? await import('./startThread') : {}) as typeof import('./startThread');
const { inboxPullStacks } = (hasDom ? await import('@plannotator/core/inbox-types') : {}) as typeof import('@plannotator/core/inbox-types');
const { pullHandoffMessage } = (hasDom ? await import('./model') : {}) as typeof import('./model');

const REPO = 'northwind/web-app';
const ASK = 'Tell me about what this PR is.';

const single: InboxPull = {
  key: `github.com/${REPO}#880`,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number: 880,
  url: `https://github.com/${REPO}/pull/880`,
  title: 'Fix RTL in the date picker',
  author: 'tomas',
  mine: false,
  requested: true,
  state: 'open',
  base: 'main',
  head: 'fix/rtl',
  head_repo: REPO,
  additions: 142,
  deletions: 38,
  files: 4,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
};

const answer = (links: Record<string, InboxPullLink> = {}): InboxPullsAnswer => ({
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [single],
  links,
  projects: { [`github.com/${REPO}`]: ['prj_web'] },
  cards: {},
});

const liveSession = (session: string) => ({ session, host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:29:00.000Z', busy: false, idle_since: null, last_thread: null });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const went: string[] = [];
let posts: { path: string; body: Record<string, unknown> }[] = [];
let reloads = 0;
/** How the next starts answer: ok, or a failure the Send must survive. */
let startFails = 0;
/** Holds the start's answer until released (a double press while one is on its way). */
let hold: Promise<void> | null = null;

beforeEach(() => {
  if (!hasDom) return;
  went.length = 0;
  posts = [];
  reloads = 0;
  startFails = 0;
  hold = null;
  forgetUnsentPullThreads();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      posts.push({ path: url.pathname, body: JSON.parse(String(init.body ?? '{}')) });
      if (url.pathname.endsWith('/api/inbox/messages')) {
        if (hold) await hold;
        if (startFails > 0) {
          startFails -= 1;
          return Response.json({ error: 'The Inbox did not answer.', code: 'error' }, { status: 500 });
        }
        return Response.json({ thread_id: 'thr_new', message: {}, replayed: false });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/api/inbox/sessions')) {
      return Response.json({
        serverSession: 's',
        home: '/home/dana',
        projects: [
          { project: { id: 'prj_web', name: 'web-app', root: '/home/dana/web-app' }, sessions: [liveSession('ses_web')] },
          { project: { id: 'prj_other', name: 'billing', root: '/home/dana/billing' }, sessions: [liveSession('ses_billing')] },
        ],
        launch: { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [{ id: 'prj_web', name: 'web-app', root: '/home/dana/web-app', exists: true }, { id: 'prj_other', name: 'billing', root: '/home/dana/billing', exists: true }] },
      });
    }
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: url.searchParams.get('key'), description: null, labels: [], reviewers: [], checks: [], comments: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(model: InboxPullsAnswer, extra: Partial<PullsPageProps> = {}) {
  const state = { ...pullsStateOf(model), reload: () => (reloads += 1) };
  const props: PullsPageProps = {
    state,
    stackId: single.key,
    project: null,
    filter: 'all',
    projects: [],
    projectNames: new Map(),
    phone: false,
    onOpenStack: (id) => went.push(`stack ${id}`),
    onScope: () => {},
    onReview: (stack, key, scope) => went.push(`diff ${stack} ${key} ${scope}`),
    onOpenThread: (thread, replace) => went.push(`thread ${thread}${replace ? ' in place' : ''}`),
    onNew: () => {},
    onNewReview: (pick) => went.push(`new review ${pick.id}`),
    ...extra,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <PullsPage {...props} />
        </div>
      </SidebarProvider>,
    );
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = async (selector: string) => {
  await act(async () => $(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
};
const field = () => $<HTMLTextAreaElement>('[data-pull-thread-start] textarea')!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function escape() {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await settle();
}
async function start(extra: Partial<PullsPageProps> = {}) {
  mount(answer(), extra);
  await settle();
  await click('[data-launch-go="start-thread"]');
  await settle();
}
const sends = () => posts.filter((p) => p.path.endsWith('/api/inbox/messages'));

test.skipIf(!hasDom)('Start a thread: the page becomes an empty thread for the PR, in place, with To on a live agent of its project; nothing is created', async () => {
  await start();
  const pane = $('[data-pull-thread-start]')!;
  expect(!!pane && !$('[data-launchpad]')).toBe(true);
  // The PR's bar stays; its line says the title, branch, size and checks, with Guided review and The diff.
  expect(!!pane.querySelector('.ib-pr-bar [data-pulls-open-forge]')).toBe(true);
  const line = pane.querySelector('[data-pull-context]')!;
  expect(['Fix RTL in the date picker', 'fix/rtl', '+142', '−38', 'Checks passed'].every((words) => line.textContent!.includes(words))).toBe(true);
  expect([...line.querySelectorAll('[data-pull-context-go]')].map((b) => b.textContent)).toEqual(['Guided review', 'The diff']);
  expect(pane.querySelector('[data-pull-thread-empty]')!.textContent).toBe('Ask anything about this pull request. Your first message starts the thread.');
  expect(document.activeElement === field() && field().value === '').toBe(true);
  // To: the live agent of the PR's project; its list holds that project's agents only, and a new session there.
  expect(pane.querySelector('[data-recipient]')!.textContent!.includes('Claude Code')).toBe(true);
  await click('[data-pull-thread-start] [data-recipient]');
  const rows = [...document.querySelectorAll('[data-recipient-list] [data-recipient-row]')].map((row) => row.getAttribute('data-recipient-row'));
  expect(rows).toEqual(['ses_web', 'new:claude-code:prj_web']);
  expect(!!$('[data-recipient-list] [data-recipient-tag]')).toBe(false);
  // The links still work: The diff opens this layer's diff, Guided review the New review box.
  await click('[data-pull-context-go="diff"]');
  await click('[data-pull-context-go="guide"]');
  expect(went).toEqual([`diff ${single.key} ${single.key} layer`, `new review ${single.key}`]);
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)('leaving leaves nothing: Escape and the bin go back to the PR page, closing goes back to Reviews; typed words come back for this PR only until sent', async () => {
  await start();
  await type(ASK);
  await escape();
  expect(!!$('[data-launchpad]') && !$('[data-pull-thread-start]')).toBe(true);
  await click('[data-launch-go="start-thread"]');
  expect(field().value).toBe(ASK);
  await click('[data-pull-thread-start] [data-reply-discard]');
  expect(!!$('[data-launchpad]')).toBe(true);
  await click('[data-launch-go="start-thread"]');
  expect(field().value).toBe('');
  await click('[data-pull-thread-start] .ib-pr-bar [aria-label="Close"]');
  expect(went).toEqual(['stack null']);
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)("Send: the PR checked with To's project, the thread started with the person's words first and the PR's details after, kept as the PR's with no guided review; the thread opens in place", async () => {
  await start();
  await type(`${ASK} `);
  await click('[data-pull-thread-start] [data-reply-send]');
  await settle();
  expect(posts.map((p) => p.path.replace(/^.*\/api\/inbox/, ''))).toEqual(['/pulls/owner', '/messages', '/pulls/owner']);
  expect(posts[0]!.body).toMatchObject({ keys: [single.key], project_id: 'prj_web', validate_only: true });
  const sent = posts[1]!.body;
  expect(sent.to).toEqual({ host: 'claude-code', session: 'ses_web' });
  expect(sent.body).toBe(`${ASK}\n\n${pullHandoffMessage(inboxPullStacks([single])[0]!, { kind: 'thread' })}`);
  expect(String(sent.body).includes('/review-curate')).toBe(false);
  expect(sent.thread_name).toBe('Review #880: Fix RTL in the date picker');
  expect(posts[2]!.body).toMatchObject({ keys: [single.key], thread_id: 'thr_new', ask: 'thread' });
  expect(went).toEqual(['thread thr_new in place']);
  expect(reloads).toBe(1);
});

test.skipIf(!hasDom)('a new session chosen in To starts in the PR\'s project', async () => {
  await start();
  await click('[data-pull-thread-start] [data-recipient]');
  await click('[data-recipient-list] [data-recipient-row="new:claude-code:prj_web"] .ib-rpick-name');
  await type(ASK);
  await click('[data-pull-thread-start] [data-reply-send]');
  await settle();
  expect(sends()[0]!.body.to).toEqual({ launch: { agent: 'claude-code', project_id: 'prj_web' } });
});

test.skipIf(!hasDom)('a double press while the Send is on its way, and a press again after it failed, start one thread: one key', async () => {
  await start();
  await type(ASK);
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  startFails = 1;
  await act(async () => {
    $('[data-pull-thread-start] [data-reply-send]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    $('[data-pull-thread-start] [data-reply-send]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
  expect(sends()).toHaveLength(1);
  hold = null;
  release();
  await settle();
  expect(!!$('[data-pull-thread-error]')).toBe(true);
  expect(went).toEqual([]);
  await click('[data-pull-thread-start] [data-reply-send]');
  await settle();
  expect(sends()).toHaveLength(2);
  expect(sends()[1]!.body.idempotency_key).toBe(sends()[0]!.body.idempotency_key);
  expect(went).toEqual(['thread thr_new in place']);
});

test.skipIf(!hasDom)('a PR whose thread was started from its page opens that thread, in place of its page; one handed over another way keeps its page', async () => {
  const link: InboxPullLink = { via: 'owner', ask: 'thread', thread_id: 'thr_pr', thread_subject: 'Review #880', project_id: 'prj_web', agent: { host: 'claude-code', session: 'ses_web', name: null }, last: null, guide: null };
  mount(answer({ [single.key]: link }));
  await settle();
  expect(went).toEqual(['thread thr_pr in place']);
  act(() => root!.unmount());
  host!.remove();
  went.length = 0;
  mount(answer({ [single.key]: { ...link, ask: 'guide' } }));
  await settle();
  expect(went).toEqual([]);
  expect(!!$('[data-launchpad]')).toBe(true);
});

test.skipIf(!hasDom)("a phone: the same empty thread, To as the box's agent control with its sheet", async () => {
  await start({ phone: true });
  expect(!!$('[data-pull-thread-start]')).toBe(true);
  const control = $('[data-pull-thread-start] [data-recipient]')!;
  expect(control.getAttribute('data-recipient-chosen')).toBe('ses_web');
  await click('[data-pull-thread-start] [data-recipient]');
  expect([...document.querySelectorAll('[data-recipient-list] [data-recipient-row]')].map((row) => row.getAttribute('data-recipient-row'))).toEqual(['ses_web', 'new:claude-code:prj_web']);
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)("the thread's first message shows the person's words, and the PR's details only under Sent with", async () => {
  const body = pullThreadMessage(inboxPullStacks([single])[0]!, ASK);
  const message = { id: 'msg_1', reply_to: null, author: { kind: 'person' }, subject: ASK, body, created_at: '2026-11-03T09:40:00.000Z', idempotency_key: 'k', to: { host: 'claude-code', session: 'ses_web' } } as unknown as InboxMessageWire;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <MessageBody message={message} projectRoot="/home/dana/web-app" readOnly answers={new Map()} onPick={() => {}} footerFor={() => null} onOpenAttachment={() => {}} />
      </div>,
    );
  });
  await settle();
  expect(host.textContent!.includes(ASK)).toBe(true);
  expect(host.textContent!.includes('Pull request')).toBe(false);
  const toggle = host.querySelector<HTMLButtonElement>('[data-pull-details-toggle]')!;
  expect(toggle.textContent).toBe('Sent with: this PR’s details');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle.click());
  expect(host.querySelector('[data-pull-details-text]')!.textContent).toBe(pullHandoffMessage(inboxPullStacks([single])[0]!, { kind: 'thread' }));
});
