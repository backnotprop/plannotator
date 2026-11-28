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
 *   Send again before it arrives carries the same key, also after leaving the thread, after a Send again that did not
 *   go (refused, stopped before its words, or failed with its look up failing too), after a reload (a day at most, its
 *   record back while another thread sends too), and after going to another thread during Send again's look for it
 *   (nothing goes there); the Inbox holds one reply. A read of the thread while Send again is on its way does not end
 *   that Send halfway. One that landed before a reload is seen as gone once its record is back: new words are a new
 *   reply. Discard takes its words out of the browser, and a long one never pushes another thread's kept words out.
 * - A refusal (4xx) or a connection refused says "was not sent", and nothing watches for that reply.
 * - A draft save that never answers no longer holds the Send that waits for it.
 * - A conflict retry (another client saved the same answer, sendSameAnswers.ts) still goes, with the same key, and a
 *   retry that never answers ends too.
 * - A good network: one POST, no read back, nothing after.
 * - One press is one Send (the box's controller calls the pane's Send once), and Discard pressed while a Send is on its
 *   way does nothing: when that Send then fails, the words are still in the box and in its draft. The Draft line's
 *   Discard is disabled while it is out, and pressable again when it ends, gone or not.
 * - ⌘/Ctrl+Enter pressed while a Send is out is no press: a later click Send that lands draws no keyboard ring on the
 *   message (only a Send by ⌘/Ctrl+Enter does).
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

/** Session B, whose question a two-session Send answers in its own reply before the words go to A. */
const B: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_b', name: 'Claude Code' };
const ASKED_B = 'msg_01M7SA0000000000000000003';

function questions(revision: number, messageId = ASKED, asker = A.session): InboxQuestion[] {
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
        asked_by_agent_id: asker,
        orphaned: false,
        state: 'picked',
        answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.parsed.choices[0]!.label] },
        revision,
        sent_revision: 0,
        picked_by: 'person',
        picked_at: '2026-11-27T10:03:00.000Z',
        sent_reply_id: null,
        message_id: messageId,
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
    messages: [
      agentMessage(THREAD, 'The rollout plan is ready.'),
      // Two sessions: B asked first, then A wrote last (the words answer A).
      ...(twoSessions ? [{ ...agentMessage(ASKED_B, CARD), author: B, created_at: '2026-11-27T10:01:30.000Z', questions: questions(revision, ASKED_B, B.session) }] : []),
      agentMessage(ASKED, asks ? CARD : 'Both regions are built.', asks ? revision : undefined),
      ...replies,
    ],
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
/** How the next reply POSTs are answered, one each, before `replyMode` takes over again. */
let replyModes: ReplyMode[];
/** The thread has B's question too (`threadNow`). */
let twoSessions: boolean;
/** While set, a read of the thread answers only once it resolves, with the thread as it was when asked (a slow link). */
let threadGate: Promise<void> | null;
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
  replyModes = [];
  twoSessions = false;
  threadGate = null;
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
      const replyMode = replyModes.shift() ?? replyModeNow();
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
      const asOfAsking = threadNow(replyMode.startsWith('conflict'), revision);
      if (threadGate) await threadGate;
      return Response.json({ serverSession: 's', thread: asOfAsking });
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

const replyModeNow = () => replyMode;

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

/**
 * The page reloads (or the browser ends the tab): nothing of this page's memory is left, a new page opens the thread.
 * What the browser keeps stays; the old page's heartbeat is old (it went), so its entries are free to take.
 */
async function reload(): Promise<void> {
  leave();
  Map.prototype.clear.call(unconfirmed);
  sendErrors.clear();
  (await import('./replyDraft')).resetReplyDraftPageForTests();
  for (const key of Object.keys(localStorage)) if (key.startsWith('plannotator-inbox-reply-kept-alive:')) localStorage.setItem(key, String(Date.now() - 60_000));
}

test.skipIf(!hasDom)('a reload between a Send given up and Send again keeps its keys: the new page sends that reply, so a late landing is one reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  await reload();
  el = await open();
  expect(state(el).words).toBe(WORDS);
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(replyPosts.map((p) => p.key)).toEqual([replyPosts[0]!.key, replyPosts[0]!.key]);
  expect(stored.size).toBe(1);
  // Sent: nothing of it is kept in the browser any more.
  expect(Object.keys(localStorage).filter((key) => key.startsWith('plannotator-inbox-reply-kept:') && key.endsWith(':late'))).toEqual([]);
});

