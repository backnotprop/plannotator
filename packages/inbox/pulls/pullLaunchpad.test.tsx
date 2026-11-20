/**
 * One PR's launchpad, in the window, with the Inbox stubbed at `fetch`. What regresses:
 *  - a single open PR opening the stack page, or a stack of several opening the launchpad;
 *  - an action missing from the one row of buttons, or going anywhere but its own place: the PR's diff (this layer, the
 *    one primary), Guided review and Picture it (the New review box filled in with this PR while no live thread is
 *    about it; one reply in the live thread otherwise), Start a thread (only while no thread is about the PR), the
 *    Shape board (only while Shape is on and the thread has one);
 *  - a line for what was made missing, or opening anything but its own place: the Picture page beside its thread, the
 *    guide's message, the thread; the agent's words while one is on its way, and when it stopped without one;
 *  - a thread that only named the PR (the Reviews page's rule) taken for its review thread;
 *  - a guide the agent has not sent as a review (`review: false`) counted as one (the stack page's rule);
 *  - the facts losing "by you" on the person's own PR, or "Draft" on a draft;
 *  - a Reviews row about one open PR opening anything but its launchpad, also once an agent reviewed it (the owner's
 *    routing answer, 2026-11-09); a thread of a stack of several losing its way to the thread;
 *  - the details panel drawing its own head (author, branches, Close) under the page's;
 *  - a PR pane covering the list (stack.ts) with no way back to it but Close, unlike a covering thread's ‹ Inbox;
 *  - a phone's bar keeping `‹ Reviews` whole when the PR's number and repository have no room (a thread's
 *    header gives way the same, headFit.ts);
 *  - the stack page's Your review pill leaving its PR's number for the row's end (owner, q-f4030127).
 *
 * Element checks are booleans: a failing match on a happy-dom node prints the whole window.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, inboxReviewRows, type InboxMessageWire, type InboxPull, type InboxPullLink, type InboxPullsAnswer, type InboxReviewThread, type InboxThread } from '@plannotator/core/inbox-types';
import type { InboxShapeSummary } from '../api';
import type { PullsPageProps } from './PullsPage';
import { pullsStateOf } from './reviewsTestState';
import { REVIEW_ROW_AUTO_STOPPED } from './reviewsModel';

const hasDom = typeof document !== 'undefined';
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { forgetPictureItRequests, pictureItWords } = (hasDom ? await import('./usePictureItAsk') : {}) as typeof import('./usePictureItAsk');
const { forgetPullGuideRequests, pullThreadGuideWords } = (hasDom ? await import('./usePullThreadGuide') : {}) as typeof import('./usePullThreadGuide');

const REPO = 'northwind/web-app';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  return {
    key: `github.com/${REPO}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    author: 'tomas',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: REPO,
    additions: 3,
    deletions: 1,
    files: 2,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'failure',
    updated_at: '2026-11-03T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const single = pull(880);
// A stack of two: #901 into main, #902 on #901's branch.
const low = pull(901, { head: 'retry/schedule', mine: true, requested: false, author: 'dana' });
const high = pull(902, { head: 'retry/backoff', base: 'retry/schedule', mine: true, requested: false, author: 'dana' });

const live: InboxPullLink = {
  via: 'owner',
  ask: 'guide',
  thread_id: 'thr_review',
  thread_subject: 'Review #880',
  project_id: 'prj_web',
  agent: { host: 'claude-code', session: 'ses_web', name: null },
  last: { message_id: 'msg_last', preview: 'A guided review of #880.', at: '2026-11-03T09:10:00.000Z' },
  guide: { message_id: 'msg_guide', title: 'The RTL fix', steps: 3, review: true },
};

function answer(links: Record<string, InboxPullLink> = {}): InboxPullsAnswer {
  return {
    fetched_at: '2026-11-03T09:30:00.000Z',
    hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
    pulls: [single, low, high],
    links,
    projects: { [`github.com/${REPO}`]: ['prj_web'] },
    cards: {},
  };
}

const board: InboxShapeSummary = {
  id: 'shp_1',
  title: 'RTL, drawn',
  project: { name: 'web-app', root: '/home/dana/web-app' },
  thread: 'thr_review',
  state: 'active',
  updated: '2026-11-03T09:20:00.000Z',
  latest: 2,
  seen: 2,
  changed: false,
  drawing: false,
  waiting: 0,
  session: null,
};

const liveSession = (session: string) => ({ session, host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:29:00.000Z', busy: false, idle_since: null, last_thread: null });

const asked = { id: 'msg_ask', project_id: 'prj_web', thread_id: 'thr_review', reply_to: null, author: { kind: 'person' }, subject: 'Review #880', subject_question: null, body: 'Review it.', created_at: '2026-11-03T09:00:00.000Z', resolved_at: null, idempotency_key: 'k', to: { host: 'claude-code', session: 'ses_web' } } as unknown as InboxMessageWire;
const agentSays = (id: string, fields: Record<string, unknown> = {}) => ({ ...asked, id, reply_to: 'msg_ask', author: { kind: 'agent', host: 'claude-code', session: 'ses_web', name: 'Claude Code' }, body: 'Here.', to: undefined, wakes: true, created_at: '2026-11-03T09:10:00.000Z', ...fields }) as unknown as InboxMessageWire;
const pictureMessage = agentSays('msg_page', { picture_it: { attachment_id: 'att_page', title: 'Late notes are offered' }, created_at: '2026-11-03T09:20:00.000Z' });
let threadMessages: InboxMessageWire[] = [];
const reviewThread = (): InboxThread => ({ thread_id: 'thr_review', project: { id: 'prj_web', key: 'web-app', name: 'web-app', root: '/home/dana/web-app', created_at: '2026-11-01T09:00:00.000Z' }, subject: 'Review #880', thread_name: 'Review #880', resolved_at: null, messages: threadMessages }) as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const went: string[] = [];
let posts: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  went.length = 0;
  posts = [];
  threadMessages = [asked, agentSays('msg_guide', { guide: { title: 'The RTL fix' } }), agentSays('msg_last')];
  forgetPictureItRequests();
  forgetPullGuideRequests();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      posts.push({ path: url.pathname.replace(/^.*\/api\/inbox/, ''), body: JSON.parse(String(init.body ?? '{}')) });
      if (url.pathname.endsWith('/api/inbox/messages')) return Response.json({ thread_id: 'thr_new', message: {}, replayed: false });
      if (url.pathname.endsWith('/reply')) return Response.json({ message: { id: 'msg_reply' }, replayed: false });
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/api/skills')) return Response.json({ skills: [] });
    if (url.pathname.endsWith('/api/inbox/threads/thr_review')) return Response.json({ serverSession: 's', cursor: 1, thread: reviewThread() });
    if (url.pathname.endsWith('/api/inbox/sessions')) {
      return Response.json({ serverSession: 's', home: '/home/dana', projects: [{ project: { id: 'prj_web', name: 'web-app', root: '/home/dana/web-app' }, sessions: [liveSession('ses_web')] }] });
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

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function page(stackId: string, model: InboxPullsAnswer, extra: Partial<PullsPageProps> = {}) {
  const props: PullsPageProps = {
    // The rows as the server's rule makes them: a PR handed to a thread is in review there, one a thread only named is not.
    state: pullsStateOf(model),
    stackId,
    project: null,
    filter: 'all',
    projects: [],
    projectNames: new Map(),
    phone: false,
    onOpenStack: () => {},
    onScope: () => {},
    onReview: (stack, key, scope) => went.push(`diff ${stack} ${key} ${scope}`),
    onOpenThread: (thread) => went.push(`thread ${thread}`),
    onNew: () => went.push('new'),
    onNewReview: (pick, opener, ask) => went.push(`new review ${pick.id} ${pick.thread ? 'in review' : 'none'} ${opener.getAttribute('data-launch-go')}${ask ? ` ${ask}` : ''}`),
    onOpenGuide: (thread, message) => went.push(`guide ${thread} ${message}`),
    onOpenPicture: (thread, attachment, message) => went.push(`picture ${thread} ${attachment} ${message}`),
    onOpenShape: (shape) => went.push(`shape ${shape.id}`),
    ...extra,
  };
  return (
    <SidebarProvider>
      <div className="pn-inbox">
        <PullsPage {...props} />
      </div>
    </SidebarProvider>
  );
}

function mount(stackId: string, model: InboxPullsAnswer, extra: Partial<PullsPageProps> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(page(stackId, model, extra));
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = async (selector: string) => {
  await act(async () => $(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
};

test.skipIf(!hasDom)('one open PR opens its launchpad; a stack of several keeps the stack page', async () => {
  mount(single.key, answer());
  await settle();
  expect(!!$('[data-launchpad]')).toBe(true);
  expect(!!$('.ib-pr-ladder')).toBe(false);
  act(() => root!.unmount());
  host!.remove();
  mount(high.key, answer());
  await settle();
  expect(!!$('[data-launchpad]')).toBe(false);
  expect(document.querySelectorAll('[data-pulls-layer]')).toHaveLength(2);
});

test.skipIf(!hasDom)("a phone's bar short of room shows ‹ Reviews as its chevron alone, as a thread's ‹ Inbox; with room, the word", async () => {
  // happy-dom draws no boxes: the bar is `width` wide, its number and repository take what the way back leaves.
  const real = Element.prototype.getBoundingClientRect;
  let width = 320;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const bar = this.closest('.ib-pr-bar');
    const chevronAlone = bar?.getAttribute('data-fit')?.split(' ').includes('back') ?? false;
    const w = this.classList.contains('ib-pr-bar') ? width : this.hasAttribute('data-fit-subject') ? width - (chevronAlone ? 150 : 230) : this.classList.contains('ib-pback-l') && !chevronAlone ? 70 : 0;
    return { left: 0, right: w, width: w, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  try {
    mount(single.key, answer(), { phone: true });
    await settle();
    const bar = $('.ib-pr-bar')!;
    expect(!!bar.querySelector('[data-phone-back][aria-label="Back to Reviews"]')).toBe(true);
    expect((bar.getAttribute('data-fit') ?? '').split(' ').includes('back')).toBe(true);
    act(() => root!.unmount());
    host!.remove();
    width = 420;
    mount(single.key, answer(), { phone: true });
    await settle();
    expect($('.ib-pr-bar')!.hasAttribute('data-fit')).toBe(false);
  } finally {
    Element.prototype.getBoundingClientRect = real;
  }
});

test.skipIf(!hasDom)("the stack page's Your review pill sits beside its PR's number, not alone at the row's end", async () => {
  mount(high.key, answer());
  await settle();
  const rows = [...document.querySelectorAll('[data-pulls-layer]')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const pill = [...row.querySelectorAll('.ib-pr-pill')].find((p) => p.textContent === 'Your review');
    expect(!!pill).toBe(true);
    expect(pill!.previousElementSibling?.classList.contains('ib-pr-num') === true).toBe(true);
  }
});

test.skipIf(!hasDom)('covering the list (a window too narrow for both), the PR pane leads with ‹ Reviews and has no Close, as a covering thread', async () => {
  for (const id of [single.key, high.key]) {
    const closed: (string | null)[] = [];
    mount(id, answer(), { stacked: true, onOpenStack: (to) => closed.push(to) });
    await settle();
    expect(!!$('.ib-pr-bar [data-stack-back]')).toBe(true);
    expect(!!$('.ib-pr-bar [aria-label="Close"], .ib-pr-bar [aria-label="Close the stack"]')).toBe(false);
    await click('.ib-pr-bar [data-stack-back]');
    expect(closed).toEqual([null]);
    act(() => root!.unmount());
    host!.remove();
    // Beside the list: Close, and no way back (the list is in sight).
    mount(id, answer());
    await settle();
    expect(!!$('.ib-pr-bar [data-stack-back]')).toBe(false);
    expect(!!$('.ib-pr-bar [aria-label="Close"], .ib-pr-bar [aria-label="Close the stack"]')).toBe(true);
    act(() => root!.unmount());
    host!.remove();
  }
  root = null;
  host = null;
});

const row = () => [...document.querySelectorAll('[data-launch-row] button')].map((button) => button.getAttribute('data-launch-go'));
const lines = () => [...document.querySelectorAll('[data-launch-line]')].map((line) => line.getAttribute('data-launch-line'));
const line = (kind: string) => $(`[data-launch-line="${kind}"]`)!.textContent!;
const pictureLink: InboxPullLink = { ...live, picture_it_asked_at: '2026-11-03T09:05:00.000Z', picture_it_page: { message_id: 'msg_page', title: 'Late notes are offered', at: '2026-11-03T09:20:00.000Z' } };

test.skipIf(!hasDom)('no thread yet: one row, Open the diff the one primary; Guided review and Picture it open the New review box filled in with this PR, Picture it asking for a page; Start a thread; no lines', async () => {
  mount(single.key, answer());
  await settle();
  expect(row()).toEqual(['diff', 'guide', 'picture', 'start-thread']);
  expect([...document.querySelectorAll('.ib-lp .ib-btn.ib-pri')].map((b) => b.getAttribute('data-launch-go'))).toEqual(['diff']);
  expect(lines()).toEqual([]);
  await click('[data-launch-go="diff"]');
  await click('[data-launch-go="guide"]');
  await click('[data-launch-go="picture"]');
  expect(went).toEqual([`diff ${single.key} ${single.key} layer`, `new review ${single.key} none guide`, `new review ${single.key} none picture picture_it`]);
  await click('[data-launch-go="start-thread"]');
  expect(!!$('[data-launchpad]')).toBe(false);
  expect(!!$('[data-pull-thread-start]')).toBe(true);
});

test.skipIf(!hasDom)('a live thread with a guide and a Picture page: each line opens its own place, Start a thread leaves the row, the Shape board joins it', async () => {
  threadMessages = [...threadMessages, pictureMessage];
  mount(single.key, answer({ [single.key]: pictureLink }), { shapes: new Map([[live.thread_id, board]]) });
  await settle();
  expect(row()).toEqual(['diff', 'guide', 'picture', 'shape']);
  expect(lines()).toEqual(['picture', 'guide', 'thread']);
  expect(line('picture')).toContain('Late notes are offered');
  expect(line('guide')).toContain('The RTL fix');
  expect(line('thread')).toContain('“A guided review of #880.”');
  await click('[data-launch-line="picture"]');
  await click('[data-launch-line="guide"]');
  await click('[data-launch-line="thread"]');
  await click('[data-launch-go="shape"]');
  expect(went).toEqual(['picture thr_review att_page msg_page', 'guide thr_review msg_guide', 'thread thr_review', 'shape shp_1']);
});

test.skipIf(!hasDom)('a live thread: Picture it and Guided review each ask once in that thread, the PR is told, and the lines say the agent is making them', async () => {
  mount(single.key, answer({ [single.key]: live }));
  await settle();
  await click('[data-launch-go="picture"]');
  await click('[data-launch-go="guide"]');
  const stack = inboxPullStacks([single])[0]!;
  const replies = posts.filter((post) => post.path.endsWith('/reply'));
  expect(replies.map((post) => post.path)).toEqual(['/messages/msg_last/reply', '/messages/msg_last/reply']);
  expect(String(replies[0]!.body.words).startsWith(pictureItWords({ kind: 'pull', stack, linkThreadId: 'thr_review' }))).toBe(true);
  expect(String(replies[1]!.body.words).startsWith(pullThreadGuideWords(stack))).toBe(true);
  expect(posts.filter((post) => post.path === '/pulls/owner').map((post) => post.body.ask)).toEqual(['picture_it', 'guide']);
  expect(line('picture')).toContain('is making it…');
  expect(line('guide')).toContain('is writing a new one…');
  expect(!!$('[data-launch-go="picture"]:disabled') && !!$('[data-launch-go="guide"]:disabled')).toBe(true);
  expect(went).toEqual([]);
});

test.skipIf(!hasDom)('an agent that ended without what it was asked for: the lines say it stopped, and both asks open the New review box again', async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null, picture_it_asked_at: '2026-11-03T09:05:00.000Z', agent: { ...live.agent!, ended: true } } }));
  await settle();
  expect(line('picture')).toBe('Picture page' + REVIEW_ROW_AUTO_STOPPED.picture_it);
  expect(line('guide')).toBe('Guided review' + REVIEW_ROW_AUTO_STOPPED.guide);
  expect(line('thread')).toContain('ended');
  expect(row()).toEqual(['diff', 'guide', 'picture']);
  await click('[data-launch-go="guide"]');
  await click('[data-launch-go="picture"]');
  expect(went).toEqual([`new review ${single.key} none guide`, `new review ${single.key} none picture picture_it`]);
});

test.skipIf(!hasDom)('a thread that only named the PR is no review thread: the asks open the New review box, and that thread opens as it is', async () => {
  mount(single.key, answer({ [single.key]: { ...live, via: 'url', ask: undefined, guide: null } }));
  await settle();
  expect(lines()).toEqual(['thread']);
  await click('[data-launch-line="thread"]');
  await click('[data-launch-go="guide"]');
  expect(went).toEqual(['thread thr_review', `new review ${single.key} none guide`]);
});

test.skipIf(!hasDom)('a guide on its way says the agent is writing it; one the agent did not send as a review is none yet (the stack page rule)', async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null } }));
  await settle();
  expect(line('guide')).toContain('is writing it…');
  act(() => root!.unmount());
  host!.remove();
  mount(single.key, answer({ [single.key]: { ...live, ask: 'thread', guide: { ...live.guide!, review: false } } }));
  await settle();
  expect(lines()).toEqual(['thread']);
});

test.skipIf(!hasDom)('the facts say "by you" on your own PR and "Draft" on a draft; a teammate\'s ready PR says neither', async () => {
  mount(single.key, { ...answer(), pulls: [{ ...single, mine: true, author: 'dana', state: 'draft' }] });
  await settle();
  const facts = () => $('[data-launch-facts]')!.textContent!;
  expect(facts()).toContain('by you');
  expect(facts()).toContain('Draft');
  act(() => root!.render(page(single.key, answer())));
  await settle();
  expect(facts()).toContain('by tomas');
  expect(facts()).not.toContain('by you');
  expect(facts()).not.toContain('Draft');
});

test.skipIf(!hasDom)('Shape on with no board for the thread: no Shape board button', async () => {
  mount(single.key, answer({ [single.key]: live }), { shapes: new Map() });
  await settle();
  expect(row()).toEqual(['diff', 'guide', 'picture']);
});

test.skipIf(!hasDom)("the details sit in the page under its own heading: no head of their own, no Close", async () => {
  mount(single.key, answer());
  await settle();
  const details = $('[data-launchpad] [data-pull-details]')!;
  expect(!!details).toBe(true);
  expect(!!details.querySelector('.ib-prd-head')).toBe(false);
  expect(!!details.querySelector('[data-pull-details-close]')).toBe(false);
});

/** A thread whose guided review of the PR arrived (`review: true`), as the server's review index has it. */
const reviewed = (thread_id: string): InboxReviewThread => ({
  thread_id,
  project_id: 'prj_web',
  subject: 'Review',
  first_review_id: 'msg_guide',
  latest_review_id: 'msg_guide',
  round: 1,
  title: 'The RTL fix',
  files: 2,
  additions: 3,
  deletions: 1,
  agent: { host: 'claude-code', session: 'ses_web', name: null },
  source: null,
  verdict: null,
  answered: null,
  reviewed_at: '2026-11-03T09:10:00.000Z',
  updated_at: '2026-11-03T09:10:00.000Z',
  resolved_at: null,
});

