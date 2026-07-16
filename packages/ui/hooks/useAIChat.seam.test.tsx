/**
 * Seam test: AITransport override (setAITransport / resetAITransport).
 *
 * Contract:
 *  - After setAITransport(fake), useAIChat.ask() routes the session + query
 *    calls through the fake transport — NOT through /api/ai/*.
 *  - resetAITransport() restores the default.
 *
 * Requires DOM — runs under bun test (preloaded via bunfig.toml).
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as useAIChatModule from './useAIChat';
import type { AITransport } from './useAIChat';
import type { AIContext } from '@plannotator/core';

// Capture real function references at import time.
const setAITransport = useAIChatModule.setAITransport;
const resetAITransport = useAIChatModule.resetAITransport;
const useAIChat = useAIChatModule.useAIChat;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetAITransport();
  if (hasDom) document.body.innerHTML = '';
});

type HookResult = ReturnType<typeof useAIChat>;

function Harness({ resultRef, context }: { resultRef: { current: HookResult | null }; context: AIContext | null }) {
  resultRef.current = useAIChat({ context });
  return null;
}

const TEST_CONTEXT: AIContext = {
  mode: 'plan-review',
  plan: { plan: 'Test plan content' },
};

function makeSseResponse(textDelta: string): Response {
  const body = `data: {"type":"text_delta","delta":"${textDelta}"}\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeAbortableSseResponse(signal: AbortSignal): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function mountHook(context: AIContext | null): Promise<{
  result: { current: HookResult | null };
  unmount: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={resultRef} context={context} />);
  });
  return {
    result: resultRef,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

async function expectResetAbortsActiveTurn(resetKind: 'session' | 'thread'): Promise<void> {
  const abortBodies: unknown[] = [];
  let resolveQueryStarted: () => void = () => {};
  const queryStarted = new Promise<void>((resolve) => {
    resolveQueryStarted = resolve;
  });

  const fakeTransport: AITransport = {
    session: async () => new Response(JSON.stringify({ sessionId: 'fake-session-reset' }), { status: 200 }),
    query: async (_body, signal) => {
      resolveQueryStarted();
      return makeAbortableSseResponse(signal);
    },
    abort: async (body) => { abortBodies.push(body); },
    permission: () => {},
  };

  setAITransport(fakeTransport);

  const session = await mountHook(TEST_CONTEXT);
  let askPromise: Promise<void> = Promise.resolve();

  await act(async () => {
    askPromise = session.result.current!.ask({ prompt: 'slow question' });
  });
  await queryStarted;

  await act(async () => {
    if (resetKind === 'session') {
      session.result.current!.resetSession();
    } else {
      session.result.current!.resetThread();
    }
  });

  await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
  await askPromise;

  expect(abortBodies).toEqual([{ sessionId: 'fake-session-reset' }]);

  await session.unmount();
}

describe('AITransport seam', () => {
  test.skipIf(!hasDom)('fake session + query are called when useAIChat.ask() is invoked', async () => {
    const sessionBodies: unknown[] = [];
    const queryBodies: unknown[] = [];

    const fakeTransport: AITransport = {
      session: async (body, _signal) => {
        sessionBodies.push(body);
        return new Response(JSON.stringify({ sessionId: 'fake-session-001' }), { status: 200 });
      },
      query: async (body, _signal) => {
        queryBodies.push(body);
        return makeSseResponse('hello');
      },
      abort: async () => {},
      permission: () => {},
    };

    setAITransport(fakeTransport);

    const session = await mountHook(TEST_CONTEXT);

    await act(async () => {
      await session.result.current!.ask({ prompt: 'What is this plan about?' });
    });

    // Allow SSE reader to drain
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 50)); });

    expect(sessionBodies.length).toBeGreaterThanOrEqual(1);
    expect(queryBodies.length).toBeGreaterThanOrEqual(1);
    const qb = queryBodies[0] as Record<string, unknown>;
    expect(qb.sessionId).toBe('fake-session-001');

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetAITransport restores the default (does not call the fake)', async () => {
    const fakeCalls: string[] = [];
    const fake: AITransport = {
      session: async () => { fakeCalls.push('session'); return new Response('{}', { status: 200 }); },
      query: async () => { fakeCalls.push('query'); return new Response('', { status: 200 }); },
      abort: async () => { fakeCalls.push('abort'); },
      permission: () => { fakeCalls.push('permission'); },
    };

    setAITransport(fake);
    resetAITransport();

    // After reset, the default transport issues a real fetch to /api/ai/session.
    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ sessionId: 'real-session' }), { status: 200 });
    }) as typeof fetch;

    const session = await mountHook(TEST_CONTEXT);

    await act(async () => {
      // Fire-and-forget: we just want to trigger the session creation path.
      session.result.current!.ask({ prompt: 'test' }).catch(() => {});
    });

    // Give the async session call a tick to fire.
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 50)); });

    globalThis.fetch = realFetch;

    // Fake was NOT called; the default made a fetch to /api/ai/session.
    expect(fakeCalls).toHaveLength(0);
    expect(fetchCalls.some((u) => u.includes('/api/ai/session'))).toBe(true);

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetSession aborts the active server turn', async () => {
    await expectResetAbortsActiveTurn('session');
  });

  test.skipIf(!hasDom)('resetThread aborts the active server turn', async () => {
    await expectResetAbortsActiveTurn('thread');
  });
});
