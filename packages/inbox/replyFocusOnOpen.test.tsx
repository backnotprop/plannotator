import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const T1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const T2 = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';

function threadOf(id: string, subject: string): InboxThread {
  const message: InboxMessageWire = {
    id,
    project_id: PROJECT.id,
    thread_id: id,
    reply_to: null,
    author: AGENT,
    subject,
    body: 'The nightly sync is green again.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
  };
  return { thread_id: id, project: PROJECT, subject, thread_name: null, resolved_at: null, messages: [message] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
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

async function settle(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function pane(thread: InboxThread) {
  return (
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
    </div>
  );
}

async function render(thread: InboxThread) {
  (document.activeElement as HTMLElement | null)?.blur?.();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread));
  });
  await settle();
  return host;
}

const reply = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-reply-button]');

async function openBox(el: HTMLElement) {
  act(() => reply(el)!.click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  expect(document.activeElement === text).toBe(true);
  return text;
}

test.skipIf(!hasDom)('a thread opening leaves Reply without focus', async () => {
  const el = await render(threadOf(T1, 'Nightly sync'));
  expect(reply(el)).not.toBeNull();
  expect(document.activeElement === reply(el)).toBe(false);
});

test.skipIf(!hasDom)("another thread replacing one whose reply box was open leaves the new thread's Reply without focus", async () => {
  const el = await render(threadOf(T1, 'Nightly sync'));
  await openBox(el);
  act(() => root!.render(pane(threadOf(T2, 'Ledger export'))));
  await settle();
  expect(el.querySelector('textarea')).toBeNull();
  expect(reply(el)).not.toBeNull();
  expect(document.activeElement === reply(el)).toBe(false);
});

test.skipIf(!hasDom)('Escape in the reply box still puts focus back on Reply', async () => {
  const el = await render(threadOf(T1, 'Nightly sync'));
  const text = await openBox(el);
  act(() => {
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await settle();
  expect(el.querySelector('textarea')).toBeNull();
  expect(document.activeElement === reply(el)).toBe(true);
});
