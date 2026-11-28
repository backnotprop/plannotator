/**
 * The limit on a write the person waits on (apiWrite.ts): it ends a connection that died without a word, and only
 * that. It counts time with nothing arriving, so an answer that keeps coming on a slow link is never cut off; a
 * good network sees one request and no timer left behind; a write that does not ask for it waits as before.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { inboxApi, post } from './api';
import { InboxWriteTimeout, LAUNCH_IDLE_MS, WITHIN, WRITE_IDLE_MS, setWriteIdleForTests } from './apiWrite';

const LIMIT = 200;
const realFetch = globalThis.fetch;
let calls: { url: string; signal: AbortSignal | null }[] = [];

beforeEach(() => {
  setWriteIdleForTests(LIMIT);
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setWriteIdleForTests(null);
});

/** A fake network: each request is recorded, then answered by `answer`. */
function network(answer: (init: RequestInit | undefined) => Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? null });
    return answer(init);
  }) as typeof fetch;
}

/** A connection that died without a word: no answer, no error, until the window gives it up. */
const silent = (init: RequestInit | undefined) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

/** An answer whose body comes in `parts`, one every `gap` ms; with `stallAfter`, it stops coming after that many. */
function trickle(parts: string[], gap: number, stallAfter = Infinity): (init: RequestInit | undefined) => Promise<Response> {
  return async (init) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= stallAfter) return new Promise<void>(() => init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))));
        await new Promise((resolve) => setTimeout(resolve, gap));
        if (sent >= parts.length) return controller.close();
        controller.enqueue(new TextEncoder().encode(parts[sent++]));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function outcome<T>(work: Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = Date.now();
  try {
    return { value: await work, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

test('a reply whose connection died without a word ends with InboxWriteTimeout soon after the limit, and the request is aborted', async () => {
  network(silent);
  const result = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k1', words: 'Ship it.', questions: [] }));
  expect(result.error instanceof InboxWriteTimeout).toBe(true);
  expect(result.ms).toBeGreaterThanOrEqual(LIMIT - 20);
  expect(result.ms).toBeLessThan(LIMIT * 5);
  expect(calls.length).toBe(1);
  expect(calls[0]!.signal?.aborted).toBe(true);
});

test('an answer that keeps coming on a slow link is not cut off: each part starts the wait again, though the whole takes many limits', async () => {
  const json = JSON.stringify({ message_id: 'msg_A', questions: [], reply: { id: 'msg_R', body: 'x'.repeat(200) }, replayed: false });
  const parts = Array.from({ length: 8 }, (_, i) => json.slice((i * json.length) / 8, ((i + 1) * json.length) / 8));
  network(trickle(parts, LIMIT / 2));
  const result = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k1', words: 'Ship it.', questions: [] }));
  expect(result.error).toBe(undefined);
  expect((result.value?.reply as { id?: string } | null)?.id).toBe('msg_R');
  expect(result.ms).toBeGreaterThan(LIMIT * 3);
});

test('an answer that starts and then stops coming ends too', async () => {
  network(trickle(['{"message_id":', '"msg_A",', '"questions":[]}'], 20, 1));
  const result = await outcome(inboxApi.newMessage('thr_A', { session: 'ses_a', body: 'Also update the changelog.', idempotency_key: 'k2' }));
  expect(result.error instanceof InboxWriteTimeout).toBe(true);
  expect(result.ms).toBeLessThan(LIMIT * 5);
});

test('a good network: one request, the answer as sent, and no timer left to abort it afterwards', async () => {
  network(async () => Response.json({ message: { id: 'msg_N' }, replayed: false }));
  const result = await outcome(inboxApi.newMessage('thr_A', { session: 'ses_a', body: 'Also update the changelog.', idempotency_key: 'k2' }));
  expect(result.error).toBe(undefined);
  expect((result.value?.message as { id?: string } | null)?.id).toBe('msg_N');
  await new Promise((resolve) => setTimeout(resolve, LIMIT * 2));
  expect(calls.length).toBe(1);
  expect(calls[0]!.signal?.aborted).toBe(false);
});

test('a refusal is still the Inbox\'s own answer, never a timeout', async () => {
  network(async () => Response.json({ error: 'That session is not live any more.', code: 'session_not_live' }, { status: 409 }));
  const result = await outcome(post('/api/inbox/threads/thr_A/message', { idempotency_key: 'k3' }, WITHIN));
  expect(result.error instanceof InboxWriteTimeout).toBe(false);
  expect((result.error as { code?: string }).code).toBe('session_not_live');
});

/** A healthy Inbox that answers after three limits (a launch's preparation: the agent's checks, the login shell, git). */
const slow = (answer: unknown) => (init: RequestInit | undefined) =>
  new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(answer)), LIMIT * 3);
    init?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('aborted', 'AbortError'))), { once: true });
  });
const START = { launch: { agent: 'claude-code', project_id: 'prj_1' } };
const REPLIED = { message_id: 'msg_A', questions: [], reply: { id: 'msg_R' }, replayed: false };

test('a reply that starts a new session waits for an Inbox slow to prepare it, as New message\'s start does', async () => {
  network(slow(REPLIED));
  const reply = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k4', words: 'Carry on.', questions: [], to: START }));
  expect(reply.error).toBe(undefined);
  expect((reply.value?.reply as { id?: string } | null)?.id).toBe('msg_R');
  network(slow({ thread_id: 'thr_N', message: { id: 'msg_N' }, replayed: false }));
  const started = await outcome(inboxApi.startThread({ to: START, body: 'Go.', idempotency_key: 'k5' } as Parameters<typeof inboxApi.startThread>[0]));
  expect(started.error).toBe(undefined);
});

test('a reply or New message that starts a session, on a connection that died without a word, still ends: given up at its longer limit, the request aborted', async () => {
  const longer = (LIMIT * LAUNCH_IDLE_MS) / WRITE_IDLE_MS;
  network(silent);
  const reply = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k8', words: 'Carry on.', questions: [], to: START }));
  expect(reply.error instanceof InboxWriteTimeout).toBe(true);
  expect(reply.ms).toBeGreaterThanOrEqual(longer - 20);
  expect(reply.ms).toBeLessThan(longer * 3);
  expect(calls[0]!.signal?.aborted).toBe(true);
  const started = await outcome(inboxApi.startThread({ to: START, body: 'Go.', idempotency_key: 'k9' } as Parameters<typeof inboxApi.startThread>[0]));
  expect(started.error instanceof InboxWriteTimeout).toBe(true);
  expect(started.ms).toBeGreaterThanOrEqual(longer - 20);
  expect(calls[1]!.signal?.aborted).toBe(true);
});

test('an ordinary reply (or one to another live session) to the same slow Inbox is still given up at the limit', async () => {
  network(slow(REPLIED));
  const plain = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k6', words: 'Carry on.', questions: [] }));
  expect(plain.error instanceof InboxWriteTimeout).toBe(true);
  network(slow(REPLIED));
  const routed = await outcome(inboxApi.reply('msg_A', { idempotency_key: 'k7', words: 'Carry on.', questions: [], to: { session: 'ses_b' } }));
  expect(routed.error instanceof InboxWriteTimeout).toBe(true);
});

test('a write that does not ask for the limit (an update, a restart) waits as it always did: no signal on its request', async () => {
  network(async () => Response.json({ ok: true }));
  await post('/api/inbox/restart', {});
  expect(calls[0]!.signal).toBe(null);
});
