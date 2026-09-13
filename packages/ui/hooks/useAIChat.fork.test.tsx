/**
 * Fork plumbing test: origin-session forking (issue #1519).
 *
 * Contract:
 *  - The AIContext (including an opt-in `parent`) is posted verbatim to the
 *    session transport — the server decides fork vs fresh from it.
 *  - `sessionForked` mirrors the session response's `forked` flag so the UI
 *    can tell a real fork from a silent fresh-session fallback.
 *  - `sessionForked` resets to null on resetSession/resetThread.
 *
 * Requires DOM — runs under bun test (preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as useAIChatModule from './useAIChat';
import type { AITransport } from './useAIChat';
import type { AIContext } from '@plannotator/core';

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

const FORK_CONTEXT: AIContext = {
  mode: 'plan-review',
  plan: { plan: 'Test plan content' },
  parent: { sessionId: 'origin-session-1', cwd: '/tmp/project', agent: 'claude-code' },
};

function makeSseResponse(): Response {
  const body = `data: {"type":"text_delta","delta":"ok"}\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeForkTransport(forked: boolean, seenBodies?: unknown[]): AITransport {
  return {
    session: async (body) => {
      seenBodies?.push(body);
      return new Response(JSON.stringify({ sessionId: 'fake-session', forked }), { status: 200 });
    },
    query: async () => makeSseResponse(),
    abort: async () => {},
    permission: () => {},
  };
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

describe('useAIChat origin-session forking', () => {
  test.skipIf(!hasDom)('posts the parent through to the session endpoint and reports forked: true', async () => {
    const seenBodies: unknown[] = [];
    setAITransport(makeForkTransport(true, seenBodies));

    const session = await mountHook(FORK_CONTEXT);
    await act(async () => {
      await session.result.current!.ask({ prompt: 'why did you do it this way?' });
    });

    expect(seenBodies).toHaveLength(1);
    expect((seenBodies[0] as { context: AIContext }).context.parent).toEqual({
      sessionId: 'origin-session-1',
      cwd: '/tmp/project',
      agent: 'claude-code',
    });
    expect(session.result.current!.sessionForked).toBe(true);

    await session.unmount();
  });

  test.skipIf(!hasDom)('reports forked: false when the server fell back to a fresh session', async () => {
    setAITransport(makeForkTransport(false));

    const session = await mountHook(FORK_CONTEXT);
    expect(session.result.current!.sessionForked).toBeNull();

    await act(async () => {
      await session.result.current!.ask({ prompt: 'why?' });
    });
    expect(session.result.current!.sessionForked).toBe(false);

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetSession clears the fork flag back to null', async () => {
    setAITransport(makeForkTransport(true));

    const session = await mountHook(FORK_CONTEXT);
    await act(async () => {
      await session.result.current!.ask({ prompt: 'why?' });
    });
    expect(session.result.current!.sessionForked).toBe(true);

    await act(async () => {
      session.result.current!.resetSession();
    });
    expect(session.result.current!.sessionForked).toBeNull();

    await session.unmount();
  });
});
