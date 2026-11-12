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
  expect(reads.length).toBe(1);

  const host = createInboxShapeHost({ subscribe: noBoards, wakeOnChange: () => true, busyRetryMs: 60_000 });
  await host.note(SHAPE, { kind: 'change', v: 1, text: 'Say it.' } as never);
  await settle();
  const counted = reads.length;

  act(() => emitAskChange(null));
  await settle();
  expect(reads.length - counted).toBe(1);

  act(() => emitAskChange(THREAD));
  await settle();
  expect(reads.length - counted).toBe(2);

  act(() => emitAskChange(OTHER));
  await settle();
  expect(reads.length - counted).toBe(3);
});
