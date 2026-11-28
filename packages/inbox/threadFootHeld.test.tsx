/**
 * A comment on a linked computer's message that its Inbox has not confirmed yet (linked machines, rule 12): the
 * write waits in this Inbox's outbox (`202`), and the thread's foot says "Sending to Laptop: this applies once Laptop
 * confirms." That is a status, not a failure: the owner saw it in red above Send and read it as broken.
 *
 * Failures to catch: the held sentence drawn as an error (the red `.ib-error`, `role="alert"`); a real failure no
 * longer drawn as one; the status still there after the outbox's own frame says the other computer took it; a write
 * refused there leaving the calm status instead of saying it did not land.
 *
 * Driven through the real ThreadPane, ui Viewer and web-highlighter; fetch is stubbed, no Inbox server. DOM-gated
 * (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView, OutboxView } from './api';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const LAPTOP_ID = `ibx_01K${'0'.repeat(22)}P`;
const PROJECT: InboxProject = { id: 'prj_far', key: 'fern-api-abcdef', name: 'fern-api', root: '/work/fern-api', created_at: '2026-11-20T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KHELDFOOTLINE00000000001';
const WORDS = 'move the retry into the harbor client';
const BODY = `I would ${WORDS} and keep the rest as it is.`;
const SENDING = 'Sending to Laptop: this applies once Laptop confirms.';
const WAITING = 'Waiting for Laptop: this applies when Laptop is back.';

const laptop = (state: MachineView['state'] = 'online'): MachineView => ({
  id: LAPTOP_ID,
  name: 'Laptop',
  self: false,
  state,
  since: '2026-11-20T10:00:00.000Z',
  reason: null,
  version: '0.29.7',
  address: null,
  both_ways: true,
  waiting: 0,
  message_deletions: true,
});

const model: InboxThread = {
  thread_id: M1,
  project: PROJECT,
  subject: 'Retry',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: M1,
      project_id: PROJECT.id,
      thread_id: M1,
      reply_to: null,
      author: AGENT,
      subject: 'Retry',
      body: BODY,
      created_at: '2026-11-20T10:15:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      seq: 1,
      questions: [],
    },
  ],
};

const entry = (key: string, state: OutboxView['state']): OutboxView => ({
  key,
  machine: LAPTOP_ID,
  route: `messages/${M1}/annotations`,
  state,
  queued_at: '2026-11-20T10:50:00.000Z',
  settled_at: state === 'queued' ? null : '2026-11-20T11:00:00.000Z',
  status: state === 'refused' ? 409 : state === 'delivered' ? 200 : null,
  answer: state === 'refused' ? { error: 'That message was archived.' } : null,
  notice: state === 'refused' ? { kind: 'refused', at: '2026-11-20T11:00:00.000Z' } : null,
  dismissed: false,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts = 0;
/** How the save is answered: held for Laptop (as it is, or asleep), or refused here. */
let answer: 'held' | 'held-asleep' | 'refused' = 'held';

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  posts = 0;
  answer = 'held';
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/annotations') && init?.method === 'POST') {
      posts += 1;
      if (answer === 'refused') return Response.json({ error: 'That message was archived.', code: 'message_closed' }, { status: 409 });
      return Response.json({ outbox: entry(`k${posts}`, 'queued'), machine: laptop(answer === 'held' ? 'online' : 'offline') }, { status: 202 });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** The window's outbox, every entry by key (the thread shows its own; the foot's line follows its held write). */
function draw(outbox: ReadonlyMap<string, OutboxView>) {
  root!.render(
    <ThreadPane thread={model} machine={laptop()} outboxAll={outbox} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />,
  );
}

async function render() {
  rememberMachine([M1], LAPTOP_ID);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    draw(new Map());
  });
  await settle();
  return host;
}

/** Select `phrase` in the message the way a drag does, and press the toolbar's Delete (it saves at once). */
async function deleteWords(scope: HTMLElement, phrase: string) {
  const body = scope.querySelector<HTMLElement>(`[data-message-id="${M1}"][data-text-comments]`)!;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? body).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Delete"], .annotation-toolbar button[title="Delete"]')!.click());
  await settle();
  await settle();
}

/** The red error line (the CSS draws `.ib-error` in the destructive colour) and the calm status line, by their words. */
const errorWith = (words: string) => [...document.querySelectorAll<HTMLElement>('.ib-error, [role="alert"]')].filter((el) => el.textContent?.includes(words)).length;
const statusWith = (words: string) => [...document.querySelectorAll<HTMLElement>('[role="status"]')].filter((el) => el.textContent?.includes(words) && !el.closest('.ib-error')).length;

test.skipIf(!hasDom)('a comment held for Laptop reads as a status, not an error, and goes once Laptop confirms it', async () => {
  const el = await render();
  await deleteWords(el, WORDS);
  expect(posts).toBe(1);
  expect(statusWith(SENDING)).toBe(1);
  expect(errorWith(SENDING)).toBe(0);

  // The outbox's frame: still on its way, then taken there. The status lasts as long as its write waits, no longer.
  act(() => draw(new Map([['k1', entry('k1', 'queued')]])));
  await settle();
  expect(statusWith(SENDING)).toBe(1);
  act(() => draw(new Map([['k1', entry('k1', 'delivered')]])));
  await settle();
  expect(statusWith(SENDING)).toBe(0);
  expect(errorWith(SENDING)).toBe(0);
});

test.skipIf(!hasDom)('held while Laptop sleeps: "Waiting for Laptop" is a status too; refused there, an error says it did not land', async () => {
  answer = 'held-asleep';
  const el = await render();
  await deleteWords(el, WORDS);
  expect(statusWith(WAITING)).toBe(1);
  expect(errorWith(WAITING)).toBe(0);

  act(() => draw(new Map([['k1', entry('k1', 'refused')]])));
  await settle();
  expect(statusWith(WAITING)).toBe(0);
  expect(document.querySelector('.ib-error[role="alert"][data-foot-error], .ib-error[role="alert"]')?.textContent).toBe('Not delivered: That message was archived.');
});

test.skipIf(!hasDom)('a real failure on Laptop\'s message is still an error', async () => {
  answer = 'refused';
  const el = await render();
  await deleteWords(el, WORDS);
  expect(errorWith('That message was archived.')).toBeGreaterThan(0);
  expect(document.querySelector('.ib-error[role="alert"]')?.textContent).toBe('That message was archived.');
  expect(statusWith('That message was archived.')).toBe(0);
});
