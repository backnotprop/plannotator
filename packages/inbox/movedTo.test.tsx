/**
 * A thread an agent archived after moving its questions to another thread
 * (resolve_message's `moved_to`): the archived foot says where they went and
 * links to that thread, by its name now, so the person can follow them; once
 * that thread is archived or gone, the subject it had, unlinked. Without
 * `moved_to` (none, or cleared when the old thread came back) the foot reads
 * as before.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-11-20T06:00:00.000Z' };
const SUB = { kind: 'agent' as const, host: 'claude-code', session: 'ses_sub', name: null };
const OLD = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const BRIEF = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';

function archived(extra: Partial<InboxMessageWire> = {}): InboxThread {
  const root: InboxMessageWire = {
    id: OLD,
    project_id: PROJECT.id,
    thread_id: OLD,
    reply_to: null,
    author: SUB,
    subject: 'Retry policy',
    body: 'Should failed charges be retried?',
    created_at: '2026-11-20T02:00:00.000Z',
    resolved_at: '2026-11-20T07:00:00.000Z',
    idempotency_key: null,
    seq: 1,
    ...extra,
  };
  return { thread_id: OLD, project: PROJECT, subject: 'Retry policy', thread_name: null, resolved_at: root.resolved_at, archive_seq: 5, messages: [root] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/draft')) return Response.json({ draft: null });
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

async function render(thread: InboxThread) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  for (let i = 0; i < 2; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  return host;
}

test.skipIf(!hasDom)('an archived thread whose questions moved: the foot names the thread they went to and links to it', async () => {
  const el = await render(archived({ moved_to: { thread_id: BRIEF, subject: 'Morning brief', open: true, name: 'Morning brief' } }));
  const line = el.querySelector('[data-moved-to]');
  expect(line?.textContent).toBe('Archived. Its questions moved to Morning brief.');
  expect(line?.querySelector('a')?.getAttribute('href')).toBe(`#thread=${BRIEF}`);
  // Unarchive stays offered beside it.
  expect([...el.querySelectorAll('.ib-pfoot button')].some((b) => b.textContent?.trim() === 'Unarchive')).toBe(true);
});

test.skipIf(!hasDom)('the foot names that thread as it is called now (its thread name over the subject it had)', async () => {
  const el = await render(archived({ moved_to: { thread_id: BRIEF, subject: 'Morning brief', open: true, name: 'Thursday brief' } }));
  const line = el.querySelector('[data-moved-to]');
  expect(line?.textContent).toBe('Archived. Its questions moved to Thursday brief.');
  expect(line?.querySelector('a')?.textContent).toBe('Thursday brief');
});

test.skipIf(!hasDom)('that thread archived or gone (no open served): the subject it had, as plain words, with no link', async () => {
  const el = await render(archived({ moved_to: { thread_id: BRIEF, subject: 'Morning brief' } }));
  const line = el.querySelector('[data-moved-to]');
  expect(line?.textContent).toBe('Archived. Its questions moved to Morning brief.');
  expect(line?.querySelector('a')).toBeNull();
});

test.skipIf(!hasDom)('an archived thread with no moved_to reads as before', async () => {
  const el = await render(archived());
  expect(el.querySelector('[data-moved-to]')).toBeNull();
  expect([...el.querySelectorAll('.ib-pfoot .ib-st')].map((s) => s.textContent)).toContain('Archived. The next message from Claude Code starts a new thread.');
});
