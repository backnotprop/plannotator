/**
 * One event, one read of a thread's Ask, however many parts of the window follow it. The Ask window
 * (useInboxAsk), Show me (useShowMe) and a Change it waiting for a busy session (inboxShapeHost) all read
 * `GET …/threads/:id/ask` on each `onAskChange`; read on their own, one event was three GETs of one answer
 * (tests/e2e/inbox-show-me.spec.ts counts them while a Change it waits). What regresses: an event that reads
 * the thread more than once, or a reader that no longer reads at all (it would miss the change).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { emitAskChange } from './askEvents';

const hasDom = typeof document !== 'undefined';
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { useShowMe } = (hasDom ? await import('../review-drawing/useShowMe') : {}) as typeof import('../review-drawing/useShowMe');
const { createInboxShapeHost } = (hasDom ? await import('../shape/inboxShapeHost') : {}) as typeof import('../shape/inboxShapeHost');

const THREAD = 'thr_second';
const OTHER = 'thr_first';
const SHAPE = 'shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0F';

let root: Root | null = null;
let el: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  globalThis.fetch = savedFetch;
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

/** Every GET of this thread's Ask; a Change it's POST is refused: another thread's turn holds the session. */
function inbox() {
  const reads: string[] = [];
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path.endsWith(`/threads/${THREAD}/ask`)) {
      if (init?.method === 'POST') return reply({ error: 'Another question is running in this session.', code: 'ask_busy' }, 409);
      reads.push(path);
      return reply({ subject: 'Second', project: 'kettle', conversation: null, running: null, can_ask: true, agent: { name: 'Claude Code', host: 'claude-code' } });
    }
    if (path.endsWith(`/api/shapes/${SHAPE}/notes`)) return reply({ note: { id: 'not_1', kind: 'change', text: 'Say it.' } });
    if (path.includes(`/api/shapes/${SHAPE}`)) return reply({ shape: { id: SHAPE, title: 'Kettle', thread: THREAD }, version: { n: 1 }, seen: 1, notes: [{ kind: 'change', from: 'you', delivered: null }], session: { state: 'live', agent: 'Claude Code' } });
    return reply({});
  }) as typeof fetch;
  return reads;
}

function Window() {
  useInboxAsk({ on: true, codeReview: false, threadId: THREAD, phone: false, openThread: () => {}, replyInThread: () => {} });
  useShowMe({
    threadId: THREAD,
    reviewId: null,
    title: 'Second',
    round: 1,
    agent: 'Claude Code',
    others: [],
    files: [],
    boardOpen: true,
    enabled: true,
    subscribeBoards: noBoards,
    onBoard: () => {},
  });
  return null;
}
const noBoards = () => () => {};

test.skipIf(!hasDom)('the Ask window, Show me and a waiting Change it read the thread once per event', async () => {
  const reads = inbox();
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(<Window />);
  });
  await settle();
  // The window opens: the Ask window and Show me want the same answer.
  expect(reads.length).toBe(1);

  // A Change it while another thread's turn holds the session: refused, it waits for news (one read before its POST).
  const host = createInboxShapeHost({ subscribe: noBoards, wakeOnChange: () => true, busyRetryMs: 60_000 });
  await host.note(SHAPE, { kind: 'change', v: 1, text: 'Say it.' } as never);
  await settle();
  const counted = reads.length;

  // The live sessions moved (`deliveries`, a reconnect, a catch-up): all three read this thread, once.
  act(() => emitAskChange(null));
  await settle();
  expect(reads.length - counted).toBe(1);

  // This thread's chat changed: the same.
  act(() => emitAskChange(THREAD));
  await settle();
  expect(reads.length - counted).toBe(2);

  // Another thread's chat changed: only the waiting Change it looks, once.
  act(() => emitAskChange(OTHER));
  await settle();
  expect(reads.length - counted).toBe(3);
});
