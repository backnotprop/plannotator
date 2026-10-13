/**
 * #1748, end to end: the reviewer's unsubmitted annotations on the way to
 * "Ask this session".
 *
 * Real path, no mocks between the pieces: real annotations and blocks → the
 * App's choice of annotation context (`askAIAnnotationParams`) and the draft
 * formatter → the real chat hook (`useAIChat`) → the real `/api/ai/session`
 * and `/api/ai/query` handlers → `SessionBridgeProvider` over the real pull
 * bridge → the real pull client, which hands each question to a host bridge
 * standing in for the agent session. The assertions are on the exact text the
 * session receives.
 *
 * Requires DOM (DOM_TESTS=1, preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createAIEndpoints } from '@plannotator/ai/endpoints';
import { ProviderRegistry } from '@plannotator/ai/provider';
import { SessionManager } from '@plannotator/ai/session-manager';
import {
  SESSION_ASK_DRAFTS_CLEARED,
  SESSION_ASK_DRAFTS_END,
  SESSION_ASK_DRAFTS_LABEL,
  SESSION_ASK_HEADER,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  type SessionBridge,
} from '@plannotator/ai/session-bridge';
import { createPullSessionBridge } from '@plannotator/ai/session-bridge-pull';
import { runPullSessionBridgeClient } from '@plannotator/ai/session-bridge-pull-client';
import type { AIContext } from '@plannotator/core';
import { resetAITransport, setAITransport, useAIChat, type AITransport } from '@plannotator/ui/hooks/useAIChat';
import { exportAnnotations, formatDraftAnnotationsForAsk, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { askAIAnnotationParams } from './askAIDrafts';
import { ASK_DRAFTS_CLEARED, ASK_DRAFTS_END, ASK_DRAFTS_LABEL, buildTerminalAskPrompt } from './agentTerminalIntegration';

const hasDom = typeof document !== 'undefined';

const TOKEN = 'e'.repeat(43);
const HOST = '127.0.0.1:4777';
const CONTEXT: AIContext = { mode: 'annotate', annotate: { content: '', filePath: 'last-message' } };

const MESSAGE = '# Release plan\n\nOpen issues for the remaining work.\n\n- Ship the parser fix\n- Update the docs\n';
const BLOCKS = parseMarkdownToBlocks(MESSAGE);

function annotation(id: string, fields: Partial<Annotation>): Annotation {
  return {
    id,
    blockId: 'block-1',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    originalText: '',
    createdA: 1,
    ...fields,
  } as Annotation;
}

/** Two actionable drafts, like the report: the kind an agent would carry out. */
const DRAFTS: Annotation[] = [
  annotation('a1', {
    blockId: 'block-1',
    originalText: 'Open issues for the remaining work.',
    text: 'create these and assign to milestone 1.3',
  }),
  annotation('a2', {
    blockId: 'block-3',
    type: AnnotationType.DELETION,
    originalText: 'Update the docs',
  }),
];

const cleanups: Array<() => void> = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  resetAITransport();
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A server with a pull bridge, a host that answers every question, and the
 *  chat hook's transport routed into the server's real handlers. */
