/**
 * One PR's launchpad (approval "pr-launchpad"), in the window, with the Inbox's doors stubbed at `fetch`. What regresses:
 *  - a single open PR opening the stack page, or a stack of several opening the launchpad;
 *  - a door going anywhere but its own place: the guided review (its thread and message), the PR's diff (this layer),
 *    the review thread, the Shape board;
 *  - Start a guided review missing when there is none and a thread can start, not opening the picker, or offered beside
 *    a live thread (one review thread at a time);
 *  - the Shape board door offering a board that is not there, or showing while Shape is off;
 *  - the details panel drawing its own head (author, branches, Close) under the page's.
 *
 * Element checks are booleans: a failing match on a happy-dom node prints the whole window.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { InboxShapeSummary } from '../api';
import type { PullsPageProps } from './PullsPage';

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

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const went: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  went.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/home/dana', projects: [] });
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

function mount(stackId: string, model: InboxPullsAnswer, extra: Partial<PullsPageProps> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const props: PullsPageProps = {
    state: { model, error: null, loading: false, refresh: () => {}, reload: () => {} },
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
    onLaunch: () => {},
    onStarted: () => {},
    onOpenGuide: (thread, message) => went.push(`guide ${thread} ${message}`),
    onOpenShape: (shape) => went.push(`shape ${shape.id}`),
    ...extra,
  };
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

test.skipIf(!hasDom)("each door goes to its own place: the guide's message, this PR's diff, the review thread, its Shape board", async () => {
  mount(single.key, answer({ [single.key]: live }), { shapes: new Map([[live.thread_id, board]]) });
  await settle();
  await click('[data-launch-go="guide"]');
  await click('[data-launch-go="diff"]');
  await click('[data-launch-go="thread"]');
  await click('[data-launch-go="shape"]');
  expect(went).toEqual([`guide thr_review msg_guide`, `diff ${single.key} ${single.key} layer`, 'thread thr_review', 'shape shp_1']);
  // A guide is there: nothing to start, and no picker.
  expect(!!$('[data-launch-go="start"]')).toBe(false);
});

test.skipIf(!hasDom)('no guided review and no thread: Start a guided review opens the picker; nothing starts until a pick', async () => {
  mount(single.key, answer());
  await settle();
  const start = $<HTMLButtonElement>('[data-launch-door="guide"] [data-launch-go="start"]')!;
  expect(start.getAttribute('aria-expanded')).toBe('false');
  expect(!!$('[data-pulls-picker]')).toBe(false);
  await click('[data-launch-go="start"]');
  expect(start.getAttribute('aria-expanded')).toBe('true');
  expect(!!$('[data-launch-door="guide"] [data-pulls-picker]')).toBe(true);
  // No thread yet: the Review thread door has nothing to open.
  expect(!!$('[data-launch-go="thread"]')).toBe(false);
  expect(went).toEqual([]);
});

test.skipIf(!hasDom)("a live thread with no guide yet: no second thread to start; its agent's thread opens from its door", async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null } }));
  await settle();
  expect(!!$('[data-launch-go="start"]')).toBe(false);
  expect(!!$('[data-launch-go="guide"]')).toBe(false);
  await click('[data-launch-go="thread"]');
  expect(went).toEqual(['thread thr_review']);
});

test.skipIf(!hasDom)('an agent that ended with no guide: Start a guided review is offered again', async () => {
  mount(single.key, answer({ [single.key]: { ...live, guide: null, agent: { ...live.agent!, ended: true } } }));
  await settle();
  expect($('[data-launch-go="start"]')!.getAttribute('data-pulls-primary')).toBe('again');
});

test.skipIf(!hasDom)('Shape on with no board for this thread: the door, with nothing to open; Shape off: no door', async () => {
  mount(single.key, answer({ [single.key]: live }), { shapes: new Map() });
  await settle();
  expect(!!$('[data-launch-door="shape"]')).toBe(true);
  expect(!!$('[data-launch-go="shape"]')).toBe(false);
  act(() => root!.unmount());
  host!.remove();
  mount(single.key, answer({ [single.key]: live }));
  await settle();
  expect(!!$('[data-launch-door="shape"]')).toBe(false);
  expect(!!$('[data-launch-door="system"]')).toBe(true);
});

test.skipIf(!hasDom)("the details sit in the page under its own heading: no head of their own, no Close", async () => {
  mount(single.key, answer());
  await settle();
  const details = $('[data-launchpad] [data-pull-details]')!;
  expect(!!details).toBe(true);
  expect(!!details.querySelector('.ib-prd-head')).toBe(false);
  expect(!!details.querySelector('[data-pull-details-close]')).toBe(false);
});
