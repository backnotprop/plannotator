/**
 * A read with a time limit (a thread's first read, health, a thread's PRs) on a slow link: the 450-message thread
 * is about 450 KB, which a 50 KB/s link takes about 9 s to bring, past the thread read's 8 s. The read used to be
 * aborted mid-answer and read again, forever, so the thread never opened. A read whose bytes keep arriving goes on;
 * one whose bytes stop still fails with InboxReadTimeout.
 */
import { afterEach, expect, test } from 'bun:test';
import { InboxReadTimeout, inboxApi } from './api';

const saved = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = saved;
});

function slowAnswer(chunks: string[], everyMs: number) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(out) {
        const bytes = new TextEncoder();
        chunks.forEach((chunk, i) => timers.push(setTimeout(() => (i === chunks.length - 1 ? (out.enqueue(bytes.encode(chunk)), out.close()) : out.enqueue(bytes.encode(chunk))), everyMs * (i + 1))));
        init?.signal?.addEventListener('abort', () => {
          timers.forEach(clearTimeout);
          out.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('an answer that keeps arriving past the limit is read whole', async () => {
  const text = JSON.stringify({ ok: true, words: 'x'.repeat(400) });
  slowAnswer(text.match(/.{1,40}/g)!, 40);
  expect(await inboxApi.healthWithin(150)).toEqual(JSON.parse(text));
});

test('an answer whose bytes stop fails with InboxReadTimeout', async () => {
  slowAnswer(['{"ok":', 'true}'], 400);
  const failed = await inboxApi.healthWithin(150).then(() => null, (cause: unknown) => cause);
  expect(failed).toBeInstanceOf(InboxReadTimeout);
});
