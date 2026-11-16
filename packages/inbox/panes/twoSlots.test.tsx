/**
 * Two thread slots mounted side by side (thread/ThreadSlot.tsx, and panes/PaneRow.tsx as "Open beside" mounts them):
 * only the active pane receives the thread's keys and counts what it shows as seen.
 *
 * What regresses: R opening the reply box in both panes (two boxes, one keystroke typed into either), a pane beside
 * the one the person is in marking its thread read by being on screen, either rule not following the active pane
 * when it changes, and a thread already on screen going back to "Opening the thread…" when the person moves to the
 * other pane (its cached copy is one an opening would not draw: stale, or a launched thread's).
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
import { useActiveHeld, type WindowPanes } from './useRoutePanes';
import type { PaneSet } from './model';
import { putThread, staleThread } from '../data/queries/thread';
import type { HeldThread } from '../data/apply/record';

const hasDom = typeof document !== 'undefined';
// The thread pane pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadSlot } = (hasDom ? await import('../thread/ThreadSlot') : {}) as typeof import('../thread/ThreadSlot');
const { PaneRow } = (hasDom ? await import('./PaneRow') : {}) as typeof import('./PaneRow');

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
/** Each pane's pick-save calls, with the thread the pane named. */
const pickSaves: [string | null, boolean | undefined][] = [];
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
    patchQuestions: noop, onPickSaves: (_ids, paneClosed, threadId) => void pickSaves.push([threadId, paneClosed]), afterWrite: async () => {}, rowPatches: new Map(), decideInThread: () => null,
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

  test("a pane's pick saves name its own thread, not the other pane's", async () => {
    pickSaves.length = 0;
    draw('a', false, []);
    await wait(0);
    act(() => root!.unmount());
    root = null;
    expect([...pickSaves].sort()).toEqual([
      [A, true],
      [B, true],
    ]);
  });

  test('beside each other (PaneRow): the other pane is the quieter, a press in it makes it active, each ✕ closes its own pane', async () => {
    const calls: string[] = [];
    const windowPanes: WindowPanes = {
      panes: { panes: [{ id: 'main', thread: A }, { id: 'beside-1', thread: B }], active: 'main' },
      openBeside: noop,
      closePane: (id) => void calls.push(`close:${id}`),
      focus: (id) => void calls.push(`focus:${id}`),
      allowed: true,
    };
    // The other pane reads its thread from the cache (App holds only the active one's).
    putThread(queries, B, heldOf(B, false));
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() =>
      root!.render(
        <QueryClientProvider client={queries}>
          <div className="pn-inbox">
            <main className="ib-main">
              <PaneRow windowPanes={windowPanes} held={heldOf(A, false)} host={hostFor(A, noop)} />
            </main>
          </div>
        </QueryClientProvider>,
      ),
    );
    await wait(0);
    expect(paneOf(A).hasAttribute('data-pane-quiet')).toBe(false);
    expect(paneOf(B).hasAttribute('data-pane-quiet')).toBe(true);
    expect(el.querySelector('.ib-main > [data-pane-split]')).not.toBeNull();
    act(() => void paneOf(B).querySelector('.ib-pbody')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(calls).toEqual(['focus:beside-1']);
    act(() => paneOf(B).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    act(() => paneOf(A).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    expect(calls).toEqual(['focus:beside-1', 'close:beside-1', 'close:main']);
  });

  test('one pane (PaneRow) draws the slot alone, as before: no divider, no quiet header, its ✕ closes the thread', async () => {
    const closed: (string | null)[] = [];
    const windowPanes: WindowPanes = { panes: { panes: [{ id: 'main', thread: A }], active: 'main' }, openBeside: noop, closePane: noop, focus: noop, allowed: true };
    const host = { ...hostFor(A, noop), close: (next: Route) => void closed.push(next.thread) };
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() =>
      root!.render(
        <QueryClientProvider client={queries}>
          <div className="pn-inbox">
            <main className="ib-main">
              <PaneRow windowPanes={windowPanes} held={heldOf(A, false)} host={host} />
            </main>
          </div>
        </QueryClientProvider>,
      ),
    );
    await wait(0);
    expect([...el.querySelector('.ib-main')!.children].map((child) => child.tagName.toLowerCase())).toEqual(['section']);
    expect(paneOf(A).hasAttribute('data-pane-quiet')).toBe(false);
    act(() => paneOf(A).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    expect(closed).toEqual([null]);
  });
  test('the pane the person leaves keeps its thread on screen, its cached copy stale: no "Opening the thread…"', async () => {
    const one: WindowPanes = { panes: { panes: [{ id: 'main', thread: A }], active: 'main' }, openBeside: noop, closePane: noop, focus: noop, allowed: true };
    const two: WindowPanes = { ...one, panes: { panes: [{ id: 'main', thread: A }, { id: 'beside-1', thread: B }], active: 'beside-1' } };
    putThread(queries, A, heldOf(A, false));
    putThread(queries, B, heldOf(B, false));
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const render = (windowPanes: WindowPanes, held: HeldThread) =>
      act(() =>
        root!.render(
          <QueryClientProvider client={queries}>
            <div className="pn-inbox">
              <main className="ib-main">
                <PaneRow windowPanes={windowPanes} held={held} host={hostFor(A, noop)} />
              </main>
            </div>
          </QueryClientProvider>,
        ),
      );
    render(one, heldOf(A, false));
    await wait(0);
    expect(paneOf(A).querySelector('h2.ib-subject')).not.toBeNull();
    // A record the stream missed: A's copy is stale, which an opening would not draw.
    act(() => staleThread(queries, A));
    render(two, heldOf(B, false));
    await wait(0);
    expect(paneOf(A)?.querySelector('h2.ib-subject')).not.toBeNull();
    expect(el.textContent).not.toContain('Opening the thread');
  });

  test("the window's open thread (useActiveHeld): moving into a pane already on screen keeps its copy; opening one not on screen waits", async () => {
    const C = 'msg_C1';
    for (const id of [A, B, C]) {
      putThread(queries, id, heldOf(id, false));
      act(() => staleThread(queries, id));
    }
    const got: (string | null)[] = [];
    function Probe({ panes }: { panes: PaneSet }) {
      got.push(useActiveHeld(panes)?.thread.thread_id ?? null);
      return null;
    }
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const render = (panes: PaneSet) =>
      act(() =>
        root!.render(
          <QueryClientProvider client={queries}>
            <Probe panes={panes} />
          </QueryClientProvider>,
        ),
      );
    const pair = (active: string): PaneSet => ({ panes: [{ id: 'main', thread: A }, { id: 'beside-1', thread: B }], active });
    render(pair('main'));
    render(pair('beside-1'));
    expect(got.at(-1)).toBe(B);
    // The pane beside closes: A was on screen.
    render({ panes: [{ id: 'main', thread: A }], active: 'main' });
    expect(got.at(-1)).toBe(A);
    // One pane opening another thread: its stale copy waits for the read, as before.
    render({ panes: [{ id: 'main', thread: C }], active: 'main' });
    expect(got.at(-1)).toBeNull();
  });
});
