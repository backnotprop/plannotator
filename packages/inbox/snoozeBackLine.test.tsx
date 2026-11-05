/**
 * "Back from snooze" as the thread draws it (approval `snooze-back-line`,
 * 2026-11-05): the existing divider's words when there is news, the same line
 * above the last message when there is none, whoever sent it. The rules behind
 * it are in snoozeBack.test.ts; the real browser proof, on screen included, is
 * tests/e2e/inbox-snooze-back.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'docs-site-abcdef', name: 'docs-site', root: '/work/docs-site', created_at: '2026-10-10T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const PERSON: InboxAuthor = { kind: 'person' };
const ROOT = 'msg_1';
const BACK = new Date(new Date().setHours(8, 0, 0, 0)).toISOString();
const WORDS = 'Back from snooze · 8:00 AM';

function message(id: string, author: InboxAuthor, seq: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author,
    subject: id === ROOT ? 'Search for the docs site' : null,
    body: `Body of ${id}.`,
    created_at: `2026-10-10T09:${String(seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...(author.kind === 'person' ? { sent_annotations: 0 } : {}),
    ...extra,
  };
}

function threadOf(messages: InboxMessageWire[], id = ROOT): InboxThread {
  return { thread_id: id, project: PROJECT, subject: 'Search for the docs site', thread_name: null, resolved_at: null, messages };
}

/** Everything read, the agent last. */
const agentLast = (lookAt = 9) => threadOf([message(ROOT, AGENT, 1, { person_seen_seq: lookAt }), message('msg_2', PERSON, 2), message('msg_3', AGENT, 3)]);
/** Everything read, the person last. */
const personLast = () => threadOf([message(ROOT, AGENT, 1, { person_seen_seq: 1 }), message('msg_2', PERSON, 2)]);
const oneMessage = () => threadOf([message(ROOT, AGENT, 1, { person_seen_seq: 1 })]);
/** Read through seq 2: two messages came in during the snooze. */
const withNews = () => threadOf([message(ROOT, AGENT, 1, { person_seen_seq: 2 }), message('msg_2', AGENT, 2), message('msg_3', AGENT, 3), message('msg_4', AGENT, 4)]);

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const restore: (() => void)[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return Response.json({ questions: [] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
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
  for (const undo of restore.splice(0).reverse()) undo();
});

function pane(thread: InboxThread, snoozeBack: string | null) {
  return (
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} snoozeBack={snoozeBack} />
    </div>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(thread: InboxThread, snoozeBack: string | null = BACK): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread, snoozeBack));
  });
  await settle();
  return host;
}

async function update(thread: InboxThread, snoozeBack: string | null = BACK) {
  act(() => root!.render(pane(thread, snoozeBack)));
  await settle();
}

const lines = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ib-newdiv')];
const below = (line: Element) => line.nextElementSibling?.getAttribute('data-message-article') ?? null;
const backLine = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-snooze-back-line]');

test.skipIf(!hasDom)('with news: the divider above the first new message says it, once, in place of "New since you looked"', async () => {
  const el = await render(withNews());
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(el.querySelector('[data-new-divider]')).toBe(backLine(el));
  expect(below(backLine(el)!)).toBe('msg_3');
  expect(backLine(el)!.getAttribute('aria-label')).toBe(`${WORDS}: 2 new messages`);
});

test.skipIf(!hasDom)('nothing new, the agent last: above the last message', async () => {
  const el = await render(agentLast());
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(below(backLine(el)!)).toBe('msg_3');
  expect(el.querySelector('[data-new-divider]')).toBeNull();
});

test.skipIf(!hasDom)('nothing new, the person last: above their message', async () => {
  const el = await render(personLast());
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(below(backLine(el)!)).toBe('msg_2');
});

test.skipIf(!hasDom)('one message: above it', async () => {
  const el = await render(oneMessage());
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(below(backLine(el)!)).toBe(ROOT);
});

test.skipIf(!hasDom)('all of it new: above the first message, where no divider draws', async () => {
  const el = await render(threadOf([message(ROOT, AGENT, 1, { person_seen_seq: null }), message('msg_2', AGENT, 2)]));
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(below(backLine(el)!)).toBe(ROOT);
});

test.skipIf(!hasDom)('an earlier day says the day', async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  twoDaysAgo.setHours(8, 0, 0, 0);
  const month = twoDaysAgo.toLocaleString('en-US', { month: 'short' });
  const el = await render(agentLast(), twoDaysAgo.toISOString());
  expect(backLine(el)!.textContent).toBe(`Back from snooze · ${month} ${twoDaysAgo.getDate()}, 8:00 AM`);
});

test.skipIf(!hasDom)('no return: the divider keeps its words, and with nothing new there is no line', async () => {
  const news = await render(withNews(), null);
  expect(lines(news).map((line) => line.textContent)).toEqual(['New since you looked']);
  expect(backLine(news)).toBeNull();
  act(() => root!.unmount());
  host!.remove();
  const quiet = await render(agentLast(), null);
  expect(lines(quiet)).toEqual([]);
});

test.skipIf(!hasDom)('the return under an open thread: the line appears at once; leaving the return takes it away', async () => {
  const el = await render(agentLast(), null);
  expect(backLine(el)).toBeNull();
  await update(agentLast());
  expect(backLine(el)!.textContent).toBe(WORDS);
  expect(below(backLine(el)!)).toBe('msg_3');
  await update(agentLast(), null);
  expect(backLine(el)).toBeNull();
});

test.skipIf(!hasDom)('a message arriving after keeps the line where it was, and has its own divider below', async () => {
  const before = agentLast(3);
  const el = await render(before);
  expect(below(backLine(el)!)).toBe('msg_3');
  await update(threadOf([...before.messages, message('msg_4', AGENT, 4)]));
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS, 'New since you looked']);
  expect(below(backLine(el)!)).toBe('msg_3');
  expect(below(el.querySelector('[data-new-divider]')!)).toBe('msg_4');
});

test.skipIf(!hasDom)('the person replying during the visit ends "new", and the line stays above the same message', async () => {
  const start = withNews();
  const el = await render(start);
  expect(below(backLine(el)!)).toBe('msg_3');
  await update(threadOf([...start.messages, message('msg_5', PERSON, 5)]));
  expect(el.querySelector('[data-new-divider]')).toBeNull();
  expect(lines(el).map((line) => line.textContent)).toEqual([WORDS]);
  expect(below(backLine(el)!)).toBe('msg_3');
});

test.skipIf(!hasDom)('the thread opens at the line, with nothing new too', async () => {
  // happy-dom has no layout: the line sits far down the thread, with the message before it just above.
  const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-snooze-back-line')) return 900;
      return this.nextElementSibling?.hasAttribute('data-snooze-back-line') ? 850 : 0;
    },
  });
  restore.push(() => {
    if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
  });
  const el = await render(agentLast());
  expect(el.querySelector<HTMLElement>('.ib-pbody')!.scrollTop).toBe(844);
});
