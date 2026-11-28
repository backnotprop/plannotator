/**
 * #1981, code review: after "New chat" the next question starts a fresh AI
 * session, so it must carry the full "changes under review" block again. The
 * failure this guards: the wrapper's last-sent memory surviving the new chat,
 * so the fresh session only got "[Still reviewing the same changes …]" and
 * never saw the diff.
 *
 * Requires DOM (DOM_TESTS=1, preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as sharedChat from '@plannotator/ui/hooks/useAIChat';
import { useAIChat } from './useAIChat';

const setAITransport = sharedChat.setAITransport;
const resetAITransport = sharedChat.resetAITransport;
const hasDom = typeof document !== 'undefined';

const REVIEW_CONTEXT = 'Changes under review (uncommitted):\n```diff\n-old line\n+new line\n```';
const REMINDER = '[Still reviewing the same changes shown earlier in this conversation.]';

type HookResult = ReturnType<typeof useAIChat>;
const STORAGE_KEY = 'plannotator-ai-chat:review-wrapper-test';

function Harness({ resultRef, storageKey }: { resultRef: { current: HookResult | null }; storageKey?: string }) {
  resultRef.current = useAIChat({ patch: 'diff --git a/x b/x', diffType: 'uncommitted', reviewContext: REVIEW_CONTEXT, storageKey });
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
  if (hasDom) window.sessionStorage.removeItem(STORAGE_KEY);
});

describe.if(hasDom)('code review Ask AI: new chat', () => {
  test('the first question after a new chat carries the full "changes under review" block again', async () => {
    const prompts: string[] = [];
    let sessions = 0;
    setAITransport({
      session: async () => new Response(JSON.stringify({ sessionId: `s-${++sessions}` }), { status: 200 }),
      query: async (body) => {
        prompts.push((body as { prompt: string }).prompt);
        return new Response(
          `data: ${JSON.stringify({ type: 'result', result: 'ok' })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
      abort: async () => {},
      permission: () => {},
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    const chat: { current: HookResult | null } = { current: null };
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness resultRef={chat} />);
    });
    const ask = async (prompt: string) => {
      await act(async () => { await chat.current!.ask({ prompt }); });
    };

    await ask('first');
    await ask('second');
    expect(prompts[0].startsWith(REVIEW_CONTEXT)).toBe(true);
    expect(prompts[1].startsWith(REMINDER)).toBe(true);

    let started = false;
    await act(async () => { started = chat.current!.newChat(); });
    expect(started).toBe(true);

    await ask('third');
    expect(sessions).toBe(2);
    expect(prompts[2].startsWith(REVIEW_CONTEXT)).toBe(true);
    expect(prompts[2]).not.toContain(REMINDER);
  });

  test('a review reload keeps its answers and follow-up in the original AI session', async () => {
    let sessions = 0;
    const queries: Array<{ sessionId: string; prompt: string }> = [];
    setAITransport({
      session: async () => Response.json({ sessionId: `s-${++sessions}` }),
      query: async body => {
        queries.push(body as { sessionId: string; prompt: string });
        return new Response(`data: ${JSON.stringify({ type: 'result', result: `review answer ${queries.length}` })}\n\ndata: [DONE]\n\n`);
      },
      abort: async () => {},
      permission: () => {},
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    const chat: { current: HookResult | null } = { current: null };
    const mount = async () => {
      await act(async () => {
        root = createRoot(host!);
        root.render(<Harness resultRef={chat} storageKey={STORAGE_KEY} />);
      });
    };
    await mount();
    await act(async () => { await chat.current!.ask({ prompt: 'review first question' }); });
    await act(async () => { root!.unmount(); });
    root = null;
    await mount();
    expect(chat.current!.messages[0].response.text).toBe('review answer 1');
    await act(async () => { await chat.current!.ask({ prompt: 'review follow-up' }); });
    expect(sessions).toBe(1);
    expect(queries[1].sessionId).toBe('s-1');
    expect(queries[1].prompt).toContain('review follow-up');
    expect(chat.current!.messages).toHaveLength(2);
  });
});
