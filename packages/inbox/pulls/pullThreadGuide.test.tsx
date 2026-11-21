/**
 * Guided review on a PR's thread (one started from its page: `ReviewContextLine`'s PR line, `usePullThreadGuide`;
 * mock "V1-5"/"V1-6"), with the Inbox's doors stubbed at `fetch`. What regresses:
 *  - Guided review missing from the line before a guide exists, or The diff, or the PR on its forge;
 *  - the ask not going to THIS thread's agent as a reply in this thread (a second thread, another message), without the
 *    hand-off's `/review-curate` step and its skills block, or sent twice on a double press or on a retry after the
 *    link did not change;
 *  - the PR's link not saying a guided review is on its way afterwards (`pulls/owner` with `guide`, this thread), or
 *    changed for another thread's link;
 *  - a guide that is in not opening; "Guided review on the way" not said while one is asked for.
 *
 * Element checks are booleans: a failing match on a happy-dom node prints the whole window.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, inboxReviewRows, type InboxMessageWire, type InboxPull, type InboxPullLink, type InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ReviewContextLine } = (hasDom ? await import('../thread/ReviewContextLine') : {}) as typeof import('../thread/ReviewContextLine');
const { reviewViewOf } = (hasDom ? await import('./reviewsModel') : {}) as typeof import('./reviewsModel');
const { forgetPullGuideRequests, pullThreadGuideWords } = (hasDom ? await import('./usePullThreadGuide') : {}) as typeof import('./usePullThreadGuide');
const { resetSkillCatalogCache } = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const REPO = 'northwind/web-app';
const pull: InboxPull = {
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
const stack = inboxPullStacks([pull])[0]!;
const linkOf = (fields: Partial<InboxPullLink> = {}): InboxPullLink => ({ via: 'owner', ask: 'thread', page: true, thread_id: 'thr_pr', thread_subject: 'Review #880', project_id: 'prj_web', agent: { host: 'claude-code', session: 'ses_web', name: null }, last: null, guide: null, ...fields });
const first = { id: 'msg_1', project_id: 'prj_web', thread_id: 'thr_pr', reply_to: null, author: { kind: 'person' }, subject: 'Review #880', subject_question: null, body: 'Tell me about it.', created_at: '2026-11-03T09:40:00.000Z', resolved_at: null, idempotency_key: 'k', to: { host: 'claude-code', session: 'ses_web' } } as unknown as InboxMessageWire;
const agentSaid = { ...first, id: 'msg_2', reply_to: 'msg_1', author: { kind: 'agent', host: 'claude-code', session: 'ses_web', name: 'Claude Code' }, body: 'It fixes RTL.', to: undefined, wakes: true } as unknown as InboxMessageWire;
const threadOf = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: 'thr_pr', project: { id: 'prj_web', key: 'web-app-abc', name: 'web-app', root: '/w/web-app', created_at: '2026-11-01T09:00:00.000Z' }, subject: 'Review #880', thread_name: 'Review #880', resolved_at: null, messages }) as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let tieFails = 0;
let asked = 0;
const opened: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  tieFails = 0;
  asked = 0;
  opened.length = 0;
  forgetPullGuideRequests();
  resetSkillCatalogCache();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/skills')) return Response.json({ skills: [{ name: 'review-curate', root: 'plannotator', humanOnly: true }] });
    if (init?.method === 'POST') {
      posts.push({ path: url.pathname.replace(/^.*\/api\/inbox/, ''), body: JSON.parse(String(init.body ?? '{}')) });
      if (url.pathname.endsWith('/pulls/owner') && tieFails > 0) {
        tieFails -= 1;
        return Response.json({ error: 'The Inbox could not save it.', code: 'error' }, { status: 500 });
      }
      if (url.pathname.endsWith('/reply')) return Response.json({ message: { id: 'msg_3' }, replayed: false });
      return Response.json({ ok: true });
    }
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

function mount(link: InboxPullLink, messages: InboxMessageWire[]) {
  const [row] = inboxReviewRows({ threads: [], stacks: [stack], links: { [pull.key]: link }, pulls: [pull] });
  const thread = threadOf(messages);
  const view = reviewViewOf(row!, thread, { projectName: 'web-app', onWholeThread: () => {}, onOpenStack: () => {}, onOpenDiff: () => opened.push('diff'), onAsked: () => (asked += 1) });
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewContextLine view={view} thread={thread} onOpenGuide={(id) => opened.push(`guide ${id}`)} />
      </div>,
    );
  });
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const press = async (selector: string) => {
  await act(async () => $(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
};
const replies = () => posts.filter((p) => p.path.endsWith('/reply'));
const ties = () => posts.filter((p) => p.path === '/pulls/owner');

test.skipIf(!hasDom)("the PR's line in its thread: Guided review, The diff and Open on GitHub, before any guide", async () => {
  mount(linkOf(), [first]);
  const links = [...document.querySelectorAll('[data-pull-context] [data-pull-context-go]')];
  expect(links.map((l) => l.textContent)).toEqual(['Guided review', 'The diff', 'Open on GitHub']);
  expect(links[2]!.getAttribute('href')).toBe(pull.url);
  await press('[data-pull-context-go="diff"]');
  expect(opened).toEqual(['diff']);
});

test.skipIf(!hasDom)("Guided review asks this thread's agent, in this thread, with the hand-off's /review-curate step and its skills block; then the PR says it is on its way", async () => {
  mount(linkOf(), [first, agentSaid]);
  await act(async () => {
    $('[data-pull-context-go="guide"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    $('[data-pull-context-go="guide"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
  // One reply, to the agent's latest message in this thread: no new thread.
  expect(replies().map((p) => p.path)).toEqual(['/messages/msg_2/reply']);
  expect(posts.some((p) => p.path === '/messages')).toBe(false);
  const words = String(replies()[0]!.body.words);
  const step = pullThreadGuideWords(stack);
  expect(step).toBe('Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message). Include what I might ask tomas.');
  expect(words.startsWith(`${step}\n\n`) && words.length > step.length + 100).toBe(true);
  expect(ties().map((p) => p.body)).toEqual([{ keys: [pull.key], thread_id: 'thr_pr', ask: 'guide' }]);
  expect(asked).toBe(1);
  expect($('[data-pull-context-guide="asked"]')!.textContent).toBe('Guided review on the way');
  expect(!!$('[data-pull-context-go="guide"]')).toBe(false);
});

test.skipIf(!hasDom)("a request that went but whose link did not change is not sent again: the next press only changes the link, after a remount too", async () => {
  mount(linkOf(), [first, agentSaid]);
  tieFails = 2;
  await press('[data-pull-context-go="guide"]');
  expect($('[data-pull-context-error]')!.textContent).toBe('Asked for a guided review, but this pull request doesn’t say so yet. Press Guided review again.');
  await press('[data-pull-context-go="guide"]');
  act(() => root!.unmount());
  host!.remove();
  mount(linkOf(), [first, agentSaid]);
  await press('[data-pull-context-go="guide"]');
  expect(replies()).toHaveLength(1);
  expect(ties()).toHaveLength(3);
  expect(asked).toBe(1);
});

test.skipIf(!hasDom)('once asked, the line says it is on its way; once a guide is in, Guided review opens the latest', async () => {
  mount(linkOf({ ask: 'guide' }), [first, agentSaid]);
  expect($('[data-pull-context-guide="asked"]')!.textContent).toBe('Guided review on the way');
  act(() => root!.unmount());
  host!.remove();
  const guide = { ...agentSaid, id: 'msg_9', guide: { title: 'Walk', steps: 3 } } as unknown as InboxMessageWire;
  mount(linkOf({ ask: 'guide' }), [first, agentSaid, guide]);
  await press('[data-pull-context-go="guide"]');
  expect(opened).toEqual(['guide msg_9']);
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)("a thread whose PR's link names another thread: no Guided review here, nothing sent that could move the PR's link", async () => {
  mount(linkOf({ thread_id: 'thr_other' }), [first, agentSaid]);
  expect(!!$('[data-pull-context-go="guide"]')).toBe(false);
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)('after a reload, a request already in the thread (the link still unchanged) is not sent again: the press only changes the link', async () => {
  const request = { ...first, id: 'msg_3', reply_to: 'msg_2', body: `${pullThreadGuideWords(stack)}\n\n## Skills\n…`, created_at: '2026-11-03T09:50:00.000Z' } as unknown as InboxMessageWire;
  mount(linkOf(), [first, agentSaid, request]);
  await press('[data-pull-context-go="guide"]');
  expect(replies()).toHaveLength(0);
  expect(ties().map((p) => p.body)).toEqual([{ keys: [pull.key], thread_id: 'thr_pr', ask: 'guide' }]);
  expect($('[data-pull-context-guide="asked"]')!.textContent).toBe('Guided review on the way');
});
