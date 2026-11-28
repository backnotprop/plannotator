/**
 * Assertions compare booleans, numbers and strings, never elements: a failed `expect(element)` makes bun print a
 * happy-dom node, which can take the test process down instead of failing the test.
 *
 * A Send always ends (the owner, on a phone: Send turned dim after pressing and never sent, until a refresh). A
 * connection that dies without a word gives the window no answer and no error, so a write with no limit held Send
 * for good. Each case is a fake network in front of a fake Inbox that keeps one message per idempotency key, as the
 * real store does (`InboxStore.sendReply` answers a key it has seen with the reply it wrote).
 *
 * - The reply's POST never answers: Send ends with the line that it may not have gone (a request given up may still
 *   arrive), the words stay in the box, Send works again.
 * - The reply landed but its answer was lost, and the read back fails too: the line says it may have gone; the next
 *   Send finds it and posts nothing.
 * - The reply arrives late, after the read back said it was not there: a read of the thread that shows it says it went
 *   and empties the box and its draft (only while the box holds the words sent; edited words stay, as a new reply);
 *   Send again before it arrives carries the same key, also after leaving the thread; the Inbox holds one reply.
 * - A refusal (4xx) or a connection refused says "was not sent", and nothing watches for that reply.
 * - A draft save that never answers no longer holds the Send that waits for it.
 * - A conflict retry (another client saved the same answer, sendSameAnswers.ts) still goes, with the same key, and a
 *   retry that never answers ends too.
 * - A good network: one POST, no read back, nothing after.
 *
 * The limit itself (inactivity, a slow answer that keeps coming is not cut off) is in apiWrite.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import { setWriteIdleForTests } from './apiWrite';
import { sendErrors, unconfirmed } from './data/actions/sendLanded';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { NewMessageComposer } = (hasDom ? await import('./components/NewMessage') : {}) as typeof import('./components/NewMessage');

/** The limit in these tests; the Send must end well within LIMIT + the read back. */
const LIMIT = 300;
const NOT_SENT = 'The reply was not sent. Send again to retry.';
const MAY_HAVE_GONE = 'The reply may not have gone. Send again: it looks for this one first, so it is not sent twice.';

const PROJECT: InboxProject = { id: 'prj_1', key: 'harbor-abcdef', name: 'harbor', root: '/work/harbor', created_at: '2026-11-27T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const THREAD = 'msg_01M7SA0000000000000000001';
const ASKED = 'msg_01M7SA0000000000000000002';
const CARD = ['Which region first?', '', ':::question', 'Which region should go first?', '', '- [ ] eu-west', '- [ ] us-east', ':::'].join('\n');

function questions(revision: number): InboxQuestion[] {
  return parseInboxQuestionBlocks(CARD).map(
    (q) =>
      ({
        key: q.key,
        position: q.position,
        kind: q.kind,
        prompt: q.prompt,
        context: q.parsed.context,
        choices: q.parsed.choices,
        recommendation: null,
        suggested_text: null,
        stopped: q.stopped,
        holds_up: q.holds_up,
        asked_by_agent_id: A.session,
        orphaned: false,
        state: 'picked',
        answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.parsed.choices[0]!.label] },
        revision,
        sent_revision: 0,
        picked_by: 'person',
        picked_at: '2026-11-27T10:03:00.000Z',
        sent_reply_id: null,
        message_id: ASKED,
        superseded_by: null,
      }) as unknown as InboxQuestion,
  );
}

const agentMessage = (id: string, body: string, revision?: number): InboxMessageWire => ({
  id,
  project_id: PROJECT.id,
  thread_id: THREAD,
  reply_to: id === THREAD ? null : THREAD,
  author: A,
  subject: id === THREAD ? 'Rollout order' : null,
  body,
  created_at: id === THREAD ? '2026-11-27T10:01:00.000Z' : '2026-11-27T10:02:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  ...(revision === undefined ? {} : { questions: questions(revision) }),
});