test.skipIf(!hasDom)('a Send given up more than a day before the reload is not looked for again: Send again is an ordinary Send', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  await reload();
  for (const key of Object.keys(localStorage).filter((k) => k.endsWith(':late'))) {
    const entry = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...entry, send: { ...entry.send, at: Date.now() - 25 * 60 * 60_000 } }));
  }
  el = await open();
  const reads = threadReads;
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  expect(replyPosts.length).toBe(2);
  expect(replyPosts[1]!.key === replyPosts[0]!.key).toBe(false);
  expect(threadReads).toBe(reads);
});

/** Keys of the reply POSTs that carried words, in order. */
const wordKeys = () => replyPosts.filter((p) => p.words !== '').map((p) => p.key);

test.skipIf(!hasDom)('a Send again the Inbox refuses keeps the first one watched: after leaving and coming back, Send carries its key, so a late landing is one reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  // Send again: not there yet, and this one is refused (nothing written by it), while the first may still be on its way.
  replyMode = 'refuse-4xx';
  await pressSend(el);
  await until(() => state(el).line === 'The reply was not sent.' && !busy(el), LIMIT * 6);
  leave();
  el = await open();
  expect(state(el).words).toBe(WORDS);
  replyMode = 'ok';
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(wordKeys()).toEqual([replyPosts[0]!.key, replyPosts[0]!.key, replyPosts[0]!.key]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('a two-session Send again that stops before its words go (the first reply gets no answer) keeps the first one watched: after leaving and coming back, one reply of the words', async () => {
  twoSessions = true;
  // First Send: B's answers go, the words to A get no answer.
  replyModes = ['ok', 'hang'];
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null && !busy(el), LIMIT * 8);
  expect(state(el).line).toBe(MAY_HAVE_GONE);
  const words = wordKeys();
  expect(words.length).toBe(1);
  // Send again: B's reply gets no answer, so the words are never posted by it.
  replyModes = ['hang'];
  await pressSend(el);
  await until(() => replyPosts.length === 3 && state(el).line !== null && !busy(el), LIMIT * 8);
  expect(wordKeys()).toEqual(words);
  leave();
  el = await open();
  expect(state(el).words).toBe(WORDS);
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 8);
  landLate();
  expect(wordKeys()).toEqual([words[0]!, words[0]!]);
  expect([...stored.values()].filter((r) => r.words !== '').length).toBe(1);
});

test.skipIf(!hasDom)('a read of the thread that shows the late reply while Send again is on its way does not end that Send halfway: it goes with the same key, one reply', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  replyMode = 'ok';
  // Send again looks for the first reply; that read is slow, and answers with the thread as it was (not there yet).
  let open_ = () => {};
  threadGate = new Promise<void>((resolve) => (open_ = resolve));
  const reads = threadReads;
  await pressSend(el);
  await until(() => threadReads > reads, LIMIT * 4);
  // Meanwhile the first request lands and the live stream draws it.
  landLate();
  threadGate = null;
  await readAgain();
  open_();
  await until(() => !busy(el), LIMIT * 8);
  await settle(4);
  expect(replyPosts.every((p) => p.key === replyPosts[0]!.key)).toBe(true);
  expect(stored.size).toBe(1);
  const after = state(el);
  expect(after.words === null || after.words === '').toBe(true);
  expect(after.line).toBe(null);
});

/** The browser's copies of Sends given up (replyWordsKept.ts `keepLate`). */
const lateCopies = () => Object.keys(localStorage).filter((key) => key.startsWith('plannotator-inbox-reply-kept:') && key.endsWith(':late'));

