/**
 * One PR's launchpad (approval "pr-launchpad"), in the window, with the Inbox's doors stubbed at `fetch`. What regresses:
 *  - a single open PR opening the stack page, or a stack of several opening the launchpad;
 *  - a door going anywhere but its own place: the guided review (its thread and message), the PR's diff (this layer),
 *    the review thread, the Shape board;
 *  - Start a guided review missing when there is none and a thread can start, not opening the New review box filled in
 *    with this PR, or offered beside a live thread (one review thread at a time); an ended agent's guide leaving no way
 *    to start a new one;
 *  - a thread that only named the PR (the Reviews page's rule) taken for its review thread: no way to start one;
 *  - a guide the agent has not sent as a review (`review: false`) counted as one (the stack page's rule);
 *  - the facts losing "by you" on the person's own PR, or "Draft" on a draft;
 *  - the Shape board door offering a board that is not there, or showing while Shape is off; the System door showing
 *    while System does not (both are off in 0.29), or the grid keeping an empty slot for a door that is not there;
 *  - a Reviews row about one open PR opening anything but its launchpad, also once an agent reviewed it (the owner's
 *    routing answer, 2026-11-09); a local review, a thread of a stack of several, losing its way to the thread;
 *  - the diff card losing the approved words with the PR's file count ("All 70 files with your comments, Viewed and
 *    Approve."), or reading "All 1 files" / "All 0 files";
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
import { inboxPullStacks, inboxReviewRows, type InboxPull, type InboxPullLink, type InboxPullsAnswer, type InboxReviewThread } from '@plannotator/core/inbox-types';
import type { InboxShapeSummary } from '../api';
import type { PullsPageProps, PullsSystem } from './PullsPage';
import { pullsStateOf } from './reviewsTestState';

const hasDom = typeof document !== 'undefined';
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

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

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const went: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  went.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      if (url.pathname.endsWith('/api/inbox/messages')) return Response.json({ thread_id: 'thr_new', message: {}, replayed: false });
      return Response.json({ ok: true });
    }
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
    onNewReview: (pick, opener) => went.push(`new review ${pick.id} ${pick.thread ? 'in review' : 'none'} ${opener.getAttribute('data-launch-go')}`),
    onOpenGuide: (thread, message) => went.push(`guide ${thread} ${message}`),
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

test.skipIf(!hasDom)("each door goes to its own place: the guide's message, this PR's diff, the review thread, its Shape board", async () => {
  mount(single.key, answer({ [single.key]: live }), { shapes: new Map([[live.thread_id, board]]) });
  await settle();
  await click('[data-launch-go="guide"]');
  await click('[data-launch-go="diff"]');
  await click('[data-launch-go="thread"]');
  await click('[data-launch-go="shape"]');
  expect(went).toEqual([`guide thr_review msg_guide`, `diff ${single.key} ${single.key} layer`, 'thread thr_review', 'shape shp_1']);
  // A guide is there: nothing to start.
  expect(!!$('[data-launch-go="start"]')).toBe(false);
});

test.skipIf(!hasDom)('no guided review and no thread: Start a guided review opens the New review box filled in with this PR', async () => {
  mount(single.key, answer());
  await settle();
  expect($('[data-launch-door="guide"] [data-launch-go="start"]')!.getAttribute('data-pulls-primary')).toBe('review');
  // No thread yet: the Review thread door has nothing to open.
  expect(!!$('[data-launch-go="thread"]')).toBe(false);
  await click('[data-launch-go="start"]');
  expect(went).toEqual([`new review ${single.key} none start`]);
});

test.skipIf(!hasDom)('a thread that only named the PR is no review thread: a guided review can start, and that thread opens as it is', async () => {
  // The agent's own thread named the PR in a message (`url`): nobody handed it the review.
  mount(single.key, answer({ [single.key]: { ...live, via: 'url', ask: undefined, guide: null } }));
  await settle();
  expect(!!$('[data-launch-go="guide-thread"]')).toBe(false);
  expect($('[data-launch-door="guide"] [data-launch-go="start"]')!.getAttribute('data-pulls-primary')).toBe('review');
  expect($('[data-launch-door="thread"]')!.textContent).toContain('Thread with');
  await click('[data-launch-door="thread"] [data-pulls-open-thread]');
  await click('[data-launch-go="start"]');
  expect(went).toEqual(['thread thr_review', `new review ${single.key} none start`]);
});

test.skipIf(!hasDom)("a live thread with no guide yet: no second thread to start; its thread opens from the wide card and its own", async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null } }));
  await settle();
  expect(!!$('[data-launch-go="start"]')).toBe(false);
  expect(!!$('[data-launch-go="guide"]')).toBe(false);
  expect($('[data-launch-door="guide"] [data-launch-go="guide-thread"]')!.getAttribute('data-pulls-primary')).toBe('open');
  await click('[data-launch-go="guide-thread"]');
  await click('[data-launch-go="thread"]');
  expect(went).toEqual(['thread thr_review', 'thread thr_review']);
});

test.skipIf(!hasDom)('a guide the agent did not send as a review is none yet (the stack page rule)', async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: { ...live.guide!, review: false } } }));
  await settle();
  expect(!!$('[data-launch-go="guide"]')).toBe(false);
  expect(!!$('[data-launch-go="guide-thread"]')).toBe(true);
});

test.skipIf(!hasDom)("an agent that ended after its guide: the guide opens, and a new guided review can start from the New review box", async () => {
  mount(single.key, answer({ [single.key]: { ...live, agent: { ...live.agent!, ended: true } } }));
  await settle();
  const open = $('[data-launch-door="guide"] [data-launch-go="guide"]')!;
  const again = $<HTMLButtonElement>('[data-launch-door="guide"] [data-launch-go="start"]')!;
  expect(open.classList.contains('ib-pri')).toBe(true);
  expect(again.classList.contains('ib-pri')).toBe(false);
  expect(again.getAttribute('data-pulls-primary')).toBe('again');
  await click('[data-launch-go="start"]');
  await click('[data-launch-go="guide"]');
  expect(went).toEqual([`new review ${single.key} none start`, 'guide thr_review msg_guide']);
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

test.skipIf(!hasDom)('an agent that ended with no guide: Start a guided review is offered again', async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null, agent: { ...live.agent!, ended: true } } }));
  await settle();
  expect($('[data-launch-go="start"]')!.getAttribute('data-pulls-primary')).toBe('again');
});

const systemOn: PullsSystem = { projects: [], open: null, sheet: null, full: false, onOpen: () => {}, onSheet: () => {}, onFull: () => {}, onMenu: () => {} };
const doors = () => [...document.querySelectorAll('[data-launch-door]')].map((door) => door.getAttribute('data-launch-door'));

test.skipIf(!hasDom)('Shape and System off (0.29): three doors and a grid laid out for three; each comes back with its switch', async () => {
  const draw = async (extra: Partial<PullsPageProps>) => {
    act(() => root?.unmount());
    host?.remove();
    mount(single.key, answer({ [single.key]: live }), extra);
    await settle();
  };
  await draw({});
  expect(doors()).toEqual(['guide', 'diff', 'thread']);
  expect($('.ib-lp-grid')!.getAttribute('data-doors')).toBe('3');
  // Shape on, with no board for this thread: the door, with nothing to open.
  await draw({ shapes: new Map() });
  expect(doors()).toEqual(['guide', 'diff', 'thread', 'shape']);
  expect($('.ib-lp-grid')!.getAttribute('data-doors')).toBe('4');
  expect(!!$('[data-launch-go="shape"]')).toBe(false);
  await draw({ system: systemOn });
  expect(doors()).toEqual(['guide', 'diff', 'thread', 'system']);
  expect($('.ib-lp-grid')!.getAttribute('data-doors')).toBe('4');
  await draw({ shapes: new Map(), system: systemOn });
  expect(doors()).toEqual(['guide', 'diff', 'thread', 'shape', 'system']);
  expect($('.ib-lp-grid')!.getAttribute('data-doors')).toBe('5');
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

test.skipIf(!hasDom)('the diff card says the approved words with the file count: All N files, the one file, or all files when the count is unknown', async () => {
  const { diffWords } = await import('./PullLaunchpad');
  mount(single.key, answer());
  await settle();
  expect($('[data-launch-door="diff"] .ib-lp-sub')!.textContent).toBe('All 2 files with your comments, Viewed and Approve.');
  expect(diffWords(70)).toBe('All 70 files with your comments, Viewed and Approve.');
  expect(diffWords(1)).toBe('The one file with your comments, Viewed and Approve.');
  expect(diffWords(0)).toBe('All files with your comments, Viewed and Approve.');
});
