/**
 * A PR launchpad's Start a thread (`pulls/startThread.ts`): the New message box about the PR, To's list open. What
 * regresses:
 *  - To left empty, or filled by anything but New review's rule (`reviewDefaultTo`: a live agent of the PR's project,
 *    else a new session there where this computer can start one);
 *  - the box sending by itself once To is filled: only Send sends;
 *  - the Send asking for a guided review (the words naming `/review-curate`, or the thread kept with an ask, which
 *    makes the launchpad say one is on its way);
 *  - the PR not checked with To's project (`pulls/owner`, `validate_only`) before the thread starts;
 *  - closing the box untouched keeping a draft of the hand-off.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
import type { ComposeSent } from './compose/composeResults';
import type { StartThreadInput } from './api';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { pullThreadRequest } = (hasDom ? await import('./pulls/startThread') : {}) as typeof import('./pulls/startThread');
const { reviewBoxPull } = (hasDom ? await import('./compose/reviewBox') : {}) as typeof import('./compose/reviewBox');

const AGENT = 'claude-code';
const REPO = 'northwind/web-app';
const PROJECTS = [
  { id: 'p1', name: 'billing', root: '/Users/me/work/billing', exists: true },
  { id: 'p2', name: 'web-app', root: '/Users/me/work/web-app', exists: true },
];

const pr: InboxPull = {
  key: `github.com/${REPO}#880`,
  platform: 'github',
  host: 'github.com',
  repo: REPO,
  number: 880,
  url: `https://github.com/${REPO}/pull/880`,
  title: 'Fix RTL',
  author: 'tomas',
  mine: false,
  requested: true,
  state: 'open',
  base: 'main',
  head: 'fix/rtl',
  head_repo: REPO,
  additions: 3,
  deletions: 1,
  files: 2,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
};

const live = (session: string) => ({ session, host: AGENT, started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:29:00.000Z', busy: false, idle_since: null, last_thread: null });

let root: Root | null = null;
let host: HTMLElement | null = null;
let starts: StartThreadInput[] = [];
let sent: ComposeSent[] = [];
let posts: { path: string; body: unknown }[] = [];
let saved = 0;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: JSON.parse(String(init.body ?? '{}')) });
    return Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  starts = [];
  sent = [];
  posts = [];
  saved = 0;
  globalThis.fetch = savedFetch;
});

const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function idle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

const request = () => pullThreadRequest(reviewBoxPull(inboxPullStacks([pr])[0]!, { reviewed: false, thread_id: null, link: null, review: null }, {}, ['p2']));

/** The box as the launchpad opens it; `sessions`: each project's live agents. */
async function open(sessions: Record<string, string[]>, onClose: () => void = () => {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={request()}
        phone={false}
        current={null}
        lastSent={null}
        home="/Users/me"
        onSent={(s) => sent.push(s)}
        onSaved={() => {
          saved += 1;
        }}
        onDeleted={() => {}}
        onClose={onClose}
        transport={{
          sessions: async () => ({
            serverSession: 's',
            home: '/Users/me',
            projects: PROJECTS.map((p) => ({ project: { id: p.id, name: p.name, root: p.root }, sessions: (sessions[p.id] ?? []).map(live) })),
            launch: { agents: [{ agent: AGENT, name: 'Claude Code' }], projects: PROJECTS, scratch: { root: '/Users/me/scratch' } },
          }),
          startThread: async (input) => {
            starts.push(input);
            return { thread_id: 't_new' };
          },
          drafts: true,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

test.skipIf(!hasDom)("To is filled with the PR's project's live agent and its list is open, but nothing is sent until Send", async () => {
  await open({ p1: ['ses_billing'], p2: ['ses_web'] });
  await until(() => inDialog('[data-compose-to]')?.getAttribute('data-compose-to') === 'ses_web', 'To filled');
  expect(inDialog('[data-compose-picker]') !== null).toBe(true);
  // The other project's agent is not offered: the PR's agent works in its own project.
  expect(inDialog('[data-compose-session="ses_billing"]') === null).toBe(true);
  await idle();
  expect(starts).toEqual([]);
  expect(sent).toEqual([]);
});

test.skipIf(!hasDom)('with no live agent there, To names a new session in the PR\'s project, and still waits for Send', async () => {
  await open({ p1: ['ses_billing'] });
  await until(() => inDialog('[data-compose-to]')?.getAttribute('data-compose-to') === 'start', 'To names a new session');
  await idle();
  expect(starts).toEqual([]);
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  expect(starts[0]!.to).toEqual({ launch: { agent: AGENT, project_id: 'p2' } });
});

test.skipIf(!hasDom)('Send checks the PR with the project, starts the thread with the hand-off and no guided review, and keeps it as the PR\'s with no ask', async () => {
  await open({ p2: ['ses_web'] });
  await until(() => inDialog('[data-compose-to]')?.getAttribute('data-compose-to') === 'ses_web', 'To filled');
  const text = inDialog('textarea') as HTMLTextAreaElement;
  expect(text.value.includes('#880')).toBe(true);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, `${text.value}What does the RTL fix change for Hebrew?`);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  expect(posts.some((p) => p.path.endsWith('/api/inbox/pulls/owner') && JSON.stringify(p.body) === JSON.stringify({ keys: [pr.key], project_id: 'p2', validate_only: true }))).toBe(true);
  const input = starts[0]!;
  expect(input.to).toEqual({ host: AGENT, session: 'ses_web' });
  expect(input.body.includes('/review-curate')).toBe(false);
  expect(input.body.includes('guided review')).toBe(false);
  expect(input.body.endsWith('What does the RTL fix change for Hebrew?')).toBe(true);
  expect(input.thread_name).toBe('Review #880: Fix RTL');
  expect(sent[0]!.pullKeys).toEqual([pr.key]);
  // No ask: the window keeps the thread as the PR's (`pullOwner`) without saying a guided review is on its way.
  expect(sent[0]!.pullAsk ?? null).toBe(null);
});

test.skipIf(!hasDom)('closed untouched, the hand-off is not kept as a draft', async () => {
  let closed = 0;
  await open({ p2: ['ses_web'] }, () => {
    closed += 1;
  });
  await until(() => inDialog('[data-compose-to]')?.getAttribute('data-compose-to') === 'ses_web', 'To filled');
  // Escape: the open To list takes the first, the box the next (composeEscape.test.tsx).
  for (const target of [inDialog('[data-compose-picker] input'), inDialog('textarea')]) {
    if (!target) continue;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await idle(3);
  }
  await idle();
  expect(closed).toBe(1);
  expect(saved).toBe(0);
  expect(posts.some((p) => p.path.includes('/drafts'))).toBe(false);
});