test.skipIf(!hasDom)('a Send given up that landed before a reload is seen as gone once the new page takes its record back: no "may have gone", and new words go as a new reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  const first = replyPosts[0]!.key;
  // It lands (its clear_draft empties the draft), then the page reloads: the thread is drawn with it before the record comes back.
  landLate();
  await reload();
  el = await mount();
  await settle(6);
  expect(unconfirmed.has(THREAD)).toBe(false);
  expect(lateCopies()).toEqual([]);
  expect(liveText(el)).toContain('Your reply went.');
  act(() => [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply')!.click());
  await settle(2);
  type(el, 'eu-west first');
  await settle(2);
  expect(state(el).line === EDITED_MAY).toBe(false);
  // The same words again (a "continue" sent twice): a new reply, never taken for the one that went.
  type(el, WORDS);
  await settle(2);
  replyMode = 'ok';
  await readAgain();
  expect(state(el).words).toBe(WORDS);
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  expect(replyPosts.length).toBe(2);
  expect(replyPosts[1]!.key === first).toBe(false);
  expect(stored.size).toBe(2);
});

const OTHER = 'msg_01M7SA0000000000000000009';
const OTHER_ASKED = 'msg_01M7SA0000000000000000010';
const OTHER_WORDS = 'Bill monthly.';
const otherThread = (): InboxThread => ({
  thread_id: OTHER,
  project: PROJECT,
  subject: 'Billing',
  thread_name: null,
  resolved_at: null,
  messages: [
    { ...agentMessage(THREAD, 'Billing is next.'), id: OTHER, thread_id: OTHER, subject: 'Billing' },
    { ...agentMessage(ASKED, 'Monthly or yearly?'), id: OTHER_ASKED, thread_id: OTHER, reply_to: OTHER },
  ],
});
const otherPane = () => (
  <div className="pn-inbox">
    <ThreadPane thread={otherThread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone />
  </div>
);
/** A second thread, with its own draft; its replies never answer (`otherPosts` counts them, `otherDraftWrites` its draft's writes). */
let otherPosts = 0;
let otherDraftWrites: string[] = [];
function withOther(): void {
  const inner = globalThis.fetch;
  otherPosts = 0;
  otherDraftWrites = [];
  const draft = { v: 1, thread_id: OTHER, body: OTHER_WORDS, created_at: '2026-11-27T10:05:00.000Z', updated_at: '2026-11-27T10:05:00.000Z' };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const at = String(input);
    if (at.includes(`/messages/${OTHER_ASKED}/reply`)) {
      otherPosts += 1;
      return silent(init);
    }
    if (at.endsWith(`/threads/${OTHER}`)) return Response.json({ serverSession: 's', thread: otherThread() });
    if (at.includes(`/threads/${OTHER}/draft`)) {
      if (init?.method === 'POST') otherDraftWrites.push(at);
      return Response.json({ serverSession: 's', draft });
    }
    return inner(input, init);
  }) as typeof fetch;
}

