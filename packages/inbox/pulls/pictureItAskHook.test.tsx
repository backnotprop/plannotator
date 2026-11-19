import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxMessageWire, type InboxPull, type InboxThread } from '@plannotator/core/inbox-types';
import type { PictureItSubject } from './usePictureItAsk';

const hasDom = typeof document !== 'undefined';
const { usePictureItAsk, forgetPictureItRequests, pictureItWords, PICTURE_IT_UNTOLD } = (hasDom ? await import('./usePictureItAsk') : {}) as typeof import('./usePictureItAsk');
const { resetSkillCatalogCache } = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');
const { PICTURE_IT_SKILL } = (hasDom ? await import('@plannotator/core/picture-it-skill') : {}) as typeof import('@plannotator/core/picture-it-skill');

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
const prSubject: PictureItSubject = { kind: 'pull', stack, linkThreadId: 'thr_pr' };
const localSubject: PictureItSubject = { kind: 'local', changes: 'uncommitted', project: 'web-app', branch: 'main', base: null };
const first = { id: 'msg_1', project_id: 'prj_web', thread_id: 'thr_pr', reply_to: null, author: { kind: 'person' }, subject: 'Review #880', subject_question: null, body: 'Tell me about it.', created_at: '2026-11-03T09:40:00.000Z', resolved_at: null, idempotency_key: 'k', to: { host: 'claude-code', session: 'ses_web' } } as unknown as InboxMessageWire;
const agentSaid = { ...first, id: 'msg_2', reply_to: 'msg_1', author: { kind: 'agent', host: 'claude-code', session: 'ses_web', name: 'Claude Code' }, body: 'It fixes RTL.', to: undefined, wakes: true } as unknown as InboxMessageWire;
const threadOf = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: 'thr_pr', project: { id: 'prj_web', key: 'web-app-abc', name: 'web-app', root: '/w/web-app', created_at: '2026-11-01T09:00:00.000Z' }, subject: 'Review #880', thread_name: 'Review #880', resolved_at: null, messages }) as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let tieFails = 0;
let asked = 0;

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  tieFails = 0;
  asked = 0;
  forgetPictureItRequests();
  resetSkillCatalogCache();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/skills')) return Response.json({ skills: [{ name: 'picture-it', root: 'plannotator', humanOnly: true }] });
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

function Probe({ subject, thread }: { subject: PictureItSubject; thread: InboxThread }) {
  const ask = usePictureItAsk(subject, thread, () => (asked += 1));
  return (
    <div data-state={ask.onTheWay ? 'on-the-way' : ask.onPictureIt ? 'ready' : 'none'} data-page={ask.page?.attachment_id ?? ''}>
      {ask.onPictureIt && <button type="button" onClick={ask.onPictureIt} />}
      {ask.error && <p data-error>{ask.error}</p>}
    </div>
  );
}

function mount(subject: PictureItSubject, messages: InboxMessageWire[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Probe subject={subject} thread={threadOf(messages)} />);
  });
}

const remount = (subject: PictureItSubject, messages: InboxMessageWire[]) => {
  act(() => root!.unmount());
  host!.remove();
  mount(subject, messages);
};
const state = () => document.querySelector('[data-state]')!.getAttribute('data-state');
const press = async (times = 1) => {
  await act(async () => {
    for (let i = 0; i < times; i += 1) document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};
const replies = () => posts.filter((p) => p.path.endsWith('/reply'));
const ties = () => posts.filter((p) => p.path === '/pulls/owner');

test.skipIf(!hasDom)("a PR's thread: one reply to its agent with the Picture it step and the skill's text, then the PR is told picture_it", async () => {
  mount(prSubject, [first, agentSaid]);
  await press(2);
  expect(replies().map((p) => p.path)).toEqual(['/messages/msg_2/reply']);
  const words = String(replies()[0]!.body.words);
  expect(words.startsWith(`${pictureItWords(prSubject)}\n\n`)).toBe(true);
  expect(words).toContain(PICTURE_IT_SKILL.body.split('\n')[0]!);
  expect(ties().map((p) => p.body)).toEqual([{ keys: [pull.key], thread_id: 'thr_pr', ask: 'picture_it' }]);
  expect(asked).toBe(1);
  expect(state()).toBe('on-the-way');
});

test.skipIf(!hasDom)('a request that went but whose PR was not told is not sent again: the next press only tells the PR, after a remount too', async () => {
  mount(prSubject, [first, agentSaid]);
  tieFails = 2;
  await press();
  expect(document.querySelector('[data-error]')!.textContent).toBe(PICTURE_IT_UNTOLD);
  await press();
  const request = { ...first, id: 'msg_3', reply_to: 'msg_2', body: `${pictureItWords(prSubject)}\n\n…`, created_at: '2026-11-03T09:50:00.000Z' } as unknown as InboxMessageWire;
  remount(prSubject, [first, agentSaid, request]);
  expect(state()).toBe('ready');
  await press();
  expect(replies()).toHaveLength(1);
  expect(ties()).toHaveLength(3);
  expect(asked).toBe(1);
  expect(state()).toBe('on-the-way');
});

test.skipIf(!hasDom)('local changes: the reply asks for a page of them through /picture-it, and no PR is told', async () => {
  mount(localSubject, [first, agentSaid]);
  await press();
  expect(String(replies()[0]!.body.words).startsWith('Please send me a Picture page of the uncommitted changes in web-app (on main), using /picture-it.')).toBe(true);
  expect(ties()).toEqual([]);
  expect(state()).toBe('on-the-way');
});

test.skipIf(!hasDom)('a page in the thread is the latest; a request before it does not hold back asking again, one after it does', async () => {
  const request = { ...first, id: 'msg_3', reply_to: 'msg_2', body: `${pictureItWords(prSubject)}\n\n…`, created_at: '2026-11-03T09:50:00.000Z' } as unknown as InboxMessageWire;
  const page = { ...agentSaid, id: 'msg_4', body: 'Here it is.', picture_it: { attachment_id: 'att_1', title: 'RTL' }, created_at: '2026-11-03T10:00:00.000Z' } as unknown as InboxMessageWire;
  mount(prSubject, [first, agentSaid, request, page]);
  expect(document.querySelector('[data-page]')!.getAttribute('data-page')).toBe('att_1');
  expect(state()).toBe('ready');
  remount(prSubject, [first, agentSaid, page, request]);
  expect(state()).toBe('on-the-way');
});

test.skipIf(!hasDom)("a thread whose PR's link names another thread: nothing to press, nothing sent", async () => {
  mount({ ...prSubject, linkThreadId: 'thr_other' }, [first, agentSaid]);
  expect(state()).toBe('none');
  expect(posts).toEqual([]);
});
