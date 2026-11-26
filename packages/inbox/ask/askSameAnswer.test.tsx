/**
 * A read that brings the same answer draws nothing. Each `deliveries` frame (about once a second while agents work)
 * reads the open thread's Ask (App's `emitAskChange(null)`), and the risk ranking reads its judgments every few
 * seconds while some run. Each read used to set a new object, so the window (useInboxAsk lives in App) drew again for
 * nothing on every frame. What regresses: an unchanged answer that commits, or a changed one that does not (the Ask
 * circle and its "answering" arc follow the sessions at once).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';
import { emitAskChange } from './askEvents';

const hasDom = typeof document !== 'undefined';
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { usePullRisk } = (hasDom ? await import('../pulls/usePullRisk') : {}) as typeof import('../pulls/usePullRisk');
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');

const THREAD = 'thr_open';

let root: Root | null = null;
let el: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
const undo: (() => void)[] = [];
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  globalThis.fetch = savedFetch;
  for (const step of undo.splice(0).reverse()) step();
  jest.useRealTimers();
});

/** One turn the fake timers leave alone: replies and effects settle. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(turn);
};

function mount(node: React.ReactNode) {
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(node);
  });
}

test.skipIf(!hasDom)('ten deliveries frames with the same Ask draw nothing; a changed Ask draws once', async () => {
  let running: unknown = null;
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]!;
    if (path.endsWith(`/threads/${THREAD}/ask`)) {
      reads++;
      return Response.json({ subject: 'Open', project: 'kettle', conversation: null, running, can_ask: true, agent: { name: 'Claude Code', host: 'claude-code' } });
    }
    return Response.json({});
  }) as typeof fetch;
  let commits = 0;
  const shown = { answering: null as boolean | null };
  function Window() {
    const ask = useInboxAsk({ on: true, codeReview: false, threadId: THREAD, phone: false, openThread: () => {}, replyInThread: () => {} });
    shown.answering = ask.corner.answering;
    return null;
  }
  mount(
    <Profiler id="window" onRender={() => commits++}>
      <Window />
    </Profiler>,
  );
  await settle();
  expect(reads).toBe(1);
  expect(shown.answering).toBe(false);

  commits = 0;
  for (let frame = 0; frame < 10; frame++) {
    act(() => emitAskChange(null));
    await settle();
  }
  // Every frame still reads (the next one may bring news)...
  expect(reads).toBe(11);
  // ...but the same answer draws nothing.
  expect(commits).toBe(0);

  // The agent starts answering: the next frame draws it, once.
  running = 'trn_1';
  act(() => emitAskChange(null));
  await settle();
  expect(commits).toBe(1);
  expect(shown.answering).toBe(true);
});

test.skipIf(!hasDom)('the risk poll while judgments run draws nothing until an answer changes', async () => {
  jest.useFakeTimers();
  const answer = (pending: number, judged: string[] = []): InboxPullRiskAnswer =>
    ({
      rules: 'Payments code is high.',
      provider: 'claude-agent-sdk',
      model: null,
      agents: [],
      judgments: Object.fromEntries(judged.map((key) => [key, { level: 'low', why: 'Docs only.', head: 'h1', at: '2026-11-21T10:00:00.000Z' }])),
      failed: {},
      pending,
      last_failure: null,
      updated_at: '2026-11-21T09:00:00.000Z',
    }) as unknown as InboxPullRiskAnswer;
  let next = answer(2);
  let reads = 0;
  const spy = spyOn(inboxApi, 'pullRisk').mockImplementation(async () => {
    reads++;
    // A new object each read, as the wire gives.
    return structuredClone(next);
  });
  undo.push(() => spy.mockRestore());
  let commits = 0;
  function Page() {
    usePullRisk('list-1');
    return null;
  }
  mount(
    <Profiler id="page" onRender={() => commits++}>
      <Page />
    </Profiler>,
  );
  await settle();
  expect(reads).toBe(1);

  commits = 0;
  for (let tick = 0; tick < 5; tick++) {
    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await turn();
    });
    await settle();
  }
  expect(reads).toBe(6);
  expect(commits).toBe(0);

  // A judgment lands: drawn once.
  next = answer(1, ['github.com/n/b#1']);
  await act(async () => {
    jest.advanceTimersByTime(4_000);
    await turn();
  });
  await settle();
  expect(commits).toBe(1);
});
