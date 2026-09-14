/**
 * forkOrigin plumbing test (#1519): useAIChat's `forkOrigin` option is the
 * only origin-fork signal the client ever sends — it posts `forkOrigin: true`
 * as a sibling of `context` on /api/ai/session, and never builds or attaches
 * a `ParentSession` itself (the server holds that, see
 * `AIEndpointDeps.originSession` in packages/ai/endpoints.ts).
 *
 * Requires DOM — runs under bun test (preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import * as useAIChatModule from './useAIChat';
import type { AITransport } from './useAIChat';
import type { AIContext } from '@plannotator/core';
import { hasDom, mountHook } from './hookTestHarness';

const setAITransport = useAIChatModule.setAITransport;
const resetAITransport = useAIChatModule.resetAITransport;
const useAIChat = useAIChatModule.useAIChat;

afterEach(() => {
  resetAITransport();
  if (hasDom) document.body.innerHTML = '';
});

type HookResult = ReturnType<typeof useAIChat>;

function Harness({
  resultRef,
  context,
  forkOrigin,
}: {
  resultRef: { current: HookResult | null };
  context: AIContext | null;
  forkOrigin?: boolean;
}) {
  resultRef.current = useAIChat({ context, forkOrigin });
  return null;
}

const TEST_CONTEXT: AIContext = {
  mode: 'plan-review',
  plan: { plan: 'Test plan content' },
};

function makeSseResponse(): Response {
  const body = `data: {"type":"text_delta","delta":"ok"}\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function makeTransport(seenBodies: unknown[]): AITransport {
  return {
    session: async (body) => {
      seenBodies.push(body);
      return new Response(JSON.stringify({ sessionId: 'fake-session' }), { status: 200 });
    },
    query: async () => makeSseResponse(),
    abort: async () => {},
    permission: () => {},
  };
}

describe('useAIChat forkOrigin', () => {
  test.skipIf(!hasDom)('posts forkOrigin: true when armed, and never a client-built ParentSession', async () => {
    const seenBodies: unknown[] = [];
    setAITransport(makeTransport(seenBodies));

    const resultRef: { current: HookResult | null } = { current: null };
    const { result, unmount } = await mountHook(
      resultRef,
      <Harness resultRef={resultRef} context={TEST_CONTEXT} forkOrigin={true} />,
    );
    await act(async () => {
      await result.current!.ask({ prompt: 'why did you do it this way?' });
    });

    expect(seenBodies).toHaveLength(1);
    const body = seenBodies[0] as { forkOrigin?: boolean; context: AIContext };
    expect(body.forkOrigin).toBe(true);
    // The client never builds a ParentSession — only the boolean crosses.
    expect(body.context.parent).toBeUndefined();

    await unmount();
  });
});
