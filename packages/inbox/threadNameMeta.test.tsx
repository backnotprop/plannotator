/**
 * The open thread's name: the top bar's title by the list's rule
 * (`threadChipName`), with the whole subject in its tooltip; the meta line no
 * longer repeats it as a pill (the owner, 2026-11-02, on approval
 * "inbox-thread-header"; it replaces design study "thread-name-header"'s
 * pill). Since 2026-11-15 the bar's title is the thread's only heading (its
 * h2), there from the first draw, and the body has none. The failures this
 * catches: a named thread whose open view never says its name, a name shown
 * twice (bar and pill, or a subject that already starts with it), a title that
 * keeps the old name after a rename, a short thread with an empty bar (its
 * title down in the body), and no way to read the whole subject behind a name.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { sized, tooltipOf, unhover } from './testing/tooltip';

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
const bar = () => host!.querySelector<HTMLElement>('[data-header-subject]');
/** The bar title's words: its tooltip hangs on them, not on the box that takes the bar's free room. */
const barWords = () => bar()!.querySelector<HTMLElement>('[data-header-title]');
/** A heading in the body: none any more. */
const heading = () => host!.querySelector<HTMLElement>('.ib-pbody h2');

// The owner's call on approval "inbox-thread-header" (2026-11-02): the top bar shows the thread's name by the list's rule
// (`threadChipName`), so the meta line no longer repeats it as a pill.
test.skipIf(!hasDom)('a named thread: the bar shows its name, no heading in the body, and the meta line no pill', async () => {
  await render(thread('session-refresh', 3));
  expect(bar()!.querySelector('[data-header-title]')!.textContent).toBe('session-refresh');
  expect(heading()).toBeNull();
  expect(pill()).toBeNull();
  expect([...meta()!.children].map((el) => el.hasAttribute('data-thread-meta-rest'))).toEqual([true]);
  expect(meta()!.textContent).toMatch(/^3 messages.*\d{1,2}:\d{2} [AP]M/);
  expect(meta()!.querySelectorAll('.ib-tdot').length).toBeGreaterThan(0);
});

test.skipIf(!hasDom)("no name, or a subject that already starts with the name: no name in the bar, by the list's rule", async () => {
  await render(thread(null, 3));
  expect(bar()!.textContent).toBe(SUBJECT);
  expect(pill()).toBeNull();
  expect(meta()!.textContent).toMatch(/^3 messages/);
  draw(thread('the refresh guard', 3));
  await settle();
  expect(bar()!.textContent).toBe(SUBJECT);
  // The list's rule: a name that only starts a longer word of the subject still shows.
  draw(thread('the refresh', 3, 'The refreshed guard is in.'));
  await settle();
  expect(barWords()!.textContent).toBe('the refresh');
});

test.skipIf(!hasDom)('a rename while the thread is open shows the new name; a name taken away puts the subject back', async () => {
  await render(thread('session-refresh', 2));
  expect(barWords()!.textContent).toBe('session-refresh');
  draw(thread('auth: token refresh', 2));
  await settle();
  expect(barWords()!.textContent).toBe('auth: token refresh');
  expect(pill()).toBeNull();
  draw(thread(null, 2));
  await settle();
  expect(bar()!.textContent).toBe(SUBJECT);
  expect(meta()!.textContent).toMatch(/^2 messages/);
});

test.skipIf(!hasDom)('a one-message thread has no meta line, and its title is in the bar either way, never a heading in the body', async () => {
  await render(thread('session-refresh', 1));
  expect(meta()).toBeNull();
  expect(barWords()!.textContent).toBe('session-refresh');
  draw(thread(null, 1));
  await settle();
  expect(meta()).toBeNull();
  expect(bar()!.textContent).toBe(SUBJECT);
  expect(heading()).toBeNull();
});

test.skipIf(!hasDom)('the bar shows the title at the top, scrolled or not; its tooltip the whole subject under a name, else only when cut', async () => {
  await render(thread('session-refresh', 1));
  expect(bar()!.hasAttribute('title')).toBe(false);
  expect(await tooltipOf(barWords()!)).toBe(SUBJECT);
  unhover(barWords()!);
  draw(thread(null, 3));
  await settle();
  expect(bar()!.textContent).toBe(SUBJECT);
  expect(getComputedStyle(bar()!).visibility).not.toBe('hidden');
  expect(await tooltipOf(barWords()!)).toBeNull();
  unhover(barWords()!);
  sized(barWords()!, 900, 120);
  expect(await tooltipOf(barWords()!)).toBe(SUBJECT);
});

// The bar's title is the thread's heading: under a name, a screen reader hears the subject too (the tooltip is a pointer's).
test.skipIf(!hasDom)('the heading is the bar title; a named thread\'s heading says the subject to a screen reader too, an unnamed one nothing extra', async () => {
  await render(thread('session-refresh', 1));
  const h2 = host!.querySelector<HTMLElement>('h2.ib-subject')!;
  expect(h2).toBe(bar()!);
  expect(h2.closest('[aria-hidden="true"]')).toBeNull();
  expect(h2.getAttribute('aria-label')).toBe(`session-refresh: ${SUBJECT}`);
  draw(thread(null, 1));
  await settle();
  expect(bar()!.hasAttribute('aria-label')).toBe(false);
  expect(bar()!.textContent).toBe(SUBJECT);
});
