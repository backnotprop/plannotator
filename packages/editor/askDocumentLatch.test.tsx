/**
 * #1001: the side chat's document note, through the real chat hook, wired the
 * way App wires it (`askDocumentParams`). One chat across documents: the first
 * question carries nothing (the session is made from the document on screen),
 * a repeat on the same document adds nothing, a switch carries one short note
 * with the path, and only a question that reached the session moves the latch.
 *
 * Requires DOM (DOM_TESTS=1, preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIContext } from '@plannotator/core';
import { resetAITransport, setAITransport, useAIChat, type AITransport } from '@plannotator/ui/hooks/useAIChat';
import {
  askDocumentParams,
  describeAskDocument,
  EMPTY_ASK_DOCUMENT_LATCH,
  type AskDocument,
  type AskDocumentLatch,
} from './askDocumentContext';

const hasDom = typeof document !== 'undefined';

type Chat = ReturnType<typeof useAIChat>;

const CONTEXT: AIContext = { mode: 'annotate', annotate: { content: '# Alpha', filePath: '/w/alpha.md' } };

const ALPHA = describeAskDocument({ kind: 'document', path: '/w/alpha.md', renderAs: 'markdown', content: 'ALPHA BODY' });
const BETA = describeAskDocument({ kind: 'document', path: '/w/beta.md', renderAs: 'markdown', content: 'BETA BODY' });
const PAGE = describeAskDocument({ kind: 'document', path: 'https://example.com/p', content: 'PAGE BODY' });

function sse(...messages: unknown[]): Response {
  const body = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function Harness({ chatRef }: { chatRef: { current: Chat | null } }) {
  chatRef.current = useAIChat({ context: CONTEXT });
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

async function setup(busyOn: Set<number> = new Set()) {
  const prompts: string[] = [];
  let sessions = 0;
  setAITransport({
    session: async () => Response.json({ sessionId: `s${++sessions}` }),
    query: async (body) => {
      prompts.push((body as { prompt: string }).prompt);
      if (busyOn.has(prompts.length)) return sse({ type: 'error', code: 'agent_busy', error: 'busy' });
      return sse({ type: 'text_delta', delta: 'ok' }, { type: 'result', result: 'ok' });
    },
    abort: async () => {},
    permission: () => {},
  } satisfies AITransport);
  host = document.createElement('div');
  document.body.appendChild(host);
  const chatRef: { current: Chat | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness chatRef={chatRef} />);
  });
  const latchRef: { current: AskDocumentLatch } = { current: EMPTY_ASK_DOCUMENT_LATCH };
  const ask = async (prompt: string, doc: AskDocument, sessionBridge = false) => {
    const chat = chatRef.current!;
    const params = askDocumentParams(latchRef, doc, { hasSession: !!chat.sessionId, sessionBridge });
    await act(async () => { await chat.ask({ prompt, ...params }); });
  };
  return { prompts, chatRef, latchRef, ask, sessions: () => sessions };
}

describe.if(hasDom)('side chat document note (#1001)', () => {
  test('first question bare, same document again bare, a switch names the path only', async () => {
    const t = await setup();
    await t.ask('q1', ALPHA);
    await t.ask('q2', ALPHA);
    await t.ask('q3', BETA);
    await t.ask('q4', BETA);
    expect(t.prompts[0]).toBe('q1');
    expect(t.prompts[1]).toBe('q2');
    expect(t.prompts[2]).toContain('/w/beta.md');
    expect(t.prompts[2]).toContain('Viewed earlier in this chat, most recent first: /w/alpha.md.');
    expect(t.prompts[2]).not.toContain('BETA BODY');
    expect(t.prompts[2]).not.toContain('ALPHA BODY');
    expect(t.prompts[2].endsWith('q3')).toBe(true);
    expect(t.prompts[3]).toBe('q4');
    expect(t.sessions()).toBe(1);
  });

  test('a busy answer does not move the latch; the retry that lands does', async () => {
    const t = await setup(new Set([2]));
    await t.ask('q1', ALPHA);
    await t.ask('q2', BETA);
    expect(t.prompts[1]).toContain('/w/beta.md');
    expect(t.latchRef.current.current?.key).toBe(ALPHA.key);
    const busyId = t.chatRef.current!.messages[1]!.question.id;
    await act(async () => { await t.chatRef.current!.retry(busyId, { busyPolicy: 'wait' }); });
    expect(t.prompts[2]).toBe(t.prompts[1]);
    expect(t.latchRef.current.current?.key).toBe(BETA.key);
    await t.ask('q3', BETA);
    expect(t.prompts[3]).toBe('q3');
  });

  test('a URL page carries its text once for a separate AI, never for "Ask this session"', async () => {
    const sdk = await setup();
    await sdk.ask('q1', ALPHA);
    await sdk.ask('q2', PAGE);
    await sdk.ask('q3', PAGE);
    expect(sdk.prompts[1]).toContain('PAGE BODY');
    expect(sdk.prompts[2]).toBe('q3');
    await act(async () => root!.unmount());
    root = null;
    resetAITransport();

    const bridge = await setup();
    await bridge.ask('q1', ALPHA, true);
    await bridge.ask('q2', PAGE, true);
    expect(bridge.prompts[1]).toContain('https://example.com/p');
    expect(bridge.prompts[1]).not.toContain('PAGE BODY');
  });

  test('New chat starts over: the next question creates a session and carries nothing', async () => {
    const t = await setup();
    await t.ask('q1', ALPHA);
    await t.ask('q2', BETA);
    await act(async () => { t.chatRef.current!.newChat(); });
    await t.ask('q3', BETA);
    expect(t.prompts[2]).toBe('q3');
    expect(t.sessions()).toBe(2);
  });
});
