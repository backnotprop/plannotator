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
 *  - the thread's first message showing the PR's details instead of folding them under "Sent with: this PR's details";
 *  - a thread that started but was not tied being started AGAIN (words edited, the page left and opened again, no
 *    agent left): from then on a Send only ties it, To is not offered, the words it went with show as sent, and the
 *    PR's page offers it;
 *  - words a Send did not send lost: typed after that start, or for a PR another thread has (it opens with them in
 *    its reply box, unsent); a tie over another thread's PR;
 *  - a PR another window gave to a thread first getting a second thread: Send opens that one and says so;
 *  - Send not pale while the box is empty; the words not cleared once sent; a skills block when the words name none;
 *  - the keys: an IME's Enter or Escape acting, Escape leaving while the `/` list is open, focus not back on Start a
 *    thread after leaving;
 *  - no agent able to take the thread said only after typing;
 *  - an ended agent's refusal talking about a draft.
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
const { forgetPullThreadStarts } = (hasDom ? await import('./threadStarts') : {}) as typeof import('./threadStarts');
const { resetSkillCatalogCache } = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');
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
/** How many of the next ties (`pulls/owner` with a thread) fail. */
let tieFails = 0;
/** The thread the check says the PR is already given to (another window's). */
let ownerNow: string | null = null;
/** The live sessions the Inbox lists in the PR's project, and whether an agent can start there. */
let liveHere = ['ses_web'];
let canLaunch = true;

beforeEach(() => {
  if (!hasDom) return;
  went.length = 0;
  posts = [];
  reloads = 0;
  startFails = 0;
  hold = null;
  tieFails = 0;
  ownerNow = null;
  liveHere = ['ses_web'];
  canLaunch = true;
  forgetPullThreadStarts();
  resetSkillCatalogCache();
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
      if (url.pathname.endsWith('/pulls/owner')) {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        if (body.validate_only) return Response.json({ ok: true, owner: ownerNow });
        if (tieFails > 0) {
          tieFails -= 1;
          return Response.json({ error: 'The Inbox could not save it.', code: 'error' }, { status: 500 });
        }
      }
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/api/inbox/sessions')) {
      return Response.json({
        serverSession: 's',
        home: '/home/dana',
        projects: [
          { project: { id: 'prj_web', name: 'web-app', root: '/home/dana/web-app' }, sessions: liveHere.map(liveSession) },
          { project: { id: 'prj_other', name: 'billing', root: '/home/dana/billing' }, sessions: [liveSession('ses_billing')] },
        ],
        launch: { agents: canLaunch ? [{ agent: 'claude-code', name: 'Claude Code' }] : [], projects: [{ id: 'prj_web', name: 'web-app', root: '/home/dana/web-app', exists: true }, { id: 'prj_other', name: 'billing', root: '/home/dana/billing', exists: true }] },
      });
    }
    if (url.pathname.endsWith('/api/skills')) return Response.json({ skills: [{ name: 'review-curate', root: 'plannotator', humanOnly: true }] });
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
  // A frame's work (focus back on Start a thread) runs too: nothing is left pending past the test.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
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
    onOpenThread: (thread, replace, reply) => went.push(`thread ${thread}${replace ? ' in place' : ''}${reply === true ? ', reply open' : typeof reply === 'string' ? `, reply: ${reply}` : ''}`),
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
  // The thread opens in place of the page with its reply box open (the mock), and the words sent are gone.
  expect(went).toEqual(['thread thr_new in place, reply open']);
  expect(reloads).toBe(1);
  act(() => root!.unmount());
  host!.remove();
  await start();
  expect(field().value).toBe('');
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
  expect(went).toEqual(['thread thr_new in place, reply open']);
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
  // A guided review asked in the PR's thread keeps it the PR's page (the server's `page` mark).
  act(() => root!.unmount());
  host!.remove();
  mount(answer({ [single.key]: { ...link, ask: 'guide', page: true } }));
  await settle();
  expect(went).toEqual(['thread thr_pr in place']);
});

test.skipIf(!hasDom)("a stack's page whose thread started from a layer's page asked for nothing: its thread line never says a guided review is on its way", async () => {
  const link: InboxPullLink = { via: 'owner', ask: 'thread', page: true, thread_id: 'thr_pr', thread_subject: 'Review #880', project_id: 'prj_web', agent: { host: 'claude-code', session: 'ses_web', name: null }, last: null, guide: null };
  const upper: InboxPull = { ...single, key: `github.com/${REPO}#881`, number: 881, url: `https://github.com/${REPO}/pull/881`, base: 'fix/rtl', head: 'fix/rtl-2' };
  mount({ ...answer({ [single.key]: link }), pulls: [single, upper] }, { stackId: inboxPullStacks([single, upper])[0]!.id });
  await settle();
  expect(went).toEqual([]);
  expect($('[data-pulls-thread-line]')!.getAttribute('data-pulls-thread-line')).toBe('live');
  expect(document.body.textContent!.includes('on the way')).toBe(false);
});