test.skipIf(!hasDom)('Send again whose person goes to another thread during its look for the first reply sends nothing there; back, Send carries the first key: one reply', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  const first = replyPosts[0]!.key;
  withOther();
  replyMode = 'ok';
  let open_ = () => {};
  threadGate = new Promise<void>((resolve) => (open_ = resolve));
  const reads = threadReads;
  await pressSend(el);
  await until(() => threadReads > reads, LIMIT * 4);
  act(() => root!.render(otherPane()));
  await settle(2);
  threadGate = null;
  open_();
  await until(() => replyPosts.length > 1, LIMIT * 2);
  await settle(4);
  // Nothing went for it while away, under the other thread's keys or any.
  expect(replyPosts.length).toBe(1);
  act(() => root!.render(pane(false)));
  await settle(4);
  expect(state(el).words).toBe(WORDS);
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(wordKeys()).toEqual([first, first]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)("Send again's look for the first reply answers after the person went to another thread: that thread is untouched; back, the reply is seen as gone", async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  // The first request reaches the Inbox now; the pane has not drawn it yet.
  landLate();
  withOther();
  let open_ = () => {};
  threadGate = new Promise<void>((resolve) => (open_ = resolve));
  const reads = threadReads;
  await pressSend(el);
  await until(() => threadReads > reads, LIMIT * 4);
  act(() => root!.render(otherPane()));
  await settle(4);
  type(el, 'Yearly, with a discount.');
  await settle(2);
  const writes = otherDraftWrites.length;
  // The slow look answers now: the reply is there.
  threadGate = null;
  open_();
  await settle(8);
  expect(state(el).words).toBe('Yearly, with a discount.');
  expect(state(el).line).toBe(null);
  expect(liveText(el).includes('Your reply went.')).toBe(false);
  expect(otherDraftWrites.slice(writes).some((at) => at.endsWith('/delete'))).toBe(false);
  expect(unconfirmed.has(OTHER)).toBe(false);
  expect(!!unconfirmed.get(THREAD)?.late).toBe(true);
  // Back: the thread drawn with the reply finishes it the usual way.
  act(() => root!.render(pane(false)));
  await settle(6);
  expect(liveText(el)).toContain('Your reply went.');
  expect(unconfirmed.has(THREAD)).toBe(false);
  expect(replyPosts.length).toBe(1);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('a reload whose record comes back while another thread is sending: the next Send of this thread carries its key, so a late landing is one reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  const first = replyPosts[0]!.key;
  const hung = hungBody;
  await reload();
  withOther();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(otherPane());
  });
  await settle();
  el = host;
  await pressSend(el);
  await until(() => otherPosts === 1, LIMIT * 4);
  // Back to the thread while the other thread's Send is on its way: its record comes back then.
  act(() => root!.render(pane(false)));
  await settle(4);
  await until(() => sendErrors.has(OTHER), LIMIT * 8);
  await settle(2);
  replyMode = 'ok';
  expect(state(el).words).toBe(WORDS);
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  hungBody = hung;
  landLate();
  expect(wordKeys()).toEqual([first, first]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('Send again that fails on the network and cannot look its reply up keeps the first one watched, in the browser too: after leaving and coming back, one reply', async () => {
  replyMode = 'hang';
  let el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  const first = replyPosts[0]!.key;
  // Send again: the look for the first reply answers (not there), its POST fails on the network, and the look after it fails too.
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/reply') && init?.method === 'POST') threadFails = true;
    return inner(input, init);
  }) as typeof fetch;
  replyModes = ['refused'];
  replyMode = 'ok';
  await pressSend(el);
  await until(() => threadFails && !busy(el) && state(el).line !== null, LIMIT * 6);
  expect(!!unconfirmed.get(THREAD)?.late).toBe(true);
  expect(lateCopies().length).toBe(1);
  threadFails = false;
  leave();
  el = await open();
  await pressSend(el);
  await until(() => state(el).words === null || state(el).words === '', LIMIT * 6);
  landLate();
  expect(wordKeys()).toEqual([first, first, first]);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('Discard after a Send given up takes its words out of the browser; a late landing is still said to have gone', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(lateCopies().length).toBe(1);
  act(() => el.querySelector<HTMLButtonElement>('[data-draft-discard]')!.click());
  await settle(4);
  expect(lateCopies()).toEqual([]);
  landLate();
  await readAgain();
  expect(liveText(el)).toContain('Your reply went.');
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)("a long reply's record given up never pushes another thread's kept words out of the browser", async () => {
  const kept = await import('./replyWordsKept');
  // Another thread's words whose save failed: this browser holds the only copy.
  kept.keepWords('msg_kept_failed', { kind: 'failed', words: 'f'.repeat(90_000), base: null });
  const long = 'l'.repeat(40_000);
  kept.keepLate('msg_kept_late', long, { words: long, late: { contents: [['w', { value: long, answers: [] }]] } });
  const keys = Object.keys(localStorage);
  expect(keys.some((key) => key.endsWith(':msg_kept_failed'))).toBe(true);
  kept.forgetWords('msg_kept_failed');
  kept.forgetWords('msg_kept_late', ':late');
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

test.skipIf(!hasDom)('one press is one Send: a second press while it is out posts nothing, and Send again after it was given up carries the same key', async () => {
  replyMode = 'hang';
  const el = await open();
  const send = el.querySelector<HTMLButtonElement>('.ib-rbox [data-reply-send]')!;
  await act(async () => {
    send.click();
    send.click();
  });
  await settle(2);
  expect(replyPosts.length).toBe(1);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: WORDS, sendable: true });
  replyMode = 'ok';
  await pressSend(el);
  await until(() => stored.size === 1 && !busy(el), LIMIT * 6);
  expect(replyPosts.map((p) => p.words)).toEqual([WORDS, WORDS]);
  expect(replyPosts[1]!.key).toBe(replyPosts[0]!.key);
  expect(stored.size).toBe(1);
});

test.skipIf(!hasDom)('Discard pressed while a Send is on its way does nothing: when that Send then fails, the words are still in the box and its draft', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await settle(2);
  expect(busy(el)).toBe(true);
  // The bin (a computer) and the Draft line's Discard (a phone, above the box): whichever this box draws.
  const discards = [...el.querySelectorAll<HTMLButtonElement>('[data-reply-discard], [data-draft-stamp] [data-draft-discard]')];
  expect(discards.length > 0).toBe(true);
  await act(async () => {
    for (const button of discards) button.click();
  });
  await settle(2);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el)).toEqual({ line: MAY_HAVE_GONE, words: WORDS, sendable: true });
  expect(draftNow).toBe(WORDS);
});

