import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as m from './useAIChat';
const hasDom = typeof document !== 'undefined';
afterEach(() => m.resetAITransport());
function Harness({ r }: { r: { current: any } }) { r.current = m.useAIChat({ context: { mode: 'plan-review', plan: { plan: 'x' } } as any }); return null; }
test.skipIf(!hasDom)('a separate provider that reports its own abort does not show an error on the superseded answer', async () => {
  let first: ReadableStreamDefaultController<Uint8Array> | null = null;
  let n = 0;
  m.setAITransport({
    session: async () => Response.json({ sessionId: 's1' }),
    query: async (_b, signal) => {
      n++;
      if (n === 1) return new Response(new ReadableStream({ start(c) { first = c; signal.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch {} }); } }));
      return new Response('data: {"type":"text_delta","delta":"ok"}\ndata: [DONE]\n\n');
    },
    // Like the server: the provider's generator yields its abort error, then the stream closes, then the ack lands.
    abort: async () => {
      first!.enqueue(new TextEncoder().encode('data: {"type":"error","error":"OpenCode query aborted.","code":"provider_error"}\n\ndata: [DONE]\n\n'));
      first!.close();
      await new Promise(r => setTimeout(r, 20));
    },
    permission: () => {},
  });
  const host = document.createElement('div'); document.body.appendChild(host);
  const r = { current: null as any }; let root: any;
  await act(async () => { root = createRoot(host); root.render(<Harness r={r} />); });
  let a: Promise<void> = Promise.resolve(), b: Promise<void> = Promise.resolve();
  await act(async () => { a = r.current.ask({ prompt: 'first' }); });
  await act(async () => { b = r.current.ask({ prompt: 'second' }); await Promise.all([a, b]); });
  expect(r.current.messages[0].response.error).toBeUndefined();
  expect(r.current.messages[1].response.text).toBe('ok');
  await act(async () => root.unmount());
});