/** The thread as the fake Inbox holds it: the agent's messages and every reply it wrote. */
function threadNow(asks: boolean, revision: number): InboxThread {
  const replies = [...stored.values()].map(
    (r, i) =>
      ({
        id: r.id,
        project_id: PROJECT.id,
        thread_id: THREAD,
        reply_to: ASKED,
        author: { kind: 'person' },
        subject: null,
        body: r.words,
        created_at: `2026-11-27T10:1${i}:00.000Z`,
        resolved_at: null,
        idempotency_key: r.key,
      }) as InboxMessageWire,
  );
  return {
    thread_id: THREAD,
    project: PROJECT,
    subject: 'Rollout order',
    thread_name: null,
    resolved_at: null,
    messages: [agentMessage(THREAD, 'The rollout plan is ready.'), agentMessage(ASKED, asks ? CARD : 'Both regions are built.', asks ? revision : undefined), ...replies],
  };
}

type ReplyMode = 'ok' | 'hang' | 'land-then-hang' | 'conflict-then-ok' | 'conflict-then-hang' | 'refuse-4xx' | 'refused';

const WORDS = 'eu-west first, then us-east.';
const EDITED_MAY = 'Your earlier reply may have gone; Send sends your edited words as another reply.';
const EDITED_WENT = 'Your earlier reply went; Send sends your edited words as another reply.';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The fake Inbox's replies, by idempotency key: one per key, as the store keeps them. */
let stored: Map<string, { id: string; key: string; words: string }>;
let replyPosts: { key: string; words: string; revisions: number[] }[];
let threadReads: number;
let replyMode: ReplyMode;
let threadFails: boolean;
let draftSaveHangs: boolean;
let messagePosts: { key: string; body: string }[];
let messageHangs: boolean;
let revision: number;
/** The body of the last reply POST that never answered: `landLate` writes it, as a request that reached the Inbox late. */
let hungBody: { key: string; words: string } | null;
/** The thread's draft as the fake Inbox holds it: a save writes it, a reply carrying the same words clears it (`clear_draft`). */
let draftNow: string | null;

/** A request whose connection died without a word: it never answers, and ends only when the window gives it up. */
function silent(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  });
}

function write(key: string, words: string): Response {
  const had = stored.get(key);
  if (!had) store(key, words);
  return Response.json({ message_id: ASKED, questions: [], reply: { id: stored.get(key)!.id }, replayed: !!had });
}

function store(key: string, words: string): void {
  stored.set(key, { id: `msg_reply_${stored.size + 1}`, key, words });
  if (draftNow !== null && draftNow.trim() === words.trim()) draftNow = null;
}

function landLate(): void {
  if (hungBody && !stored.has(hungBody.key)) store(hungBody.key, hungBody.words);
}