/** ⌘/Ctrl+Enter in the box's field. */
const chord = (el: HTMLElement) =>
  act(() => {
    const field = el.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
/** The keyboard ring a Send by ⌘/Ctrl+Enter leaves on the message it lands at (Thread.tsx `byChord`). */
const sentRings = (el: HTMLElement) => el.querySelectorAll('[data-sent-focus]').length;

test.skipIf(!hasDom)('⌘/Ctrl+Enter pressed while a Send is out is no press: when that Send fails and a click Send lands, no keyboard ring is drawn', async () => {
  replyMode = 'hang';
  const el = await open();
  await pressSend(el);
  await settle(2);
  expect(busy(el)).toBe(true);
  await chord(el);
  await settle(1);
  expect(replyPosts.length).toBe(1);
  await until(() => state(el).line !== null, LIMIT * 6);
  expect(state(el).line).toBe(MAY_HAVE_GONE);
  replyMode = 'ok';
  await pressSend(el);
  await until(() => stored.size === 1 && !busy(el), LIMIT * 6);
  await settle(4);
  expect(sentRings(el)).toBe(0);
});

test.skipIf(!hasDom)('a Send by ⌘/Ctrl+Enter that lands draws the keyboard ring on the message', async () => {
  const el = await open();
  await chord(el);
  await until(() => stored.size === 1 && !busy(el), LIMIT * 6);
  await settle(4);
  expect(sentRings(el)).toBe(1);
});

/** Reply POSTs wait until `release()`; each then goes on as `replyMode` says. */
function holdReplies(): () => void {
  const inner = globalThis.fetch;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/reply') && init?.method === 'POST') await held;
    return inner(input, init);
  }) as typeof fetch;
  return release;
}

/** The Draft line's Discard (a phone, above the box; this file's pane is a phone's): null when none is drawn, else whether it can be pressed. */
function discardable(el: HTMLElement): boolean | null {
  const button = el.querySelector<HTMLButtonElement>('[data-draft-stamp] [data-draft-discard]');
  return button ? !button.disabled : null;
}

test.skipIf(!hasDom)("the Draft line's Discard is disabled while a Send is out, and pressable again when the Send fails", async () => {
  const release = holdReplies();
  replyMode = 'refuse-4xx';
  const el = await open();
  expect(discardable(el)).toBe(true);
  await pressSend(el);
  await settle(2);
  expect(busy(el)).toBe(true);
  expect(discardable(el)).toBe(false);
  release();
  await until(() => state(el).line !== null && !busy(el), LIMIT * 6);
  expect(state(el)).toEqual({ line: 'The reply was not sent.', words: WORDS, sendable: true });
  expect(discardable(el)).toBe(true);
});

test.skipIf(!hasDom)("the Draft line's Discard is disabled while a Send is out, and pressable in the next reply once it went", async () => {
  const release = holdReplies();
  const el = await open();
  await pressSend(el);
  await settle(2);
  expect(busy(el)).toBe(true);
  expect(discardable(el)).toBe(false);
  release();
  await until(() => stored.size === 1 && !busy(el), LIMIT * 6);
  await settle(2);
  act(() => [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply')!.click());
  await settle(2);
  type(el, 'Also ap-south.');
  // The Draft line shows its Discard once the words are saved.
  await until(() => discardable(el) !== null, LIMIT * 6);
  expect(discardable(el)).toBe(true);
});
