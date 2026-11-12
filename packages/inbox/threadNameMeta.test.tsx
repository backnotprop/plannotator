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
const bar = () => host!.querySelector<HTMLElement>('[data-header-subject]');
const barWords = () => bar()!.querySelector<HTMLElement>('[data-header-title]');
const heading = () => host!.querySelector<HTMLElement>('.ib-pbody > h2.ib-subject');

test.skipIf(!hasDom)('a named thread: the bar shows its name, the heading the subject, and the meta line no pill', async () => {
  await render(thread('session-refresh', 3));
  expect(bar()!.textContent).toBe('session-refresh');
  expect(bar()!.hasAttribute('data-on')).toBe(true);
  expect(heading()!.textContent).toBe(SUBJECT);
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
  draw(thread('the refresh', 3, 'The refreshed guard is in.'));
  await settle();
  expect(bar()!.textContent).toBe('the refresh');
  expect(bar()!.hasAttribute('data-on')).toBe(true);
});

test.skipIf(!hasDom)('a rename while the thread is open shows the new name; a name taken away puts the subject back', async () => {
  await render(thread('session-refresh', 2));
  expect(bar()!.textContent).toBe('session-refresh');
  draw(thread('auth: token refresh', 2));
  await settle();
  expect(bar()!.textContent).toBe('auth: token refresh');
  expect(pill()).toBeNull();
  draw(thread(null, 2));
  await settle();
  expect(bar()!.textContent).toBe(SUBJECT);
  expect(meta()!.textContent).toMatch(/^2 messages/);
});

test.skipIf(!hasDom)('a one-message thread has no meta line; named, the bar still shows the name; unnamed, the bar has no title', async () => {
  await render(thread('session-refresh', 1));
  expect(meta()).toBeNull();
  expect(bar()!.textContent).toBe('session-refresh');
  draw(thread(null, 1));
  await settle();
  expect(meta()).toBeNull();
  expect(bar()).toBeNull();
  expect(heading()!.textContent).toBe(SUBJECT);
});

test.skipIf(!hasDom)('the top bar always shows the thread name, its tooltip the whole subject; with no name it shows the subject only once the heading has scrolled away', async () => {
  const scrollTo = async (subjectBottom: number) => {
    const body = host!.querySelector<HTMLElement>('.ib-pbody')!;
    body.getBoundingClientRect = () => ({ top: 100, bottom: 600, left: 0, right: 400, width: 400, height: 500, x: 0, y: 100, toJSON() {} });
    heading()!.getBoundingClientRect = () => ({ top: 0, bottom: subjectBottom, left: 0, right: 400, width: 400, height: 20, x: 0, y: 0, toJSON() {} });
    await act(async () => {
      body.dispatchEvent(new Event('scroll'));
    });
  };
  await render(thread('session-refresh', 1));
  expect(bar()!.textContent).toBe('session-refresh');
  expect(bar()!.hasAttribute('data-on')).toBe(true);
  expect(bar()!.hasAttribute('title')).toBe(false);
  expect(await tooltipOf(barWords()!)).toBe(SUBJECT);
  expect(heading()!.textContent).toBe(SUBJECT);
  draw(thread(null, 3));
  await settle();
  expect(bar()!.textContent).toBe(SUBJECT);
  await scrollTo(200);
  expect(bar()!.hasAttribute('data-on')).toBe(false);
  await scrollTo(20);
  expect(bar()!.hasAttribute('data-on')).toBe(true);
  sized(barWords()!, 900, 120);
  expect(await tooltipOf(barWords()!)).toBe(SUBJECT);
});

test.skipIf(!hasDom)('a screen reader hears "Thread name: X" right after the heading for a named thread, and nothing extra for an unnamed one', async () => {
  await render(thread('session-refresh', 1));
  const sr = host!.querySelector<HTMLElement>('.ib-pbody .ib-sr[data-thread-name-sr]');
  expect(sr!.textContent).toBe('Thread name: session-refresh');
  expect(sr!.closest('[aria-hidden="true"]')).toBeNull();
  expect(heading()!.nextElementSibling).toBe(sr);
  draw(thread(null, 1));
  await settle();
  expect(host!.querySelector('[data-thread-name-sr]')).toBeNull();
  expect(host!.textContent).not.toContain('Thread name');
});
