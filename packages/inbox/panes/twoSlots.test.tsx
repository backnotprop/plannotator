/**
 * Two thread slots mounted side by side (thread/ThreadSlot.tsx), as a second pane will mount them: only the active
 * pane receives the thread's keys and counts what it shows as seen. The window mounts one slot today; this harness
 * is the only place two exist.
 *
 * What regresses: R opening the reply box in both panes (two boxes, one keystroke typed into either), a pane beside
 * the one the person is in marking its thread read by being on screen, and either rule not following the active
 * pane when it changes.
 *
 * happy-dom has no layout: the threads' bodies and messages get their boxes from the test, as in seenOnSight.test.tsx,
 * and time runs on fake timers that `wait` advances.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';
import { machinesModel } from '../machines';
import { createKeyedSignal } from '../signal';
import { createStepsBus } from '../steps/useThreadSteps';
import { SEEN_DWELL_MS } from '../seenOnSight';
import type { ThreadSlotHost } from '../thread/slotHost';
import { createPanesOnScreen } from './onScreen';
import { NO_OPEN, type PaneReads } from './paneReads';

const hasDom = typeof document !== 'undefined';
// The thread pane pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadSlot } = (hasDom ? await import('../thread/ThreadSlot') : {}) as typeof import('../thread/ThreadSlot');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-12T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };

function message(thread: string, id: string, seq: number, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: thread,
    reply_to: id === thread ? null : thread,
    author: AGENT,
    subject: id === thread ? `Subject ${thread}` : null,
    body,
    created_at: `2026-10-12T17:${String(30 + seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...extra,
  };
}

const A = 'msg_A1';
const B = 'msg_B1';
/** Each thread as it was opened (the look covered seq 2), then with one agent message arrived. */
const threadOf = (id: string, arrived: boolean): InboxThread => ({
  thread_id: id,
  project: PROJECT,
  subject: `Subject ${id}`,
  thread_name: null,
  resolved_at: null,
  messages: [message(id, id, 2, 'The webhook is wired.', { person_seen_seq: 2 }), ...(arrived ? [message(id, `${id}_new`, 6, 'Retries are on.')] : [])],
});

// Each arrival's box in its pane's view (each body is 0..800).
const boxes: Record<string, { top: number; height: number }> = { [`${A}_new`]: { top: 100, height: 200 }, [`${B}_new`]: { top: 400, height: 200 } };
const restore: (() => void)[] = [];
let root: Root | null = null;
let el: HTMLElement | null = null;
let savedFetch: typeof fetch;

function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => (saved ? Object.defineProperty(target, key, saved) : delete (target as Record<string, unknown>)[key]));
}

const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function wait(ms: number) {
  await act(async () => {
    await settle();
    jest.advanceTimersByTime(ms);
    await settle();
  });
}

beforeEach(() => {
  if (!hasDom) return;
  jest.useFakeTimers();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return Response.json({ questions: [] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      if (this.classList.contains('ib-pbody')) return rect(0, 800);
      const article = this.closest<HTMLElement>('[data-message-article]');
      const box = article ? (boxes[article.getAttribute('data-message-article')!] ?? { top: 5000, height: 300 }) : null;
      if (!box) return rect(0, 0);
      if (this.classList.contains('ib-fline')) return rect(box.top, 30);
      return this === article ? rect(box.top, box.height) : rect(box.top, 0);
    },
  });
  // No hit test: two panes share one view's coordinates here, and what is drawn on top is not what this file checks.
  stub(document, 'elementFromPoint', { value: undefined });
  stub(document, 'visibilityState', { get: () => 'visible' });
  stub(document, 'hasFocus', { value: () => true });
});

afterEach(() => {
  if (!hasDom) return;
  try {
    act(() => root?.unmount());
    el?.remove();
  } finally {
    root = null;
    el = null;
    globalThis.fetch = savedFetch;
    try {
      for (const undo of restore.splice(0).reverse()) undo();
    } finally {
      jest.useRealTimers();
    }
  }
});

const noop = () => {};
const none = async () => null;

