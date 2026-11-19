import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks } from '@plannotator/core/inbox-types';
import type { StartThreadInput } from '../api';
import type { ComposeSent } from './ComposeDialog';
import { forgetUnsentReview, type ReviewBoxPull } from './reviewBox';
import { pull } from '../pulls/pullReviewFixtures';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./ComposeDialog') : {}) as typeof import('./ComposeDialog');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const live = (session: string) => ({ session, host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:59:00.000Z', busy: false, idle_since: null, last_thread: null });
const transport = (started: StartThreadInput[]) => ({
  sessions: async () => ({ serverSession: 's', home: '/home/dana', projects: [{ project: { id: 'prj_2', name: 'web-app', root: '/home/dana/web-app' }, sessions: [live('ses_web')] }, { project: { id: 'prj_9', name: 'other', root: '/home/dana/other' }, sessions: [live('ses_other')] }] }),
  startThread: async (input: StartThreadInput) => (started.push(input), { thread_id: 'thr_box' }),
  drafts: false,
  uploads: false,
});
const pick = (): ReviewBoxPull => {
  const stack = inboxPullStacks([pull(869, { repo: 'northwind/web-app', head: 'locale' })])[0]!;
  return { id: stack.id, stack, label: '#869', title: 'Layer 869', projects: ['prj_2'], thread: null, project: 'web-app' };
};

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/skills')) return Response.json({ skills: [{ name: 'picture-it', root: 'plannotator', humanOnly: true }] });
    if (init?.method === 'POST') return Response.json({ ok: true });
    if (url.pathname.endsWith('/reviews/changes')) return Response.json({ git: true, files: 2, additions: 2, deletions: 0, branch: 'main', base: 'main' });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  forgetUnsentReview();
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

function open(review: Parameters<typeof ComposeDialog>[0]['request']['review'], started: StartThreadInput[], sent: ComposeSent[], current: { id: string; root: string; name: string } | null = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <ComposeDialog request={{ review }} phone={false} current={current} lastSent={null} home={null} transport={transport(started) as never} onSent={(s) => sent.push(s)} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
}

const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const type = async (words: string) => {
  const box = el<HTMLTextAreaElement>('[data-compose-text] textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

test.skipIf(!hasDom)('the box asked for Picture it: the hand-off asks for a page through /picture-it with the words after it, tied to the PR as picture_it', async () => {
  const started: StartThreadInput[] = [];
  const sent: ComposeSent[] = [];
  const chosen = pick();
  open({ pick: chosen, ask: 'picture_it' }, started, sent);
  await settle();
  await type('just the retries');
  await act(async () => el('[data-compose-send]').click());
  await settle();
  expect(started[0]!.body).toContain('1. Send me a Picture page of its diff against main, using /picture-it just the retries (its instructions are at the end of this message).');
  expect(started[0]!.body).not.toContain('/review-curate');
  expect(sent[0]).toMatchObject({ threadId: 'thr_box', pullKeys: [chosen.stack.layers[0]!.key], pullAsk: 'picture_it' });
});

test.skipIf(!hasDom)('the box asked for Picture it on local changes: the message asks for a page of them through /picture-it', async () => {
  const started: StartThreadInput[] = [];
  open({ ask: 'picture_it' }, started, [], { id: 'prj_9', root: '/home/dana/other', name: 'other' });
  await settle();
  await act(async () => el('[data-review-choice="branch"]').click());
  await act(async () => el('[data-compose-send]').click());
  await settle();
  expect(started[0]!.body.startsWith('Please send me a Picture page of the whole branch in other')).toBe(true);
  expect(started[0]!.body).toContain('using /picture-it.');
  expect(started[0]!.body).not.toContain('/review-curate');
  expect(started[0]!.review).toMatchObject({ kind: 'local', changes: 'branch', ask: 'picture_it' });
});
