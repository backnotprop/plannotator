/**
 * The open thread's name (design study "thread-name-header", option C): the list's
 * pill, first in the line under the subject, by the list's rule
 * (`threadChipName`). The failures this catches: a named thread whose open
 * view never says its name, a name shown twice when the subject already
 * starts with it, a pill that keeps the old name after a rename, a
 * one-message thread losing the name because it has no count line, and a
 * cut name with no way to read it whole.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { sized, tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-web-abcdef', name: 'billing-web', root: '/work/billing-web', created_at: '2026-10-20T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_N1';
const SUBJECT = 'The refresh guard is in and the old retry loop is gone.';

function message(id: string, minute: number, body: string): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author: AGENT,
    subject: id === ROOT ? SUBJECT : null,
    subject_question: null,
    body,
    created_at: `2026-10-20T18:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
  };
}

function thread(name: string | null, count: number, subject = SUBJECT): InboxThread {
  const messages = [message(ROOT, 10, `${subject}\n\nDetails.`)];
  for (let i = 1; i < count; i++) messages.push(message(`msg_N${i + 1}`, 10 + i, `Update ${i}.`));
  messages[0]!.subject = subject;
  return { thread_id: ROOT, project: PROJECT, subject, thread_name: name, resolved_at: null, messages };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
});

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function draw(t: InboxThread) {
  act(() => {
    root!.render(
      <div className="pn-inbox">
        <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
}

async function render(t: InboxThread) {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  draw(t);
  await settle();
  return host;
}

const meta = () => host!.querySelector<HTMLElement>('.ib-pbody > [data-thread-meta]');
const pill = () => meta()?.querySelector<HTMLElement>('.ib-key') ?? null;
const pillName = () => pill()?.querySelector('.ib-keyt')?.textContent ?? null;

test.skipIf(!hasDom)('a named thread shows its name first in the line under the subject, read with what it is', async () => {
  await render(thread('session-refresh', 3));
  expect(pillName()).toBe('session-refresh');
  // First in the line; after it, the rest of the line as ONE item (count, dot, time), so a name that leaves too
  // little room moves them to the next line together rather than one at a time with a dot left behind.
  const rest = meta()!.querySelector<HTMLElement>('[data-thread-meta-rest]')!;
  expect([...meta()!.children]).toEqual([pill()!, rest]);
  expect(rest.textContent).toMatch(/^3 messages.*\d{1,2}:\d{2} [AP]M/);
  expect(rest.querySelectorAll('.ib-tdot').length).toBeGreaterThan(0);
  // A screen reader hears a label before the name (not a stray word); the pill itself shows only the name.
  const lead = pill()!.querySelector<HTMLElement>('.ib-sr')!;
  expect(lead.textContent!.trim()).not.toBe('');
  expect(lead.compareDocumentPosition(pill()!.querySelector('.ib-keyt')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test.skipIf(!hasDom)('no name, or a subject that already starts with the name: no pill, the line is the count and time as before', async () => {
  await render(thread(null, 3));
  expect(pill()).toBeNull();
  expect(meta()!.textContent).toMatch(/^3 messages/);
  draw(thread('the refresh guard', 3));
  await settle();
  expect(pill()).toBeNull();
  // The list's rule: a name that only starts a longer word of the subject still shows.
  draw(thread('the refresh', 3, 'The refreshed guard is in.'));
  await settle();
  expect(pillName()).toBe('the refresh');
});

test.skipIf(!hasDom)('a rename while the thread is open shows the new name; a name taken away takes the pill with it', async () => {
  await render(thread('session-refresh', 2));
  expect(pillName()).toBe('session-refresh');
  draw(thread('auth: token refresh', 2));
  await settle();
  expect(pillName()).toBe('auth: token refresh');
  expect(meta()!.querySelectorAll('.ib-key')).toHaveLength(1);
  draw(thread(null, 2));
  await settle();
  expect(pill()).toBeNull();
  expect(meta()!.textContent).toMatch(/^2 messages/);
});

test.skipIf(!hasDom)('a one-message thread has no count line, so a named one gets a line holding only its name', async () => {
  await render(thread('session-refresh', 1));
  expect(pillName()).toBe('session-refresh');
  expect([...meta()!.children]).toEqual([pill()!]);
  expect(meta()!.textContent).not.toContain('message');
  draw(thread(null, 1));
  await settle();
  expect(meta()).toBeNull();
});

test.skipIf(!hasDom)('a name cut with "…" shows whole in its tooltip', async () => {
  const long = 'Q4 invoice export: move the nightly CSV job off the cron box and onto the queue workers, with retries and dead-lettering';
  await render(thread(long, 2));
  const text = pill()!.querySelector('.ib-keyt')!;
  expect(text.textContent).toBe(long);
  sized(text, 900, 320);
  expect(await tooltipOf(text)).toBe(long);
});
