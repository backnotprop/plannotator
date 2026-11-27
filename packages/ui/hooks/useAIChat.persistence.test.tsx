/**
 * #3670: reloading a tab must keep its Ask AI answers and reuse the server's
 * existing session. These tests remount the real hook with a fake wire; no
 * provider or server is started.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as useAIChatModule from './useAIChat';
import type { AITransport } from './useAIChat';
import type { AIContext } from '@plannotator/core';
import { aiChatStorageKey } from '../utils/aiChatPersistence';

const { useAIChat, setAITransport, resetAITransport } = useAIChatModule;
const hasDom = typeof document !== 'undefined';
const CONTEXT: AIContext = { mode: 'plan-review', plan: { plan: 'Plan' } };
const KEY = 'plannotator-ai-chat:reload-test';
const OTHER_KEY = aiChatStorageKey('another-server', 'editor')!;
type HookResult = ReturnType<typeof useAIChat>;
type HookOptions = Parameters<typeof useAIChat>[0];
type ResultRef = { current: HookResult | null };

function Harness({ resultRef, options }: { resultRef: ResultRef; options: HookOptions }) {
  resultRef.current = useAIChat(options);
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount() {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(async () => {
  await unmount();
  resetAITransport();
  if (hasDom) {
    window.sessionStorage.removeItem(KEY);
    window.sessionStorage.removeItem(OTHER_KEY);
  }
});

async function mount(options: HookOptions = { context: CONTEXT, storageKey: KEY }): Promise<ResultRef> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: ResultRef = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness resultRef={resultRef} options={options} />);
  });
  return resultRef;
}

async function render(resultRef: ResultRef, options: HookOptions) {
  await act(async () => { root!.render(<Harness resultRef={resultRef} options={options} />); });
}

function sse(...messages: unknown[]): Response {
  return new Response(messages.map(m => `data: ${JSON.stringify(m)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function fakeTransport() {
  const sessions: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const transport: AITransport = {
    session: async () => {
      const sessionId = `s-${sessions.length + 1}`;
      sessions.push(sessionId);
      return Response.json({ sessionId });
    },
    query: async body => {
      queries.push(body as Record<string, unknown>);
      return sse({ type: 'text_delta', delta: `answer ${queries.length}` });
    },
    abort: async () => {},
    permission: () => {},
  };
  return { transport, sessions, queries };
}

describe.if(hasDom)('useAIChat reload persistence', () => {
  test('restores answers on reload and continues the original AI session', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'first question' }); });
    const threadId = first.current!.thread.id;
    await unmount();

    const reloaded = await mount();
    expect(reloaded.current!.thread.id).toBe(threadId);
    expect(reloaded.current!.messages[0]?.question.prompt).toBe('first question');
    expect(reloaded.current!.messages[0]?.response.text).toBe('answer 1');
    expect(reloaded.current!.isStreaming).toBe(false);
    await act(async () => { await reloaded.current!.ask({ prompt: 'follow-up' }); });
    expect(fake.sessions).toEqual(['s-1']);
    expect(fake.queries[1].sessionId).toBe('s-1');
    expect(reloaded.current!.messages).toHaveLength(2);
  });

  test('a restored session the server has dropped starts a new one instead of failing', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'before the server dropped it' }); });
    await unmount();

    setAITransport({ ...fake.transport, query: async (body, signal) => (body as { sessionId: string }).sessionId === 's-1'
      ? Response.json({ error: 'Session not found' }, { status: 404 })
      : fake.transport.query(body, signal) });
    const reloaded = await mount();
    await act(async () => { await reloaded.current!.ask({ prompt: 'follow-up' }); });
    expect(fake.sessions).toEqual(['s-1', 's-2']);
    expect(reloaded.current!.sessionId).toBe('s-2');
    expect(reloaded.current!.error).toBeNull();
    expect(reloaded.current!.messages.map(m => m.response.error)).toEqual([undefined, undefined]);
    expect(reloaded.current!.messages[1].response.text).toBe('answer 2');
  });

  test('waits for the server identity without overwriting its saved chat', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'saved before reload' }); });
    await unmount();

    const reloaded = await mount({ context: null, storageKey: null });
    expect(reloaded.current!.messages).toEqual([]);
    await render(reloaded, { context: CONTEXT, storageKey: KEY });
    expect(reloaded.current!.messages[0]?.response.text).toBe('answer 1');
    await act(async () => { await reloaded.current!.ask({ prompt: 'after loading' }); });
    expect(fake.sessions).toHaveLength(1);
  });

  test('a new server starts empty, while changing files in the same server keeps the chat', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const chat = await mount();
    await act(async () => { await chat.current!.ask({ prompt: 'server one' }); });
    const nextFile: AIContext = { mode: 'annotate', annotate: { content: '# Next', filePath: '/repo/next.md' } };
    await render(chat, { context: nextFile, storageKey: KEY });
    expect(chat.current!.messages[0]?.question.prompt).toBe('server one');
    await act(async () => { await chat.current!.ask({ prompt: 'next file' }); });
    expect(fake.sessions).toHaveLength(1);

    await render(chat, { context: CONTEXT, storageKey: OTHER_KEY });
    expect(chat.current!.messages).toEqual([]);
    await act(async () => { await chat.current!.ask({ prompt: 'server two' }); });
    expect(fake.sessions).toHaveLength(2);
    await unmount();
    const reloaded = await mount();
    expect(reloaded.current!.messages.map(m => m.question.prompt)).toEqual(['server one', 'next file']);
    await act(async () => { await reloaded.current!.ask({ prompt: 'back on one' }); });
    expect(fake.queries.at(-1)?.sessionId).toBe('s-1');
  });

  test.each(['waiting', 'interrupting'] as const)('refresh during %s keeps partial text but clears the spinner and dead permissions', async status => {
    const fake = fakeTransport();
    const encoder = new TextEncoder();
    setAITransport({
      ...fake.transport,
      query: async (_body, signal) => new Response(new ReadableStream({
        start(controller) {
          for (const message of [
            { type: 'text_delta', delta: 'partial answer' },
            { type: 'status', status },
            { type: 'permission_request', requestId: 'old-permission', toolName: 'Read', toolInput: { path: '/repo/file' }, toolUseId: 'tool-1' },
          ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
          signal.addEventListener('abort', () => controller.error(new DOMException('Reloaded', 'AbortError')), { once: true });
        },
      }), { status: 200 }),
    });
    const first = await mount();
    let asked = Promise.resolve();
    await act(async () => {
      asked = first.current!.ask({ prompt: 'slow question' });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    expect(first.current!.isStreaming).toBe(true);
    expect(first.current!.permissionRequests).toHaveLength(1);
    await unmount();
    await asked;
    setAITransport(fake.transport);

    const reloaded = await mount();
    const response = reloaded.current!.messages[0]?.response;
    expect(response?.text).toBe('partial answer');
    expect(response?.isStreaming).toBe(false);
    expect(response?.status).toBeUndefined();
    expect(response?.notice).toBeTruthy();
    expect(reloaded.current!.isStreaming).toBe(false);
    expect(reloaded.current!.permissionRequests).toEqual([]);
    await act(async () => { await reloaded.current!.ask({ prompt: 'continue' }); });
    expect(fake.sessions).toHaveLength(1);
  });

  test('New chat stays empty after reload and the next question starts a fresh AI session', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'before new chat', draftAnnotations: 'Draft 1' }); });
    await act(async () => { expect(first.current!.newChat()).toBe(true); });
    await unmount();
    const reloaded = await mount();
    expect(reloaded.current!.messages).toEqual([]);
    expect(reloaded.current!.sessionId).toBeNull();
    await act(async () => { await reloaded.current!.ask({ prompt: 'fresh', draftAnnotations: 'Draft 1' }); });
    expect(fake.sessions).toHaveLength(2);
    // The host session already read these drafts, even in a new AI thread.
    expect(fake.queries[1].draftAnnotations).toBeUndefined();
    await act(async () => { await reloaded.current!.ask({ prompt: 'drafts cleared', draftAnnotations: '' }); });
    expect(fake.queries[2].draftAnnotations).toBe('');
  });

  test('a busy answer can still retry its full prompt and selection after reload', async () => {
    const fake = fakeTransport();
    const originalQuery = fake.transport.query;
    let busy = true;
    setAITransport({ ...fake.transport, query: async (body, signal) => {
      if (busy) {
        busy = false;
        fake.queries.push(body as Record<string, unknown>);
        return sse({ type: 'error', code: 'agent_busy', error: 'The session is busy.' });
      }
      return originalQuery(body, signal);
    } });
    const first = await mount();
    let delivered = 0;
    await act(async () => { await first.current!.ask({
      prompt: 'FULL FINDING: explain the missing await',
      displayPrompt: 'Explain this finding',
      contextPreamble: 'Changes under review: async fix',
      filePath: 'worker.ts', lineStart: 2, lineEnd: 4, side: 'new', selectedCode: 'await job();',
      draftAnnotations: 'Draft not received yet',
      onDelivered: () => { delivered++; },
    }); });
    const firstPrompt = fake.queries[0].prompt;
    expect(delivered).toBe(0);
    await unmount();
    const reloaded = await mount();
    await act(async () => { expect(reloaded.current!.newChat()).toBe(false); });
    const questionId = reloaded.current!.messages[0].question.id;
    await act(async () => { await reloaded.current!.retry(questionId, { busyPolicy: 'wait' }); });
    expect(fake.queries[1].prompt).toBe(firstPrompt);
    expect(fake.queries[1].busyPolicy).toBe('wait');
    expect(fake.queries[1].draftAnnotations).toBe('Draft not received yet');
    expect(fake.sessions).toHaveLength(1);
    expect(reloaded.current!.messages).toHaveLength(1);
    expect(reloaded.current!.messages[0].question.prompt).toBe('Explain this finding');
    expect(reloaded.current!.messages[0].response.text).toBe('answer 2');
    expect(reloaded.current!.messages[0].response.error).toBeUndefined();
    await act(async () => { expect(reloaded.current!.newChat()).toBe(true); });
  });

  test('a provider reset preserves the transcript but never revives its old session on reload', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'before provider change' }); });
    await act(async () => { first.current!.resetSession(); });
    await unmount();
    const reloaded = await mount();
    expect(reloaded.current!.messages[0]?.response.text).toBe('answer 1');
    expect(reloaded.current!.sessionId).toBeNull();
    await act(async () => { await reloaded.current!.ask({ prompt: 'new provider' }); });
    expect(fake.sessions).toHaveLength(2);
  });

  test('a late failure from the previous server cannot replace the restored chat error', async () => {
    const fake = fakeTransport();
    let rejectQuery: (error: Error) => void = () => {};
    setAITransport({ ...fake.transport, query: () => new Promise((_resolve, reject) => { rejectQuery = reject; }) });
    const chat = await mount();
    let asked = Promise.resolve();
    await act(async () => { asked = chat.current!.ask({ prompt: 'old server question' }); });
    await render(chat, { context: CONTEXT, storageKey: OTHER_KEY });
    await act(async () => { rejectQuery(new Error('Old connection failed')); await asked; });
    expect(chat.current!.messages).toEqual([]);
    expect(chat.current!.error).toBeNull();
    setAITransport(fake.transport);
    await act(async () => { await chat.current!.ask({ prompt: 'new server question' }); });
    expect(chat.current!.messages[0].response.text).toBe('answer 1');
  });

  test('a provider change stops the old answer immediately without losing its partial text', async () => {
    const fake = fakeTransport();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    setAITransport({ ...fake.transport, query: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'text_delta', delta: 'partial' })}\n\n`));
      },
    })) });
    const chat = await mount();
    let asked = Promise.resolve();
    await act(async () => { asked = chat.current!.ask({ prompt: 'old provider' }); });
    expect(chat.current!.messages[0].response.isStreaming).toBe(true);
    await act(async () => { chat.current!.resetSession(); });
    expect(chat.current!.messages[0].response.text).toBe('partial');
    expect(chat.current!.messages[0].response.isStreaming).toBe(false);
    expect(chat.current!.sessionId).toBeNull();
    await act(async () => { stream!.error(new Error('Old provider failed')); await asked; });
    expect(chat.current!.error).toBeNull();
    setAITransport(fake.transport);
    await act(async () => { await chat.current!.ask({ prompt: 'new provider' }); });
    expect(fake.sessions).toHaveLength(2);
  });

  test('a question awaiting the previous abort cannot enter the next server chat', async () => {
    const fake = fakeTransport();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    let acknowledgeAbort: () => void = () => {};
    const aborted = new Promise<void>(resolve => { acknowledgeAbort = resolve; });
    setAITransport({
      ...fake.transport,
      query: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })),
      abort: () => aborted,
    });
    const chat = await mount();
    let first = Promise.resolve();
    let second = Promise.resolve();
    await act(async () => { first = chat.current!.ask({ prompt: 'first old question' }); });
    await act(async () => { second = chat.current!.ask({ prompt: 'queued old question' }); });
    await render(chat, { context: CONTEXT, storageKey: OTHER_KEY });
    await act(async () => { acknowledgeAbort(); stream!.close(); await Promise.all([first, second]); });
    expect(chat.current!.messages).toEqual([]);
    expect(chat.current!.isStreaming).toBe(false);
    setAITransport(fake.transport);
    await act(async () => { await chat.current!.ask({ prompt: 'new server question' }); });
    expect(chat.current!.messages[0].question.prompt).toBe('new server question');
  });

  test('a saved busy choice without its full retry prompt cannot lock New chat', async () => {
    const fake = fakeTransport();
    setAITransport({ ...fake.transport, query: async () => sse({ type: 'error', code: 'agent_busy', error: 'Busy' }) });
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'full prompt', displayPrompt: 'short prompt' }); });
    await unmount();
    const snapshot = JSON.parse(window.sessionStorage.getItem(KEY)!);
    snapshot.paramsByQuestion = [];
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
    const reloaded = await mount();
    await act(async () => { expect(reloaded.current!.newChat()).toBe(true); });
    setAITransport(fake.transport);
    await act(async () => { await reloaded.current!.ask({ prompt: 'fresh question' }); });
    expect(reloaded.current!.messages[0].response.text).toBe('answer 1');
  });

  test('hosts that do not opt in keep their in-memory chat behavior', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount({ context: CONTEXT });
    await act(async () => { await first.current!.ask({ prompt: 'memory only' }); });
    await unmount();
    const reloaded = await mount({ context: CONTEXT });
    expect(reloaded.current!.messages).toEqual([]);
    await act(async () => { await reloaded.current!.ask({ prompt: 'fresh host' }); });
    expect(fake.sessions).toHaveLength(2);
  });

  test.each(['invalid JSON', '{"version":2}', '{"version":1,"thread":{"messages":[null]}}'])(
    'a corrupt snapshot does not prevent a new question: %s', async raw => {
      window.sessionStorage.setItem(KEY, raw);
      const fake = fakeTransport();
      setAITransport(fake.transport);
      const chat = await mount();
      await act(async () => { await chat.current!.ask({ prompt: 'works without saved data' }); });
      expect(chat.current!.messages[0].response.text).toBe('answer 1');
    },
  );

  test('blocked sessionStorage does not prevent asking or starting a new chat', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    try {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('Storage blocked'); } });
      const fake = fakeTransport();
      setAITransport(fake.transport);
      const chat = await mount();
      await act(async () => { await chat.current!.ask({ prompt: 'storage disabled' }); });
      expect(chat.current!.messages[0].response.text).toBe('answer 1');
      await act(async () => { expect(chat.current!.newChat()).toBe(true); });
      await act(async () => { await chat.current!.ask({ prompt: 'still works' }); });
      expect(fake.sessions).toHaveLength(2);
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
      else delete (window as unknown as Record<string, unknown>).sessionStorage;
    }
  });

  test('a storage quota failure does not break the live answer', async () => {
    const sessionStorage = window.sessionStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    try {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: {
        getItem: (key: string) => sessionStorage.getItem(key),
        setItem: () => { throw new Error('Quota exceeded'); },
      } });
      const fake = fakeTransport();
      setAITransport(fake.transport);
      const chat = await mount();
      await act(async () => { await chat.current!.ask({ prompt: 'large conversation' }); });
      expect(chat.current!.messages[0].response.text).toBe('answer 1');
      expect(chat.current!.error).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
      else delete (window as unknown as Record<string, unknown>).sessionStorage;
    }
  });

  test('a chat that outgrew storage does not come back older on reload', async () => {
    const fake = fakeTransport();
    setAITransport(fake.transport);
    const first = await mount();
    await act(async () => { await first.current!.ask({ prompt: 'saved while it fit' }); });
    const sessionStorage = window.sessionStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    try {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: {
        getItem: (key: string) => sessionStorage.getItem(key),
        setItem: () => { throw new Error('Quota exceeded'); },
        removeItem: (key: string) => sessionStorage.removeItem(key),
      } });
      await act(async () => { await first.current!.ask({ prompt: 'too large to save' }); });
      await unmount();
      const reloaded = await mount();
      expect(reloaded.current!.messages).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
      else delete (window as unknown as Record<string, unknown>).sessionStorage;
    }
  });
});
