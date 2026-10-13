/**
 * "Ask this session" in the shared chat hook: the busy choice and the
 * separate-AI fallback re-ask a question, and the plain wire is unchanged for
 * every other provider.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as useAIChatModule from './useAIChat';
import type { AITransport } from './useAIChat';
import type { AIContext } from '@plannotator/core';

const setAITransport = useAIChatModule.setAITransport;
const resetAITransport = useAIChatModule.resetAITransport;
const useAIChat = useAIChatModule.useAIChat;

const hasDom = typeof document !== 'undefined';

type HookResult = ReturnType<typeof useAIChat>;

const CONTEXT: AIContext = { mode: 'annotate', annotate: { content: '# Doc', filePath: '/repo/doc.md' } };

function sse(...messages: unknown[]): Response {
  const body = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function Harness({ resultRef }: { resultRef: { current: HookResult | null } }) {
  resultRef.current = useAIChat({ context: CONTEXT, providerId: 'session-bridge' });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  resetAITransport();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(): Promise<{ current: HookResult | null }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness resultRef={resultRef} />);
  });
  return resultRef;
}

describe.if(hasDom)('useAIChat — Ask this session', () => {
  test('a plain question sends exactly the old query body (no busy policy)', async () => {
    const queries: unknown[] = [];
    setAITransport({
      session: async () => Response.json({ sessionId: 's1' }),
      query: async (body) => {
        queries.push(body);
        return sse({ type: 'text_delta', delta: 'hi' });
      },
      abort: async () => {},
      permission: () => {},
    } satisfies AITransport);
    const chat = await mount();
    await act(async () => { await chat.current!.ask({ prompt: 'q' }); });
    expect(queries).toEqual([{ sessionId: 's1', prompt: 'q' }]);
  });

  test('agent_busy → "Ask when it finishes" re-asks in place with the wait policy', async () => {
    const queries: Array<Record<string, unknown>> = [];
    setAITransport({
      session: async () => Response.json({ sessionId: 's1' }),
      query: async (body) => {
        queries.push(body as Record<string, unknown>);
        if (queries.length === 1) {
          return sse({ type: 'error', code: 'agent_busy', error: 'The session is busy with another turn.' });
        }
        return sse({ type: 'status', status: 'waiting' }, { type: 'status', status: 'running' }, { type: 'text_delta', delta: 'answer' });
      },
      abort: async () => {},
      permission: () => {},
    } satisfies AITransport);
    const chat = await mount();

    await act(async () => { await chat.current!.ask({ prompt: 'why?' }); });
    const busy = chat.current!.messages[0];
    expect(busy.response.errorCode).toBe('agent_busy');

    await act(async () => { await chat.current!.retry(busy.question.id, { busyPolicy: 'wait' }); });
    expect(queries[1]).toEqual({ sessionId: 's1', prompt: 'why?', busyPolicy: 'wait' });
    expect(chat.current!.messages).toHaveLength(1);
    const answered = chat.current!.messages[0].response;
    expect(answered.text).toBe('answer');
    expect(answered.error).toBeUndefined();
    expect(answered.status).toBeUndefined();
  });

  // The failure this guards: session_taken_over handled like any error, which
  // hides the partial answer and raises the panel's error banner.
  test('session_taken_over keeps the streamed answer and records the note, not an error', async () => {
    setAITransport({
      session: async () => Response.json({ sessionId: 's1' }),
      query: async () =>
        sse(
          { type: 'text_delta', delta: 'Because ' },
          { type: 'error', code: 'session_taken_over', error: 'NOTE-SENTINEL' },
        ),
      abort: async () => {},
      permission: () => {},
    } satisfies AITransport);
    const chat = await mount();
    await act(async () => { await chat.current!.ask({ prompt: 'why?' }); });
    const { response } = chat.current!.messages[0];
    expect(response.text).toBe('Because ');
    expect(response.notice).toBe('NOTE-SENTINEL');
    expect(response.error).toBeUndefined();
    expect(response.isStreaming).toBe(false);
    expect(chat.current!.error).toBeNull();
  });

  test('the fallback re-asks on a fresh session of the other provider', async () => {
    const sessions: Array<Record<string, unknown>> = [];
    const queries: Array<Record<string, unknown>> = [];
    setAITransport({
      session: async (body) => {
        sessions.push(body as Record<string, unknown>);
        return Response.json({ sessionId: `s${sessions.length}` });
      },
      query: async (body) => {
        queries.push(body as Record<string, unknown>);
        return queries.length === 1
          ? sse({ type: 'error', code: 'session_gone', error: 'gone' })
          : sse({ type: 'text_delta', delta: 'from pi-sdk' });
      },
      abort: async () => {},
      permission: () => {},
    } satisfies AITransport);
    const chat = await mount();

    await act(async () => { await chat.current!.ask({ prompt: 'q' }); });
    const questionId = chat.current!.messages[0].question.id;
    await act(async () => { await chat.current!.retry(questionId, { providerId: 'pi-sdk' }); });

    expect(sessions.map((s) => s.providerId)).toEqual(['session-bridge', 'pi-sdk']);
    expect(queries[1].sessionId).toBe('s2');
    expect(chat.current!.sessionId).toBe('s2');
    expect(chat.current!.messages.map((m) => m.response.text)).toEqual(['from pi-sdk']);
  });
});