test.skipIf(!hasDom)("a phone: the same empty thread, To as the box's agent control with its sheet", async () => {
  await start({ phone: true });
  expect(!!$('[data-pull-thread-start]')).toBe(true);
  const control = $('[data-pull-thread-start] [data-recipient]')!;
  expect(control.getAttribute('data-recipient-chosen')).toBe('ses_web');
  await click('[data-pull-thread-start] [data-recipient]');
  expect([...document.querySelectorAll('[data-recipient-list] [data-recipient-row]')].map((row) => row.getAttribute('data-recipient-row'))).toEqual(['ses_web', 'new:claude-code:prj_web']);
  // The sheet names a new thread's first message, not a reply.
  expect(document.body.textContent!.includes('Who gets this message') && !document.body.textContent!.includes('Who gets this reply')).toBe(true);
  // One recipient only: the sheet's list is no multi-select, and the control's name says message.
  expect(document.querySelector('[data-recipient-list] [role="listbox"]')!.hasAttribute('aria-multiselectable')).toBe(false);
  expect(control.getAttribute('aria-label')!.startsWith('Message goes to ')).toBe(true);
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

const ties = () => posts.filter((p) => p.path.endsWith('/pulls/owner') && !p.body.validate_only);

test.skipIf(!hasDom)("a thread that started but isn't tied is never started again: edited words, or the page left and opened again only tie it, and To is not offered; the words it went with show as sent, and what was typed after reaches the thread's box unsent", async () => {
  await start();
  await type(ASK);
  tieFails = 3;
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(1);
  expect($('[data-pull-thread-error]')!.textContent!.startsWith('The thread started, but it isn’t tied to this pull request yet. Press Send again to tie it.')).toBe(true);
  // The words that went are shown as sent, out of the box; the box is for anything more.
  expect($('[data-pull-thread-sent] p')!.textContent).toBe(ASK);
  expect(field().value).toBe('');
  expect(field().placeholder).toBe('Anything more you write goes into the thread’s reply box, not sent.');
  // To is not offered: a Send now only ties, and goes to no agent.
  expect(!!$('[data-pull-thread-start] [data-recipient]')).toBe(false);
  // Edited words, twice: ties, no start.
  await type('And the tests?');
  await click('[data-pull-thread-start] [data-reply-send]');
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(1);
  expect(ties().map((p) => p.body.thread_id)).toEqual(['thr_new', 'thr_new', 'thr_new']);
  expect(field().value).toBe('And the tests?');
  // Left and opened again: the PR's page offers the thread, and the empty thread says so at once.
  await escape();
  expect($('[data-launch-line="untied-thread"] .ib-lp-line-t')!.textContent).toBe('A thread started here, but it isn’t tied to this pull request yet.');
  await click('[data-launch-line="untied-thread"]');
  expect(went).toEqual(['thread thr_new']);
  act(() => root!.unmount());
  host!.remove();
  await start();
  expect(!!$('[data-pull-thread-error]') && $('[data-pull-thread-sent] p')!.textContent === ASK).toBe(true);
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(1);
  expect(ties()).toHaveLength(4);
  // The words typed after the start were never sent: they open in the thread's reply box, unsent.
  expect(went).toEqual(['thread thr_new', 'thread thr_new in place, reply: And the tests?']);
});

test.skipIf(!hasDom)("tying needs no agent: with none left, a Send that only ties still goes", async () => {
  await start();
  await type(ASK);
  tieFails = 1;
  await click('[data-pull-thread-start] [data-reply-send]');
  act(() => root!.unmount());
  host!.remove();
  liveHere = [];
  canLaunch = false;
  await start();
  const button = $<HTMLButtonElement>('[data-pull-thread-start] [data-reply-send]')!;
  expect(button.disabled).toBe(false);
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(1);
  expect(ties().map((p) => p.body.thread_id)).toEqual(['thr_new', 'thr_new']);
  expect(went).toEqual(['thread thr_new in place, reply open']);
});

test.skipIf(!hasDom)("a PR given to another thread while this page's thread wasn't tied: no tie over it; that thread opens with the new words unsent, and the toast says both", async () => {
  const toasts: string[] = [];
  await start({ onToast: (toast) => toasts.push(`${toast.lead}: ${toast.detail}`) });
  await type(ASK);
  tieFails = 1;
  await click('[data-pull-thread-start] [data-reply-send]');
  await type('And the tests?');
  ownerNow = 'thr_other';
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(1);
  expect(ties()).toHaveLength(1);
  expect(went).toEqual(['thread thr_other in place, reply: And the tests?']);
  expect(toasts).toEqual(['Already has a thread: This pull request was given to another thread before yours was tied to it. That thread is open, with your new words in its reply box, not sent; yours stays in the Inbox.']);
});

test.skipIf(!hasDom)('a PR another window gave to a thread first: Send starts nothing and opens that thread with the words in its reply box, unsent, saying so', async () => {
  const toasts: string[] = [];
  await start({ onToast: (toast) => toasts.push(`${toast.lead}: ${toast.detail}`) });
  await type(ASK);
  ownerNow = 'thr_other';
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(0);
  expect(ties()).toHaveLength(0);
  expect(went).toEqual([`thread thr_other in place, reply: ${ASK}`]);
  expect(toasts).toEqual(['Already has a thread: This pull request already has a thread, so nothing new started. That thread is open, with your words in its reply box, not sent.']);
});

test.skipIf(!hasDom)('Send is pale while the box is empty; words of spaces only say to write first', async () => {
  await start();
  const button = () => $<HTMLButtonElement>('[data-pull-thread-start] [data-reply-send]')!;
  expect(button().disabled).toBe(true);
  await type('   ');
  expect(button().disabled).toBe(false);
  await click('[data-pull-thread-start] [data-reply-send]');
  expect($('[data-pull-thread-error]')!.textContent).toBe('Write a message first.');
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)('the skills block goes only when the words name a skill', async () => {
  await start();
  await type('Use /review-curate on the date grid only.');
  await click('[data-pull-thread-start] [data-reply-send]');
  const named = String(sends()[0]!.body.body);
  const plain = pullThreadMessage(inboxPullStacks([single])[0]!, 'Use /review-curate on the date grid only.');
  expect(named.startsWith(plain) && named.length > plain.length + 100).toBe(true);
  act(() => root!.unmount());
  host!.remove();
  forgetPullThreadStarts();
  posts = [];
  await start();
  await type(ASK);
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()[0]!.body.body).toBe(pullThreadMessage(inboxPullStacks([single])[0]!, ASK));
});

test.skipIf(!hasDom)("the keys: an IME's Enter and Escape are its own; Escape closes the / list first, then leaves, focus back on Start a thread", async () => {
  await start();
  await type(ASK);
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
  });
  await settle();
  expect(!!$('[data-pull-thread-start]') && posts.length === 0).toBe(true);
  // A bare `/` opens the skill list: the first Escape closes it alone, the next leaves.
  await act(async () => {
    const el = field();
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, 'Look at this. /');
    el.selectionStart = el.selectionEnd = el.value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: '/', bubbles: true }));
  });
  await settle();
  expect(!!document.querySelector('[data-skill-menu]')).toBe(true);
  await escape();
  expect(!!$('[data-pull-thread-start]') && !document.querySelector('[data-skill-menu]')).toBe(true);
  await escape();
  expect(!!$('[data-launchpad]')).toBe(true);
  expect(document.activeElement === $('[data-launch-go="start-thread"]')).toBe(true);
});

