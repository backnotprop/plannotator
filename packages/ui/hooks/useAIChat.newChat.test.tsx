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
const CONTEXT: AIContext = { mode: 'plan-review', plan: { plan: 'Plan' } };

type HookResult = ReturnType<typeof useAIChat>;

function Harness({ resultRef }: { resultRef: { current: HookResult | null } }) {
  resultRef.current = useAIChat({ context: CONTEXT });
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
  const ref: { current: HookResult | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness resultRef={ref} />);
  });
  return ref;
}

function controlledTransport() {
  const sessions: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const aborts: unknown[] = [];
  const pending: Array<(text: string) => void> = [];
  const transport: AITransport = {
    session: async () => {
      const id = `s-${sessions.length + 1}`;
      sessions.push(id);
      return new Response(JSON.stringify({ sessionId: id }), { status: 200 });
    },
    query: async (body) => {
      queries.push(body as Record<string, unknown>);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          pending.push((text) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text_delta', delta: text })}\ndata: ${JSON.stringify({ type: 'result', result: text })}\n\n`));
            controller.close();
          });
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
    abort: async (body) => { aborts.push(body); },
    permission: () => {},
  };
  return { transport, sessions, queries, aborts, pending };
}

const tick = () => act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });

describe.if(hasDom)('useAIChat newChat', () => {
  test('does nothing while a question is in flight; the answer still lands', async () => {
    const fake = controlledTransport();
    setAITransport(fake.transport);
    const chat = await mount();

    let asked: Promise<void> = Promise.resolve();
    await act(async () => { asked = chat.current!.ask({ prompt: 'slow question' }); });
    await tick();
    expect(fake.pending).toHaveLength(1);

    let started = true;
    await act(async () => { started = chat.current!.newChat(); });
    expect(started).toBe(false);
    expect(chat.current!.messages).toHaveLength(1);

    await act(async () => { fake.pending[0]('the answer'); await asked; });
    expect(fake.aborts).toEqual([]);
    expect(chat.current!.messages[0].response.text).toBe('the answer');
    expect(chat.current!.isStreaming).toBe(false);
  });

  test('once idle, clears the thread and the next question starts a new session', async () => {
    const fake = controlledTransport();
    setAITransport(fake.transport);
    const chat = await mount();

    let asked: Promise<void> = Promise.resolve();
    await act(async () => { asked = chat.current!.ask({ prompt: 'first' }); });
    await tick();
    await act(async () => { fake.pending[0]('one'); await asked; });
    expect(chat.current!.sessionId).toBe('s-1');

    let started = false;
    await act(async () => { started = chat.current!.newChat(); });
    expect(started).toBe(true);
    expect(chat.current!.messages).toEqual([]);
    expect(chat.current!.sessionId).toBeNull();

    await act(async () => { asked = chat.current!.ask({ prompt: 'second' }); });
    await tick();
    await act(async () => { fake.pending[1]('two'); await asked; });
    expect(fake.sessions).toEqual(['s-1', 's-2']);
    expect(fake.queries[1].sessionId).toBe('s-2');
    expect(fake.aborts).toEqual([]);
  });

  test('does nothing while a busy "Ask this session" answer still offers its choice', async () => {
    const aborts: unknown[] = [];
    setAITransport({
      session: async () => new Response(JSON.stringify({ sessionId: 's-1' }), { status: 200 }),
      query: async () => new Response(
        `data: ${JSON.stringify({ type: 'error', error: 'The session is busy.', code: 'agent_busy' })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
      abort: async (body) => { aborts.push(body); },
      permission: () => {},
    });
    const chat = await mount();
    await act(async () => { await chat.current!.ask({ prompt: 'when you are free' }); });
    expect(chat.current!.messages[0].response.errorCode).toBe('agent_busy');
    expect(chat.current!.isStreaming).toBe(false);

    let started = true;
    await act(async () => { started = chat.current!.newChat(); });
    expect(started).toBe(false);
    expect(chat.current!.messages).toHaveLength(1);
    expect(aborts).toEqual([]);
  });

  test('"Ask this session": the draft list is not sent again after a new chat, and a clear still is', async () => {
    const fake = controlledTransport();
    setAITransport(fake.transport);
    const chat = await mount();
    const ask = async (prompt: string, draftAnnotations: string) => {
      let asked: Promise<void> = Promise.resolve();
      await act(async () => { asked = chat.current!.ask({ prompt, draftAnnotations }); });
      await tick();
      await act(async () => { fake.pending[fake.pending.length - 1]('ok'); await asked; });
    };

    await ask('first', 'Draft 1: tighten step 2');
    expect(fake.queries[0].draftAnnotations).toBe('Draft 1: tighten step 2');

    await act(async () => { chat.current!.newChat(); });
    await ask('second', 'Draft 1: tighten step 2');
    expect('draftAnnotations' in fake.queries[1]).toBe(false);

    await act(async () => { chat.current!.newChat(); });
    await ask('third', '');
    expect(fake.queries[2].draftAnnotations).toBe('');
  });
});