test.skipIf(!hasDom)("a Reviews row about one open PR opens its launchpad, also once an agent reviewed it; a reviewed stack of several opens its thread", async () => {
  // #880 reviewed in thr_review; the stack #901 + #902 handed to thr_stack and reviewed there.
  const model = answer({ [single.key]: live, [low.key]: { ...live, thread_id: 'thr_stack' }, [high.key]: { ...live, thread_id: 'thr_stack' } });
  const stacks = inboxPullStacks(model.pulls);
  const rows = inboxReviewRows({ threads: [reviewed('thr_review'), reviewed('thr_stack')], stacks, links: model.links, pulls: model.pulls });
  const state = pullsStateOf(model);
  const opened: string[] = [];
  mount('', model, {
    stackId: null,
    state: { ...state, reviews: { ...state.reviews!, rows } },
    onOpenStack: (id) => opened.push(`stack ${id}`),
    onOpenThread: (id) => opened.push(`thread ${id}`),
  });
  await settle();
  const one = stacks.find((stack) => stack.layers.length === 1)!;
  const row = (thread: string) => `[data-reviews-kind="reviewed"][data-row="${thread}"]`;
  expect(!!$(row('thr_review'))).toBe(true);
  await click(row('thr_review'));
  await click(row('thr_stack'));
  expect(opened).toEqual([`stack ${one.id}`, 'thread thr_stack']);
});