test.skipIf(!hasDom)('no agent can take the thread: said before any typing, and Send stays off', async () => {
  liveHere = [];
  canLaunch = false;
  await start();
  expect($('[data-pull-thread-empty]')!.textContent).toBe('No agent is running in this project, and none can start here. Start one, then come back.');
  await type(ASK);
  expect($<HTMLButtonElement>('[data-pull-thread-start] [data-reply-send]')!.disabled).toBe(true);
});

test.skipIf(!hasDom)('an agent that ended before the Send: nothing sent, no word of a draft', async () => {
  await start();
  await type(ASK);
  startFails = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/inbox/messages')) return Response.json({ error: 'That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.', code: 'session_not_live' }, { status: 409 });
    return saved(input, init);
  }) as typeof fetch;
  await click('[data-pull-thread-start] [data-reply-send]');
  globalThis.fetch = saved;
  expect($('[data-pull-thread-error]')!.textContent).toBe('That agent isn’t running any more, so nothing was sent. Pick another in To.');
});

test.skipIf(!hasDom)("a press again after a failed start, once the PR list reloaded with new details, sends the same body under the same key (never refused as a reused key)", async () => {
  await start();
  await type(ASK);
  startFails = 1;
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(!!$('[data-pull-thread-error]')).toBe(true);
  act(() => root!.unmount());
  host!.remove();
  mount({ ...answer(), pulls: [{ ...single, title: 'Fix RTL in the date picker and the calendar', additions: 160 }] });
  await settle();
  await click('[data-launch-go="start-thread"]');
  await click('[data-pull-thread-start] [data-reply-send]');
  expect(sends()).toHaveLength(2);
  expect(sends()[1]!.body.idempotency_key).toBe(sends()[0]!.body.idempotency_key);
  expect(sends()[1]!.body.body).toBe(sends()[0]!.body.body);
  expect(sends()[1]!.body.thread_name).toBe(sends()[0]!.body.thread_name);
});
