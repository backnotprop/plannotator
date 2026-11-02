/**
 * The open thread's name: the top bar's title, by the list's rule
 * (`threadChipName`), else the subject (the owner, 2026-11-02, on approval
 * "inbox-thread-header"; it replaces design study "thread-name-header"'s
 * chip on the meta line). The failures this catches: a named thread whose
 * open view never says its name, the name shown twice (bar and chip, or a
 * subject that already starts with it), a title that keeps the old name after
 * a rename, a one-message thread losing the name, and no way to read the
 * whole subject behind a name.
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


// The owner's call on approval "inbox-thread-header" (2026-11-02): the top bar shows the thread's name whenever the list
// would show it (`threadChipName`), else the subject; the meta line no longer repeats the name as a chip.
const bar = () => host!.querySelector<HTMLElement>('.ib-phead [data-header-subject]')!;
const shown = () => bar().firstChild!.textContent;
const meta = () => host!.querySelector<HTMLElement>('.ib-pbody > [data-thread-meta]');
const chips = () => host!.querySelectorAll('.ib-pbody .ib-key');

test.skipIf(!hasDom)('a named thread: the bar is its name and its one heading; the meta line is the count and time, no chip', async () => {
  await render(thread('session-refresh', 3));
  expect(shown()).toBe('session-refresh');
  expect(bar().tagName).toBe('H2');
  expect(host!.querySelectorAll('h2.ib-subject')).toHaveLength(1);
  expect(host!.querySelector('.ib-pbody h2')).toBeNull();
  expect(chips()).toHaveLength(0);
  expect([...meta()!.children].map((el) => el.hasAttribute('data-thread-meta-rest'))).toEqual([true]);
  expect(meta()!.textContent).toMatch(/^3 messages.*\d{1,2}:\d{2} [AP]M/);
  // Whole in the tooltip: the subject, and never the native title.
  expect(bar().hasAttribute('title')).toBe(false);
  expect(await tooltipOf(bar())).toBe(SUBJECT);
});

test.skipIf(!hasDom)("no name, or a subject that already starts with the name: the bar is the subject, by the list's rule", async () => {
  await render(thread(null, 3));
  expect(shown()).toBe(SUBJECT);
  draw(thread('the refresh guard', 3));
  await settle();
  expect(shown()).toBe(SUBJECT);
  expect(chips()).toHaveLength(0);
  // The list's rule: a name that only starts a longer word of the subject still shows.
  draw(thread('the refresh', 3, 'The refreshed guard is in.'));
  await settle();
  expect(shown()).toBe('the refresh');
});

test.skipIf(!hasDom)('a rename while the thread is open shows the new name; a name taken away puts the subject back', async () => {
  await render(thread('session-refresh', 2));
  expect(shown()).toBe('session-refresh');
  draw(thread('auth: token refresh', 2));
  await settle();
  expect(shown()).toBe('auth: token refresh');
  draw(thread(null, 2));
  await settle();
  expect(shown()).toBe(SUBJECT);
  expect(meta()!.textContent).toMatch(/^2 messages/);
});

test.skipIf(!hasDom)('a one-message thread has no meta line, named or not; the bar still shows the name', async () => {
  await render(thread('session-refresh', 1));
  expect(meta()).toBeNull();
  expect(shown()).toBe('session-refresh');
  draw(thread(null, 1));
  await settle();
  expect(meta()).toBeNull();
  expect(shown()).toBe(SUBJECT);
});

test.skipIf(!hasDom)('a long name cut with "…": the bar keeps its start, the tooltip gives the whole subject', async () => {
  const long = 'Q4 invoice export: move the nightly CSV job off the cron box and onto the queue workers, with retries and dead-lettering';
  await render(thread(long, 2));
  expect(shown()).toBe(long);
  sized(bar(), 900, 120);
  expect(await tooltipOf(bar())).toBe(SUBJECT);
});