const startThreadButton = '[data-launch-row] [data-launch-go="start-thread"]';

test.skipIf(!hasDom)('Start a thread only while no thread is about the PR: a review thread, an ended one, or one that only named it keep their own line', async () => {
  for (const link of [live, { ...live, guide: null }, { ...live, guide: null, agent: { ...live.agent!, ended: true } }, { ...live, via: 'url' as const, ask: undefined, guide: null }]) {
    mount(single.key, answer({ [single.key]: link }));
    await settle();
    expect(!!$(startThreadButton)).toBe(false);
    expect(!!$('[data-launch-line="thread"]')).toBe(true);
    act(() => root!.unmount());
    host!.remove();
  }
});

test.skipIf(!hasDom)('Start a thread on a phone, on a draft and on your own PR; never for a PR in no project', async () => {
  const draftMine: InboxPullsAnswer = { ...answer(), pulls: [{ ...single, state: 'draft', mine: true }, low, high] };
  const cases: [InboxPullsAnswer, Partial<PullsPageProps>][] = [
    [answer(), { phone: true }],
    [draftMine, {}],
  ];
  for (const [model, extra] of cases) {
    mount(single.key, model, extra);
    await settle();
    expect(!!$(startThreadButton)).toBe(true);
    act(() => root!.unmount());
    host!.remove();
  }
  mount(single.key, { ...answer(), projects: {} });
  await settle();
  expect(!!$(startThreadButton)).toBe(false);
});