/** The window's side of one slot: its look at the open, and where its seen-on-sight goes. */
function hostFor(threadId: string, seen: (threadId: string, through: number) => void): ThreadSlotHost {
  const route: Route = { page: 'inbox', project: null, thread: threadId };
  const paneReads = { view: () => ({ ...NO_OPEN, look: { threadId, seq: 2, through: 2 } }), retry: noop } as unknown as PaneReads;
  return {
    route, routeRef: { current: route }, rowsPending: false, paneReads,
    outbox: new Map(), dismissOutbox: noop, phone: false, stack: { thread: false, file: false }, full: false, fromCard: null,
    fileOpen: false, staleNotice: null, notifyAgainIn: null, notifications: {} as ThreadSlotHost['notifications'], soundOn: false, settings: null,
    saveTour: noop, go: noop, leave: noop, close: noop, openCompose: noop, pullReviewOf: null, reviewView: null, pullsShown: false,
    stepsBus: createStepsBus(), boardEnabled: null, boardsOn: false, cards: null, backToCard: noop, openThreadRow: null, snoozeBack: null,
    refreshThread: none, refreshList: none, shown: null, markRead: none, markUnread: none, acknowledge: none,
    markAction: none, archive: none, pinnedIds: new Set(), pinsOn: false, machines: machinesModel([]), setPin: none, setPriority: noop,
    snoozeOn: false, snooze: noop, unsnooze: noop, setMachineUpdateOpen: noop, threadAgentContext: null, replyFor: null, setReplyFor: noop,
    draftSignals: createKeyedSignal(), filesSignals: createKeyedSignal(), shapes: { byThread: new Map() } as unknown as ThreadSlotHost['shapes'],
    ask: { side: undefined, sideWords: undefined }, askReply: null, setAskReply: noop, shapeReply: null, setShapeReply: noop,
    patchQuestions: noop, onPickSaves: noop, afterWrite: async () => {}, rowPatches: new Map(), decideInThread: () => null,
    searchLanding: { current: null }, decideLanding: { current: null }, landed: noop,
    seenOnSight: seen, covered: false, panesOnScreen: createPanesOnScreen(), setOpenThreadCovered: noop, listTitle: 'Inbox', fullSidebar: true,
    setThreadFull: noop, leaveFull: noop, showToast: noop, toastNow: { current: null }, dismissToast: noop, inboxLink: () => null,
    holdSidebarIfTight: noop, backFromFile: { current: null },
  };
}

const queries = new QueryClient();
const heldOf = (id: string, arrived: boolean) => ({ serverSession: 's', cursor: 0, thread: threadOf(id, arrived) });

/** Two panes, A on the left and B on the right, `active` the one the person is in. */
function draw(active: 'a' | 'b', arrived: boolean, seen: [string, number][]) {
  const record = (threadId: string, through: number) => void seen.push([threadId, through]);
  const panes = (
    <QueryClientProvider client={queries}>
      <div className="pn-inbox">
        <ThreadSlot paneId="a" threadId={A} active={active === 'a'} held={heldOf(A, arrived)} host={hostFor(A, record)} />
        <ThreadSlot paneId="b" threadId={B} active={active === 'b'} held={heldOf(B, arrived)} host={hostFor(B, record)} />
      </div>
    </QueryClientProvider>
  );
  if (!root) {
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
  }
  act(() => root!.render(panes));
}

const paneOf = (thread: string) => el!.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${thread}"]`)!;
const box = (thread: string) => paneOf(thread).querySelector('textarea');
const pressR = () =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true }));
  });

describe.skipIf(!hasDom)('two thread slots: only the active pane takes keys and sees', () => {
  test('R opens the reply box in the active pane only, and follows the active pane when it changes', async () => {
    const seen: [string, number][] = [];
    draw('a', false, seen);
    await wait(0);
    // Both panes offer Reply: what decides is which pane is active.
    expect(paneOf(A).querySelector('[data-reply-button]')).not.toBeNull();
    expect(paneOf(B).querySelector('[data-reply-button]')).not.toBeNull();
    pressR();
    await wait(0);
    expect(box(A)).not.toBeNull();
    expect(box(B)).toBeNull();
    // B becomes active: R is B's now.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    draw('b', false, seen);
    await wait(0);
    pressR();
    await wait(0);
    expect(box(B)).not.toBeNull();
  });

  test('with B active from the start, R leaves A alone', async () => {
    draw('b', false, []);
    await wait(0);
    pressR();
    await wait(0);
    expect(box(B)).not.toBeNull();
    expect(box(A)).toBeNull();
  });

  test('an arrival on screen in both panes is seen in the active pane only; making the other active sees it there', async () => {
    const seen: [string, number][] = [];
    draw('a', false, seen);
    await wait(0);
    draw('a', true, seen);
    await wait(60);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([[A, 6]]);
    // B stays unseen however long it is on screen beside the active pane.
    await wait(SEEN_DWELL_MS * 3);
    expect(seen).toEqual([[A, 6]]);
    draw('b', true, seen);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([
      [A, 6],
      [B, 6],
    ]);
  });
});