beforeEach(() => {
  if (!hasDom) return;
  setWriteIdleForTests(LIMIT);
  stored = new Map();
  replyPosts = [];
  threadReads = 0;
  replyMode = 'ok';
  threadFails = false;
  draftSaveHangs = false;
  messagePosts = [];
  messageHangs = false;
  revision = 1;
  hungBody = null;
  draftNow = WORDS;
  savedFetch = globalThis.fetch;
  const draft = (body: string | null): InboxReplyDraft | null => (body === null ? null : { v: 1, thread_id: THREAD, body, created_at: '2026-11-27T10:05:00.000Z', updated_at: '2026-11-27T10:05:00.000Z' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const post = init?.method === 'POST';
    if (path.includes('/draft') && post && draftSaveHangs) return silent(init);
    if (path.endsWith('/draft/delete') && post) {
      draftNow = null;
      return Response.json({ ok: true, deleted: true });
    }
    // The box opens holding a saved draft; a save is taken as it is.
    if (path.includes('/draft') && post) draftNow = JSON.parse(String(init!.body)).body;
    if (path.includes('/draft')) return Response.json({ serverSession: 's', draft: draft(draftNow) });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    if (path.endsWith(`/threads/${THREAD}/message`) && post) {
      const body = JSON.parse(String(init!.body)) as { idempotency_key: string; body: string };
      messagePosts.push({ key: body.idempotency_key, body: body.body });
      if (messageHangs) return silent(init);
      return write(body.idempotency_key, body.body);
    }
    if (path.endsWith('/reply') && post) {
      const body = JSON.parse(String(init!.body)) as { idempotency_key: string; words: string; questions: { revision: number }[] };
      replyPosts.push({ key: body.idempotency_key, words: body.words, revisions: body.questions.map((q) => q.revision) });
      const first = replyPosts.length === 1;
      if (replyMode === 'hang') {
        hungBody = { key: body.idempotency_key, words: body.words };
        return silent(init);
      }
      if (replyMode === 'refused') throw new TypeError('Load failed');
      if (replyMode === 'refuse-4xx') return Response.json({ error: "EACCES: permission denied, open '/work/inbox/threads/x.jsonl'", code: 'validation_error' }, { status: 400 });
      if (replyMode === 'land-then-hang') {
        write(body.idempotency_key, body.words);
        return silent(init);
      }
      if ((replyMode === 'conflict-then-ok' || replyMode === 'conflict-then-hang') && first) {
        // Another client saved the same answer meanwhile: the Inbox's revision moved on.
        revision = 2;
        return Response.json({ error: 'That question changed since you read it.', code: 'question_revision_conflict' }, { status: 409 });
      }
      if (replyMode === 'conflict-then-hang') return silent(init);
      return write(body.idempotency_key, body.words);
    }
    if (path.endsWith(`/threads/${THREAD}`) && !post) {
      threadReads += 1;
      if (threadFails) throw new TypeError('Load failed');
      return Response.json({ serverSession: 's', thread: threadNow(replyMode.startsWith('conflict'), revision) });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // Words a failed Send saved back land on the stub before the real fetch is back.
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.fetch = savedFetch;
  setWriteIdleForTests(null);
  // A Send given up outlives its pane (it may still land): each case starts with none.
  unconfirmed.clear();
  sendErrors.clear();
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

const pane = (asks: boolean) => (
  <div className="pn-inbox">
    <ThreadPane thread={threadNow(asks, 1)} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone />
  </div>
);

/** The thread open (the box opens holding its draft, when there is one). */
async function mount(asks = false): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(asks));
  });
  await settle();
  return host;
}

async function open(asks = false): Promise<HTMLElement> {
  const el = await mount(asks);
  expect(!!el.querySelector('.ib-rbox textarea')).toBe(true);
  return el;
}

/** The thread read again (the live stream after a record), drawn with every reply the fake Inbox holds now. */
async function readAgain(): Promise<void> {
  act(() => root!.render(pane(false)));
  await settle(6);
}

/** The person leaves the thread (the pane goes). */
function leave(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const liveText = (el: HTMLElement) => [...el.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ');
/** The thread's foot offers the kept draft ("Edit draft") rather than an empty Reply. */
const footDraft = (el: HTMLElement) => [...el.querySelectorAll('.ib-pfoot button')].some((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Edit draft');

const type = (el: HTMLElement, words: string) =>
  act(() => {
    const field = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

/** What the person is left with: the line under the box, the box's words, and whether Send can be pressed. */
function state(el: HTMLElement) {
  const alert = el.querySelector<HTMLElement>('.ib-pfoot .ib-error[role="alert"]');
  const line = alert ? [...alert.childNodes].filter((n) => !(n instanceof HTMLElement && n.matches('[data-error-details]'))).map((n) => n.textContent).join('').trim() : null;
  const send = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]');
  return { line, words: el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')?.value ?? null, sendable: !!send && !send.disabled };
}

/** The Send is on its way (its button there and dim); after a Send that went, the box closes and no button is left. */
const busy = (el: HTMLElement) => !!el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]')?.disabled;

const pressSend = async (el: HTMLElement) => {
  const send = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]');
  expect(!!send && !send.disabled).toBe(true);
  await act(async () => send!.click());
};

/** Waits (in real time) until `done` holds, at most `ms`. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await settle(1, 25);
}

test.skipIf(!hasDom)("the reply's POST never answers: Send ends with the line that it may not have gone, the words stay in the box, and Send can be pressed again", async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await settle(2);
  // Busy while the POST is out.
  expect(state(el).sendable).toBe(false);
  await until(() => state(el).line !== null, LIMIT * 6);
  // Given up, it may still be on its way: never "was not sent".
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: WORDS, sendable: true });
  // It looked for the reply before saying so.
  expect(threadReads).toBe(1);
  expect(stored.size).toBe(0);
});

test.skipIf(!hasDom)('the reply landed but its answer was lost and the read back failed: it may have gone; the next Send finds it there and posts nothing', async () => {
  replyMode = 'land-then-hang';
  threadFails = true;
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: 'eu-west first, then us-east.', sendable: true });
  threadFails = false;
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  expect(replyPosts.length).toBe(1);
  expect(stored.size).toBe(1);
  expect(state(el).line).toBe(null);
});

test.skipIf(!hasDom)('the reply reached the Inbox late, after the read back: Send again looks for it first, finds it, and posts nothing', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: WORDS, sendable: true });
  // The first request reaches the Inbox now, after the window gave it up.
  landLate();
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  expect(replyPosts.length).toBe(1);
  expect(stored.size).toBe(1);
  expect(state(el).line).toBe(null);
});

test.skipIf(!hasDom)('Send again before the late reply arrives carries the same key: when the first request lands after it, the Inbox still holds one reply', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(replyPosts.map((p) => p.key)).toEqual([replyPosts[0]!.key, replyPosts[0]!.key]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('a reply given up that lands later is noticed by the next read of the thread: it went, the line goes, the box and its draft empty, one reply', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el).line).toBe(MAY_HAVE_GONE);
  landLate();
  await readAgain();
  const after = state(el);
  expect(after.line).toBe(null);
  expect(after.words === null || after.words === '').toBe(true);
  expect(liveText(el)).toContain('Your reply went.');
  // No draft of the sent words is left, here or in the Inbox.
  expect(footDraft(el)).toBe(false);
  await settle(4);
  expect(draftNow).toBe(null);
  expect(replyPosts.length).toBe(1);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('words edited after a Send given up stay when it lands: the earlier reply is said to have gone, and Send sends the edit as one new reply', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  const edit = 'eu-west first, then us-east, then ap-south.';
  type(el, edit);
  await settle(2);
  expect(state(el).line).toBe(EDITED_MAY);
  landLate();
  await readAgain();
  expect(state(el)).toEqual({ line: EDITED_WENT, words: edit, sendable: true });
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  expect(replyPosts.length).toBe(2);
  expect(replyPosts[1]!.key === replyPosts[0]!.key).toBe(false);
  expect([...stored.values()].map((r) => r.words)).toEqual([WORDS, edit]);
});

test.skipIf(!hasDom)('leaving the thread and coming back keeps a Send given up: Send again of the same words carries its key, so a late landing is still one reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  leave();
  el = await open();
  expect(state(el).words).toBe(WORDS);
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(replyPosts.map((p) => p.key)).toEqual([replyPosts[0]!.key, replyPosts[0]!.key]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('a Send given up that lands while the person is away is said to have gone when they come back, with nothing left to send', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  leave();
  landLate();
  el = await mount();
  await settle(4);
  expect(liveText(el)).toContain('Your reply went.');
  expect(!!el.querySelector('.ib-rbox textarea')).toBe(false);
  expect(footDraft(el)).toBe(false);
  expect(stored.size).toBe(1);
});

for (const [mode, line, reads] of [
  ['refuse-4xx', 'The reply was not sent.', 0],
  ['refused', NOT_SENT, 1],
] as const) {
  test.skipIf(!hasDom)(`a reply the Inbox did not take (${mode}) says it was not sent, and nothing watches for it`, async () => {
    replyMode = mode;
    const el = await open();
    await pressSend(el);
    await until(() => state(el).line !== null && !busy(el), LIMIT * 6);
    expect(state(el)).toEqual({ line, words: WORDS, sendable: true });
    expect(threadReads).toBe(reads);
    // Were a person reply with that key to show up, this window would not take it for its own Send.
    store(replyPosts[0]!.key, WORDS);
    await readAgain();
    expect(state(el)).toEqual({ line, words: WORDS, sendable: true });
    expect(liveText(el)).not.toContain('Your reply went.');
  });
}

test.skipIf(!hasDom)('a draft save that never answers does not hold the Send: the reply goes with the words in the box', async () => {
  draftSaveHangs = true;
  const el = await open();
  const field = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'eu-west first, then us-east, then ap-south.');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Send at once: the Send saves the words first and waits for that save.
  await pressSend(el);
  await until(() => stored.size > 0 && !busy(el), LIMIT * 8);
  expect(replyPosts.map((p) => p.words)).toEqual(['eu-west first, then us-east, then ap-south.']);
  expect(stored.size).toBe(1);
  draftSaveHangs = false;
});

test.skipIf(!hasDom)('another client saved the same answer: the conflict retry still goes, with the same key, at the new revision', async () => {
  replyMode = 'conflict-then-ok';
  const el = await open(true);
  await pressSend(el);
  await until(() => stored.size > 0 && !busy(el), LIMIT * 6);
  expect(replyPosts.map((p) => p.revisions)).toEqual([[1], [2]]);
  expect(replyPosts[1]!.key).toBe(replyPosts[0]!.key);
  expect(stored.size).toBe(1);
  expect(state(el).line).toBe(null);
});

test.skipIf(!hasDom)('a conflict retry that never answers ends too: the failure line, the words kept', async () => {
  replyMode = 'conflict-then-hang';
  const el = await open(true);
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 8);
  expect(replyPosts.length).toBe(2);
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: WORDS, sendable: true });
});

test.skipIf(!hasDom)('a good network: one POST, no read back, and nothing changes after the limit has passed', async () => {
  const el = await open();
  const readsBefore = threadReads;
  await pressSend(el);
  await until(() => stored.size > 0 && !busy(el), LIMIT * 4);
  const after = state(el);
  await settle(1, LIMIT * 3);
  expect(state(el)).toEqual(after);
  expect(after.line).toBe(null);
  expect(replyPosts.length).toBe(1);
  expect(threadReads).toBe(readsBefore);
});

describe('New message (a thread\'s live session)', () => {
  const target = { session: 'ses_a', host: 'claude-code', started_at: '2026-11-27T09:00:00.000Z', last_seen_at: '2026-11-27T10:20:00.000Z', busy: false, idle_since: null, wrote_thread: true };
  let sent = 0;

  async function compose(): Promise<HTMLElement> {
    sent = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <div className="pn-inbox">
          <NewMessageComposer thread={threadNow(false, 1)} target={target} onCancel={() => {}} onSent={async () => void (sent += 1)} />
        </div>,
      );
    });
    await settle(2);
    return host;
  }

  const type = (el: HTMLElement, words: string) =>
    act(() => {
      const field = el.querySelector<HTMLTextAreaElement>('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, words);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const send = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.ib-acts button')].find((b) => b.textContent?.trim() === 'Send')!;
  const left = (el: HTMLElement) => ({
    line: el.querySelector('.ib-error[role="alert"]')?.textContent ?? null,
    words: el.querySelector<HTMLTextAreaElement>('textarea')?.value ?? null,
    sendable: !send(el).disabled,
  });

  test.skipIf(!hasDom)('a message whose POST never answers ends with the failure line, the words kept; Send again of the same words carries the same key', async () => {
    messageHangs = true;
    const el = await compose();
    type(el, 'Also bump the client to 2.4.');
    await act(async () => send(el).click());
    await settle(2);
    expect(left(el).sendable).toBe(false);
    await until(() => left(el).line !== null, LIMIT * 6);
    expect(left(el)).toEqual({ line: 'The message was not sent. Send again to retry.', words: 'Also bump the client to 2.4.', sendable: true });
    // It reached the Inbox after all; the retry is answered with it.
    write(messagePosts[0]!.key, messagePosts[0]!.body);
    messageHangs = false;
    await act(async () => send(el).click());
    await until(() => sent > 0, LIMIT * 6);
    expect(messagePosts.map((p) => p.key)).toEqual([messagePosts[0]!.key, messagePosts[0]!.key]);
    expect(stored.size).toBe(1);
  });

  test.skipIf(!hasDom)('edited words after a failed Send go as a new message, never swallowed by the first one\'s key', async () => {
    messageHangs = true;
    const el = await compose();
    type(el, 'Also bump the client.');
    await act(async () => send(el).click());
    await until(() => left(el).line !== null, LIMIT * 6);
    messageHangs = false;
    type(el, 'Also bump the client to 2.4, and the docs.');
    await act(async () => send(el).click());
    await until(() => sent > 0, LIMIT * 6);
    expect(messagePosts.length).toBe(2);
    expect(messagePosts[1]!.key === messagePosts[0]!.key).toBe(false);
    expect([...stored.values()].map((m) => m.words)).toEqual(['Also bump the client to 2.4, and the docs.']);
  });
});
