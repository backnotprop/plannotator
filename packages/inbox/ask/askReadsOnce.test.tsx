/**
 * One event, one read of a thread's Ask, however many parts of the window follow it. The Ask window
 * (useInboxAsk) and the review's Ask on selected lines (useCanAsk) both read `GET …/threads/:id/ask` on each
 * `onAskChange`; read on their own, one event was a GET each of one answer. What regresses: an event that
 * reads the thread more than once, or a reader that no longer reads at all (it would miss the change).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { emitAskChange } from './askEvents';
import { rememberMachine } from '../inboxUrl';

const hasDom = typeof document !== 'undefined';
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { useCanAsk } = (hasDom ? await import('./useCanAsk') : {}) as typeof import('./useCanAsk');

const THREAD = 'thr_second';
const OTHER = 'thr_first';

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

/** Every GET of this thread's Ask. */
function inbox() {
  const reads: string[] = [];
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path.endsWith(`/threads/${THREAD}/ask`) && init?.method !== 'POST') {
      reads.push(path);
      return reply({ subject: 'Second', project: 'kettle', conversation: null, running: null, can_ask: true, agent: { name: 'Claude Code', host: 'claude-code' } });
    }
    return reply({});
  }) as typeof fetch;
  return reads;
}

let canAsk = false;
function Window() {
  useInboxAsk({ on: true, codeReview: false, threadId: THREAD, phone: false, openThread: () => {}, replyInThread: () => {} });
  canAsk = useCanAsk(THREAD, true);
  return null;
}

test.skipIf(!hasDom)("the Ask window and the review's Ask on selected lines read the thread once per event", async () => {
  const reads = inbox();
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(<Window />);
  });
  await settle();
  // The window opens: both want the same answer.
  expect(reads.length).toBe(1);
  expect(canAsk).toBe(true);
  const counted = reads.length;

  // The live sessions moved (`deliveries`, a reconnect, a catch-up): both read this thread, once.
  act(() => emitAskChange(null));
  await settle();
  expect(reads.length - counted).toBe(1);

  // This thread's chat changed: the same.
  act(() => emitAskChange(THREAD));
  await settle();
  expect(reads.length - counted).toBe(2);

  // Another thread's chat changed: neither reads.
  act(() => emitAskChange(OTHER));
  await settle();
  expect(reads.length - counted).toBe(2);
});

test.skipIf(!hasDom)("a linked machine's review never reads Ask on this Inbox (it has no such thread here: a 404)", async () => {
  const FAR = 'msg_01M8AJQCZ1AGWDGQV42A4Y2DR4';
  rememberMachine([FAR], 'ibx_01JZ5Q7M9K2N4P6R8T0V1W3X5Y');
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input).split('?')[0]!);
    return Response.json({ can_ask: true });
  }) as typeof fetch;
  let far = true;
  function FarReview() {
    far = useCanAsk(FAR, true);
    return null;
  }
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(<FarReview />);
  });
  await settle();
  act(() => emitAskChange(null));
  await settle();
  expect(asked.filter((path) => path.endsWith('/ask'))).toEqual([]);
  expect(far).toBe(false);
});