function serverWithSession(): { received: string[] } {
  const received: string[] = [];
  const bridge: SessionBridge = {
    host: 'claude-code',
    modes: { turn: true, transient: false },
    status: () => 'ready',
    ask(req, sink) {
      received.push(req.text);
      sink.delta('ok');
      sink.done('ok');
    },
  };
  const pull = createPullSessionBridge({ token: TOKEN, host: 'claude-code', modes: bridge.modes, resendAfterMs: 50 });
  const registry = new ProviderRegistry();
  registry.register(new SessionBridgeProvider(pull.bridge, { pollIntervalMs: 5 }), SESSION_BRIDGE_PROVIDER_NAME);
  const endpoints = createAIEndpoints({
    registry,
    sessionManager: new SessionManager(),
    // happy-dom's Request drops the forbidden Host header, so check the URL's.
    authorizeSessionBridgeRequest: (req) => new URL(req.url).host === HOST,
    pullBridge: pull,
  }) as Record<string, (req: Request) => Promise<Response>>;
  const call = (path: string, init: RequestInit = {}) =>
    endpoints[path](
      new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } }),
    );
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

  const controller = new AbortController();
  void runPullSessionBridgeClient({
    baseUrl: `http://${HOST}`,
    token: TOKEN,
    bridge,
    signal: controller.signal,
    pollWaitMs: 100,
    statusIntervalMs: 10,
    deltaFlushMs: 5,
    maxFailures: 2,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => call(new URL(String(url)).pathname, init ?? {})) as typeof fetch,
  });
  cleanups.push(() => {
    controller.abort();
    pull.dispose();
  });

  setAITransport({
    session: (body) => post('/api/ai/session', body),
    query: (body) => post('/api/ai/query', body),
    abort: (body) => post('/api/ai/abort', body),
    permission: () => {},
  } satisfies AITransport);
  return { received };
}

type Chat = ReturnType<typeof useAIChat>;

async function mountChat(): Promise<{ current: Chat | null }> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const ref: { current: Chat | null } = { current: null };
  function Harness() {
    ref.current = useAIChat({ context: CONTEXT, providerId: SESSION_BRIDGE_PROVIDER_NAME });
    return null;
  }
  await act(async () => {
    root = createRoot(container!);
    root.render(<Harness />);
  });
  return ref;
}

/** What App's handleAskAI sends for these annotations. */
function askParams(chat: Chat, drafts: Annotation[], sessionBridge: boolean) {
  return askAIAnnotationParams({
    sessionBridge,
    hasSession: !!chat.sessionId,
    feedbackExport: drafts.length > 0 ? exportAnnotations(BLOCKS, drafts, [], 'Message Feedback', 'message') : undefined,
    draftList: () => formatDraftAnnotationsForAsk({ annotations: drafts, blocks: BLOCKS }),
  });
}

const DRAFT_LINES = [
  'Draft 1 (line 3): comment on "Open issues for the remaining work." — create these and assign to milestone 1.3',
  'Draft 2 (line 6): suggests removing "Update the docs"',
];

