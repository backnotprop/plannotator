/**
 * A thread left open while an agent writes keeps only its newest render: each new message (a new thread object) must
 * not leave the earlier renders of the pane alive through messages that did not draw again (DOM-gated: DOM_TESTS=1).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-10-28T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const ROOT_ID = 'msg_01M62DTT05NJ59ZR4AJCDJ7000';
const ARRIVALS = 8;

function message(n: number): InboxMessageWire {
  const id = n === 0 ? ROOT_ID : `msg_01M62DTT05NJ59ZR4AJCDJ7${String(n).padStart(3, '0')}`;
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: n === 0 ? null : ROOT_ID,
    author: CLAUDE,
    subject: n === 0 ? 'Retry worker' : null,
    body: `Step ${n}: the worker retries a 409 with the same key.`,
    created_at: `2026-10-28T19:${String(n).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: n + 1,
  };
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function draw(thread: InboxThread) {
  act(() => {
    root!.render(
      <ThreadPane
        thread={thread}
        sent={null}
        lookSeq={1_000}
        phone={false}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />,
    );
  });
  await settle();
}

test.skipIf(!hasDom)('messages that did not draw again keep no earlier render of the pane alive', async () => {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  let thread: InboxThread = { thread_id: ROOT_ID, project: PROJECT, subject: 'Retry worker', thread_name: 'retry', resolved_at: null, messages: [0, 1, 2].map(message) };
  await draw(thread);
  const earlier: WeakRef<InboxThread>[] = [];
  for (let n = 3; n < 3 + ARRIVALS; n++) {
    earlier.push(new WeakRef(thread));
    // A record applied in place: a new thread object, every unchanged message the same object.
    thread = { ...thread, messages: [...thread.messages, message(n)] };
    await draw(thread);
  }
  expect(document.querySelectorAll('[data-message-article]:not([data-folded])').length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < 4; i++) {
    Bun.gc(true);
    await settle();
  }
  const alive = earlier.filter((ref) => ref.deref() !== undefined).length;
  expect(alive).toBeLessThanOrEqual(2);
});