describe.if(hasDom)('Ask this session: unsubmitted annotations (#1748)', () => {
  test('drafts reach the session once, read-only, never as feedback', async () => {
    const { received } = serverWithSession();
    const chat = await mountChat();
    const ask = async (prompt: string, drafts: Annotation[]) => {
      await act(async () => {
        await chat.current!.ask({ prompt, ...askParams(chat.current!, drafts, true) });
      });
    };

    // First question: the drafts arrive in their frame, before the question.
    await ask('Is my first draft right?', DRAFTS);
    expect(received[0]).toBe([
      SESSION_ASK_HEADER,
      'Surface: annotating your last message',
      '',
      SESSION_ASK_DRAFTS_LABEL,
      ...DRAFT_LINES,
      SESSION_ASK_DRAFTS_END,
      '',
      'Is my first draft right?',
    ].join('\n'));
    for (const text of received) {
      expect(text).not.toContain('Message Feedback');
      expect(text).not.toContain('pieces of feedback');
      expect(text).not.toContain('Feedback on');
      expect(text).not.toContain('Context update');
    }

    // Second question, drafts unchanged: nothing is pasted again.
    await ask('And the second one?', DRAFTS);
    expect(received[1]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', 'And the second one?'].join('\n'));

    // A draft removed: the current list replaces the earlier one.
    await ask('Better now?', [DRAFTS[0]]);
    expect(received[2]).toBe([
      SESSION_ASK_HEADER,
      'Surface: annotating your last message',
      '',
      SESSION_ASK_DRAFTS_LABEL,
      DRAFT_LINES[0],
      SESSION_ASK_DRAFTS_END,
      '',
      'Better now?',
    ].join('\n'));

    // Every draft removed: one line says so, once.
    await ask('Anything left?', []);
    expect(received[3]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', SESSION_ASK_DRAFTS_CLEARED, '', 'Anything left?'].join('\n'));
    await ask('Done?', []);
    expect(received[4]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', 'Done?'].join('\n'));
    expect(received).toHaveLength(5);
  });

  // A new thread (the App starts one on every document switch: folder and
  // bundle files, linked documents) is a new Ask AI session but the SAME agent
  // session, which already read the list. The failure this guards: the whole
  // list pasted again per thread, and drafts removed after a thread switch
  // never reported as cleared, so the agent kept a stale list.
  test('a new thread does not resend the list, and still reports it cleared', async () => {
    const { received } = serverWithSession();
    const chat = await mountChat();
    const ask = async (prompt: string, drafts: Annotation[]) => {
      await act(async () => {
        await chat.current!.ask({ prompt, ...askParams(chat.current!, drafts, true) });
      });
    };
    const newThread = async () => {
      await act(async () => { chat.current!.resetThread(); });
    };

    await ask('first', DRAFTS);
    expect(received[0]).toContain(SESSION_ASK_DRAFTS_LABEL);
    const firstSession = chat.current!.sessionId;

    await newThread();
    await ask('second', DRAFTS);
    expect(chat.current!.sessionId).not.toBe(firstSession);
    expect(received[1]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', 'second'].join('\n'));

    await newThread();
    await ask('third', []);
    expect(received[2]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', SESSION_ASK_DRAFTS_CLEARED, '', 'third'].join('\n'));
  });

  // The 0.28.6 wire: a client that still sends the feedback export as
  // contextUpdate. The server keeps it out of the session.
  test('a feedback-export contextUpdate never reaches the session', async () => {
    const { received } = serverWithSession();
    const chat = await mountChat();
    await act(async () => { await chat.current!.ask({ prompt: 'first' }); });
    const params = askParams(chat.current!, DRAFTS, false);
    expect(params.contextUpdate).toContain('pieces of feedback');
    await act(async () => { await chat.current!.ask({ prompt: 'second', ...params }); });
    expect(received[1]).toBe([SESSION_ASK_HEADER, 'Surface: annotating your last message', '', 'second'].join('\n'));
  });
});

describe('separate AI and the agent terminal', () => {
  test('a separate AI keeps the feedback export as its context update', () => {
    const exportText = exportAnnotations(BLOCKS, DRAFTS, [], 'Message Feedback', 'message');
    expect(askAIAnnotationParams({ sessionBridge: false, hasSession: true, feedbackExport: exportText, draftList: () => 'x' }))
      .toEqual({ contextUpdate: exportText });
    expect(askAIAnnotationParams({ sessionBridge: false, hasSession: false, feedbackExport: exportText, draftList: () => 'x' }))
      .toEqual({ contextUpdate: undefined });
  });

  test('the agent terminal gets the same read-only frame, not the export', () => {
    expect([ASK_DRAFTS_LABEL, ASK_DRAFTS_END, ASK_DRAFTS_CLEARED]).toEqual([
      SESSION_ASK_DRAFTS_LABEL,
      SESSION_ASK_DRAFTS_END,
      SESSION_ASK_DRAFTS_CLEARED,
    ]);
    const prompt = buildTerminalAskPrompt({
      scopedQuestion: 'Is draft 1 right?',
      documentPath: 'agent message',
      draftAnnotations: formatDraftAnnotationsForAsk({ annotations: DRAFTS, blocks: BLOCKS }),
    });
    expect(prompt).toContain([ASK_DRAFTS_LABEL, ...DRAFT_LINES, ASK_DRAFTS_END].join('\n'));
    expect(prompt).not.toContain('Current annotations');
    expect(prompt).not.toContain('pieces of feedback');
  });
});
