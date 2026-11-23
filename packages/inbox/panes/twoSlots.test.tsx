/**
 * Thread slots mounted side by side (thread/ThreadSlot.tsx, and panes/ThreadPanes.tsx as the free layout mounts them):
 * only the active pane receives the thread's keys and counts what it shows as seen.
 *
 * What regresses: R opening the reply box in both panes (two boxes, one keystroke typed into either), a pane beside
 * the one the person is in marking its thread read by being on screen, either rule not following the active pane
 * when it changes, and a thread already on screen going back to "Opening the thread…" when the person moves to the
 * other pane (its cached copy is one an opening would not draw: stale, or a launched thread's). For the free layout
 * (config.json `inboxSplitView`): the window without the switch changing at all; a pane dragged onto another's half
 * not going there; a list row dropped on an edge or a centre not opening there, or a drop over a reply box going to the
 * pane, not to the box's mention; an edge with no room taking the drop silently (into the pane's place) instead of
 * saying so and opening on the other axis where that fits, or doing anything where nothing fits; one row press starting two drags (the window has one thread drag, ../threadDrag.ts);
 * a pane mounting again when another opens or the active one changes; an archived thread's pane staying; text typed
 * in one pane's reply box showing in another's; a narrow window losing the panes it cannot show. And any change
 * of layout (a narrow window, a file beside the active pane, one pane on a phone, a stacked window, a card's or
 * Reviews' thread, a file full screen, one pane and back) losing a pane's reply box, a picked answer, an unfolded
 * message or its scroll place; a recording going on in a pane off the page (it stops, its words kept); a deleted
 * thread's pane closing under a recording.
 *
 * happy-dom has no layout: the threads' bodies and messages get their boxes from the test, as in seenOnSight.test.tsx,
 * and time runs on fake timers that `wait` advances.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';
import { machinesModel } from '../machines';
import { createKeyedSignal } from '../signal';
import { createStepsBus } from '../steps/useThreadSteps';
import { SEEN_DWELL_MS } from '../seenOnSight';
import type { ThreadSlotHost } from '../thread/slotHost';
import { createPanesOnScreen } from './onScreen';
import { NO_OPEN, type PaneReads } from './paneReads';
import { useActiveHeld, type WindowPanes } from './useRoutePanes';
import { singlePane, type PaneSet } from './model';
import * as L from './layoutModel';
import { changeThread, putThread, staleThread } from '../data/queries/thread';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { HeldThread } from '../data/apply/record';

const hasDom = typeof document !== 'undefined';
// The thread pane pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadSlot } = (hasDom ? await import('../thread/ThreadSlot') : {}) as typeof import('../thread/ThreadSlot');
const { ThreadPanes } = (hasDom ? await import('./ThreadPanes') : {}) as typeof import('./ThreadPanes');
const { ThreadRowMenu } = (hasDom ? await import('../components/RowMenu') : {}) as typeof import('../components/RowMenu');
const { setThreadDragHitTestForTests } = (hasDom ? await import('../threadDrag') : {}) as typeof import('../threadDrag');

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
    // A pick still saving: picked on screen, its save not answered (the state a remount would lose).
    if (init?.method === 'POST' && path.endsWith('/picks')) return new Promise<Response>(() => {});
    if (init?.method === 'POST') return Response.json({ questions: [] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    if (path.includes('/voice/status')) return Response.json({ state: 'ready', plan: null });
    return Response.json({});
  }) as typeof fetch;
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      if (this.classList.contains('ib-main') || this.classList.contains('pn-inbox')) return { ...rect(0, mainHeight), right: mainWidth, width: mainWidth };
      const host = this.dataset.layoutPane ? hostBoxes[this.dataset.layoutPane] : undefined;
      if (host) return { ...rect(0, 900), left: host.left, right: host.left + host.width, width: host.width, x: host.left };
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
    // A drag's swallow of the click after it (paneDrag.ts) ends at the next press, or a timer this file's
    // fake clock may never run: the next test's first click is its own.
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    setThreadDragHitTestForTests(null);
    // The window's thread drag swallows the click after a drop once, until a 400 ms timer the fake clock may not run.
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
/** The panes the window last said were off the page (paneReads.ts `park`): they read nothing there. */
let parked: string[] = [];
const park = (ids: ReadonlySet<string>) => void (parked = [...ids]);

/** The window's side of one slot: its look at the open, and where its seen-on-sight goes. */
function hostFor(threadId: string, seen: (threadId: string, through: number) => void): ThreadSlotHost {
  const route: Route = { page: 'inbox', project: null, thread: threadId };
  const paneReads = { view: () => ({ ...NO_OPEN, look: { threadId, seq: 2, through: 2 } }), retry: noop, park } as unknown as PaneReads;
  return {
    route, routeRef: { current: route }, rowsPending: false, paneReads,
    outbox: new Map(), dismissOutbox: noop, phone: false, stack: { thread: false, file: false }, full: false, fromCard: null,
    fileOpen: false, staleNotice: null, notifyAgainIn: null, notifications: {} as ThreadSlotHost['notifications'], soundOn: false, settings: null,
    saveTour: noop, go: noop, leave: noop, close: noop, openCompose: noop, pullReviewOf: null, reviewView: null, pullsShown: false,
    stepsBus: createStepsBus(), boardEnabled: null, boardsOn: false, cards: null, backToCard: noop, openThreadRow: null, snoozeBack: null,
    refreshThread: none, refreshList: none, shown: null, markRead: none, markUnread: none, acknowledge: none,
    markAction: none, archive: none, pinnedIds: new Set(), pinsOn: false, machines: machinesModel([]), setPin: none, setPriority: noop,
    snoozeOn: false, snooze: noop, unsnooze: noop, setMachineUpdateOpen: noop, threadAgentContext: null, replyFor: null, setReplyFor: noop,
    draftSignals: createKeyedSignal(), filesSignals: createKeyedSignal(), shapes: { byThread: new Map() } as unknown as ThreadSlotHost['shapes'], board: null,
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


/** The window's panes as a test sets them (`layout`, layoutModel.ts), each verb recorded in `calls`; `allowed` false: no switch. */
function windowOf(layout: L.FreeLayout, calls: string[] = [], allowed = true): WindowPanes {
  return {
    panes: allowed ? L.asPaneSet(layout) : singlePane(L.activeThread(layout)),
    layout: allowed ? layout : L.EMPTY_LAYOUT,
    columns: L.columns(layout.root),
    openBeside: (t) => void calls.push(`beside:${t}`),
    openAt: (t, target, edge) => void calls.push(`open:${t}:${target}:${edge}`),
    replaceIn: (target, t) => void calls.push(`replace:${target}:${t}`),
    movePane: (id, target, edge) => void calls.push(`move:${id}:${target}:${edge}`),
    closePane: (id) => void calls.push(`close:${id}`),
    closeThreads: (threads) => void calls.push(`gone:${threads.join()}`),
    focus: (id) => void calls.push(`focus:${id}`),
    resized: () => void calls.push('resized'),
    allowed,
    restored: new Set(),
  };
}
/** A on the left (pane `main`), B right of it (pane `p1`), `active` the one the person is in. */
const pair = (active: 'main' | 'p1') => L.focus(L.openAt(L.follow(L.EMPTY_LAYOUT, A), B, 'main', 'right'), active);
const panesHost = (host: ThreadSlotHost) => ({ ...host, rowOf: () => null });
/** The room `.ib-main` gives the panes (no list in it here), and each pane host's box: main the left half, p1 the right. */
let mainWidth = 1600;
let mainHeight = 900;
const hostBoxes: Record<string, { left: number; width: number }> = { main: { left: 0, width: 800 }, p1: { left: 800, width: 800 } };

function drawPanes(windowPanes: WindowPanes, host: ThreadSlotHost, held: HeldThread = heldOf(A, false), withList = false) {
  // What is under the pointer: nothing in particular (the reply-box test says otherwise).
  stub(document, 'elementFromPoint', { value: () => null });
  if (!root) {
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
  }
  act(() =>
    root!.render(
      <QueryClientProvider client={queries}>
        <div className="pn-inbox">
          <main className="ib-main">
            {withList && (
              // The list as App draws it: its rows are the window's one thread drag's source (useThreadRowDrag.ts).
              <ThreadRowMenu className="ib-lbody" rowOf={(id) => (id === 'msg_C1' ? listRow(id) : null)} canMarkRead={true} held={true} onAction={() => {}} onTarget={() => {}}>
                <button type="button" className="ib-row" data-thread-id="msg_C1">
                  <span className="ib-subj">Subject C</span>
                </button>
              </ThreadRowMenu>
            )}
            <ThreadPanes windowPanes={windowPanes} held={held} host={panesHost(host)} />
          </main>
        </div>
      </QueryClientProvider>,
    ),
  );
}
const hostOf = (thread: string) => paneOf(thread).closest<HTMLElement>('[data-layout-pane]')!;
const drag = (x: number, y: number) => act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, buttons: 1, bubbles: true })));
const release = (x: number, y: number) => act(() => void window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 1, buttons: 0, bubbles: true })));
/** A list row as the list's read has it (what the row drag names the thread by). */
const listRow = (id: string) =>
  ({ thread_id: id, subject: 'Subject C', thread_name: null, section: 'new', unread: true, unseen: 1, answered_not_sent: false, resolved_at: null, read_at: null, questions: { open: 0, picked: 0, stopped: false, holds_up: [] } }) as unknown as InboxListRow;
/** A mouse press on the list's row C. */
const pressRow = () => {
  const row = el!.querySelector<HTMLElement>('.ib-lbody [data-thread-id="msg_C1"]')!;
  act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 100, clientY: 900, pointerId: 1, pointerType: 'mouse' })));
  return row;
};
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

  // The rest of this file draws the panes as the window does (ThreadPanes.tsx): the free layout of config.json
  // `inboxSplitView`, or today's one slot.
  test("off (no switch): ThreadPanes draws exactly today's slot, byte for byte", async () => {
    putThread(queries, A, heldOf(A, false));
    const html = (node: ReactNode) => {
      const at = document.createElement('div');
      document.body.appendChild(at);
      const r = createRoot(at);
      act(() => r.render(<QueryClientProvider client={queries}><div className="pn-inbox"><main className="ib-main">{node}</main></div></QueryClientProvider>));
      // React's generated ids count across roots: the only difference two identical trees in two roots may have.
      const out = at.innerHTML.replace(/_r_[0-9a-z]+_|[:«]r[0-9a-z]+[:»]/g, 'ID');
      act(() => r.unmount());
      at.remove();
      return out;
    };
    const today = html(<ThreadSlot paneId="main" threadId={A} active held={heldOf(A, false)} host={hostFor(A, noop)} />);
    const off = html(<ThreadPanes windowPanes={windowOf(L.follow(L.EMPTY_LAYOUT, A), [], false)} held={heldOf(A, false)} host={panesHost(hostFor(A, noop))} />);
    expect(today).toContain('ib-pane');
    expect(off).toBe(today);
  });

  test('one pane with the switch on: no divider, no quieter header, no pane actions, and its ✕ closes the thread', async () => {
    const closed: (string | null)[] = [];
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A)), { ...hostFor(A, noop), close: (next: Route) => void closed.push(next.thread) });
    await wait(0);
    expect(el!.querySelectorAll('section.ib-pane')).toHaveLength(1);
    expect(el!.querySelector('.pierre-layout-separator')).toBeNull();
    expect(el!.querySelector('[data-pane-quiet]')).toBeNull();
    act(() => paneOf(A).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    expect(closed).toEqual([null]);
  });

  test('beside each other: the other pane is the quieter, a press in it makes it active, each ✕ closes its own pane', async () => {
    const calls: string[] = [];
    putThread(queries, B, heldOf(B, false));
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop));
    await wait(0);
    expect(hostOf(A).hasAttribute('data-pane-quiet')).toBe(false);
    expect(hostOf(B).hasAttribute('data-pane-quiet')).toBe(true);
    expect(el!.querySelector('.ib-layout > .pierre-layout-separator')).not.toBeNull();
    act(() => void paneOf(B).querySelector('.ib-pbody')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(calls).toEqual(['focus:p1']);
    act(() => paneOf(B).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    act(() => paneOf(A).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!.click());
    expect(calls).toEqual(['focus:p1', 'close:p1', 'close:main']);
  });

  test("a key on a pane's ✕ beside another: it is said, and focus, gone with it, lands on the subject of the pane the person is in; after a click neither", async () => {
    putThread(queries, B, heldOf(B, false));
    // Everything drawn has a box here (focusFirst and focusLost read getClientRects).
    stub(HTMLElement.prototype, 'getClientRects', { value(this: HTMLElement) { return this.isConnected ? [rect(0, 10)] : []; } });
    const closeB = async (key: boolean) => {
      let layout = pair('main');
      drawPanes({ ...windowOf(layout), closePane: (id) => void (layout = L.close(layout, id)) }, hostFor(A, noop));
      await wait(0);
      const x = paneOf(B).querySelector<HTMLElement>('button[aria-label="Close the thread"]')!;
      x.focus();
      // A key (Enter on the ✕), or a mouse: lastInput.ts tells them apart.
      if (key) act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      else act(() => void window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      act(() => void x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: key ? 0 : 1 })));
      drawPanes(windowOf(layout), hostFor(A, noop));
      await wait(50);
      expect(el!.querySelector(`section.ib-pane[data-thread-id="${B}"]`)).toBeNull();
      return document.activeElement as HTMLElement | null;
    };
    const said = () => document.querySelector('[data-drag-live]')?.textContent ?? '';
    const byKey = await closeB(true);
    expect(byKey?.matches('h2.ib-subject')).toBe(true);
    // A screen reader hears it, as the ⋯ menu's Move is heard.
    expect(said()).toBe('Pane closed.');
    expect(byKey?.closest('section.ib-pane')?.getAttribute('data-thread-id')).toBe(A);
    act(() => root!.unmount());
    root = null;
    // The live region went with the window; a click that said something would make a new one.
    const byClick = await closeB(false);
    expect(byClick?.matches('h2.ib-subject') ?? false).toBe(false);
    expect(said()).toBe('');
  });

  test('the list hidden (full screen): its way back leads the top-left pane only; a stacked window draws the active pane alone', async () => {
    putThread(queries, B, heldOf(B, false));
    const fulls: boolean[] = [];
    drawPanes(windowOf(pair('main')), { ...hostFor(A, noop), full: true, leaveFull: () => void fulls.push(false) });
    await wait(0);
    expect(paneOf(A).querySelector('[data-full-back]')).not.toBeNull();
    expect(paneOf(B).querySelector('[data-full-back]')).toBeNull();
    const closes = (thread: string) => paneOf(thread).querySelector('button[aria-label="Close the thread"]') !== null;
    expect([closes(A), closes(B)]).toEqual([true, true]);
    act(() => paneOf(A).querySelector<HTMLElement>('[data-full-back]')!.click());
    expect(fulls).toEqual([false]);
    drawPanes(windowOf(pair('main')), { ...hostFor(A, noop), stack: { thread: true, file: false } });
    await wait(0);
    expect(paneOf(A).querySelector('[data-stack-back]')).not.toBeNull();
    expect(paneOf(B)).toBeNull();
  });

  test('a stacked window with no thread open, then a row opened: the thread shows in today\'s one slot', async () => {
    putThread(queries, A, heldOf(A, false));
    const stacked = { ...hostFor(A, noop), stack: { thread: true, file: false } };
    drawPanes(windowOf(L.EMPTY_LAYOUT), stacked);
    await wait(0);
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A)), stacked);
    await wait(0);
    expect(paneOf(A)).not.toBeNull();
    expect(paneOf(A).closest('.ib-panehost')).not.toBeNull();
  });

  test('the pane the person leaves keeps its thread on screen, its cached copy stale: no "Opening the thread…"', async () => {
    putThread(queries, A, heldOf(A, false));
    putThread(queries, B, heldOf(B, false));
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A)), hostFor(A, noop));
    await wait(0);
    const section = paneOf(A);
    expect(section.querySelector('h2.ib-subject')).not.toBeNull();
    // A record the stream missed: A's copy is stale, which an opening would not draw.
    act(() => staleThread(queries, A));
    drawPanes(windowOf(pair('p1')), hostFor(B, noop), heldOf(B, false));
    await wait(0);
    expect(paneOf(A)?.querySelector('h2.ib-subject')).not.toBeNull();
    // The same pane, never mounted again: its scroll and its reply box stay.
    expect(paneOf(A)).toBe(section);
    expect(el!.textContent).not.toContain('Opening the thread');
  });

  test('a pane dragged by its header onto each half of another goes to that side of it', async () => {
    putThread(queries, B, heldOf(B, false));
    for (const [edge, x, y] of [['left', 40, 450], ['right', 760, 450], ['top', 400, 30], ['bottom', 400, 870]] as const) {
      const calls: string[] = [];
      drawPanes(windowOf(pair('main'), calls), hostFor(A, noop));
      await wait(0);
      calls.length = 0;
      const head = paneOf(B).querySelector<HTMLElement>('.ib-phead')!;
      act(() => void head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1200, clientY: 20, pointerId: 1, pointerType: 'mouse' })));
      drag(x, y);
      expect(document.querySelector('.ib-droppreview')).not.toBeNull();
      expect(document.querySelector('.ib-dragghost')?.textContent).toContain('Move here');
      release(x, y);
      expect(calls.filter((call) => call.startsWith('move'))).toEqual([`move:p1:main:${edge}`]);
      expect(document.querySelector('.ib-droppreview')).toBeNull();
    }
  });

  test("a list row dropped on a pane's edge opens beside it, on its centre takes its place; over the reply box it is the box's", async () => {
    putThread(queries, B, heldOf(B, false));
    const calls: string[] = [];
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    // What the window's thread drag finds under the pointer: inside pane A.
    setThreadDragHitTestForTests(() => paneOf(A));
    const carry = (x: number, y: number) => {
      pressRow();
      drag(x, y);
      release(x, y);
    };
    // One row press is one drag: the window's ghost alone, saying what a drop does there.
    pressRow();
    drag(40, 450);
    expect(document.querySelectorAll('[data-thread-ghost]')).toHaveLength(1);
    expect(document.querySelector('.ib-dragghost')).toBeNull();
    expect(document.querySelector('[data-thread-ghost] .ib-tdrag-w')!.textContent).toBe('Open on the left');
    expect(document.querySelector('.ib-droppreview')).not.toBeNull();
    release(40, 450);
    expect(document.querySelector('.ib-droppreview')).toBeNull();
    carry(400, 450);
    expect(calls).toEqual(['open:msg_C1:main:left', 'replace:main:msg_C1']);
    // Over pane A's open reply box, the box's own target (a mention, layer `reply`) takes the drop, not the pane.
    pressR();
    const field = box(A)!;
    expect(field).not.toBeNull();
    stub(document, 'elementFromPoint', { value: () => field });
    setThreadDragHitTestForTests(() => field);
    pressRow();
    drag(400, 850);
    expect(document.querySelectorAll('[data-thread-ghost]')).toHaveLength(1);
    expect(document.querySelector('[data-thread-ghost] .ib-tdrag-w')!.textContent).toBe('Mention');
    release(400, 850);
    expect(field.value).toContain('Subject C');
    expect(calls).toEqual(['open:msg_C1:main:left', 'replace:main:msg_C1']);
  });

  test('an edge with no room says so before the release: the other axis where it fits, else nothing at all', async () => {
    putThread(queries, B, heldOf(B, false));
    const calls: string[] = [];
    // Room for the two columns there are, not a third (801 px of 1000; a third needs 1202); 900 px tall, so a row fits below.
    mainWidth = 1000;
    try {
      drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
      await wait(0);
      calls.length = 0;
      setThreadDragHitTestForTests(() => paneOf(A));
      const word = () => document.querySelector('[data-thread-ghost] .ib-tdrag-w')!.textContent;
      // A's left edge, low on the pane: no third column, so it says so and opens below A instead, the zone its lower half.
      pressRow();
      drag(40, 600);
      expect(word()).toBe('Too narrow: opens below');
      const zone = document.querySelector<HTMLElement>('.ib-droppreview')!;
      expect([zone.style.top, zone.style.height]).toEqual(['450px', '450px']);
      release(40, 600);
      expect(calls).toEqual(['open:msg_C1:main:bottom']);
      // Too short for two rows as well (500 px): it says so, draws no zone, and the drop changes nothing.
      mainHeight = 500;
      calls.length = 0;
      pressRow();
      drag(40, 600);
      expect(word()).toBe('No room to split here');
      expect(document.querySelector('.ib-droppreview')).toBeNull();
      release(40, 600);
      expect(calls).toEqual([]);
      // Its centre still takes the pane's place.
      pressRow();
      drag(400, 450);
      expect(word()).toBe('Open here');
      release(400, 450);
      expect(calls).toEqual(['replace:main:msg_C1']);
    } finally {
      mainWidth = 1600;
      mainHeight = 900;
    }
  });

  test("the whole pane area's outer edge: a row opens a full-height column there, a pane moves there; with no room it says so and nothing changes", async () => {
    putThread(queries, B, heldOf(B, false));
    const calls: string[] = [];
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    const word = () => document.querySelector('[data-thread-ghost] .ib-tdrag-w')!.textContent;
    // The right rim lies in pane B's own right edge zone: there the whole side wins.
    setThreadDragHitTestForTests(() => paneOf(B));
    pressRow();
    drag(1560, 450);
    expect(word()).toBe('Open on the right');
    drag(1590, 450);
    expect(word()).toBe('Open on the right, full height');
    // The zone drawn is the column it opens: the area's full height at its right end, one column's share.
    const zone = document.querySelector<HTMLElement>('.ib-droppreview')!;
    expect([zone.style.top, zone.style.height]).toEqual(['0px', '900px']);
    expect(parseFloat(zone.style.left) + parseFloat(zone.style.width)).toBeCloseTo(1600, 0);
    expect(parseFloat(zone.style.width)).toBeGreaterThan(400);
    expect(parseFloat(zone.style.width)).toBeLessThan(600);
    release(1590, 450);
    expect(calls).toEqual(['open:msg_C1:*:right']);
    // A pane by its header to the left rim (inside pane A): it moves to the whole left side.
    calls.length = 0;
    const head = paneOf(B).querySelector<HTMLElement>('.ib-phead')!;
    act(() => void head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1200, clientY: 20, pointerId: 1, pointerType: 'mouse' })));
    drag(10, 450);
    expect(document.querySelector('.ib-dragghost')?.textContent).toContain('Move on the left, full height');
    release(10, 450);
    expect(calls.filter((call) => call.startsWith('move'))).toEqual(['move:p1:*:left']);
    // Room for the two columns there are, not a third: it says so, draws nothing, and takes no other side.
    mainWidth = 1000;
    try {
      calls.length = 0;
      pressRow();
      drag(1590, 450);
      expect(word()).toBe('No room on the right');
      expect(document.querySelector('.ib-droppreview')).toBeNull();
      release(1590, 450);
      expect(calls).toEqual([]);
    } finally {
      mainWidth = 1600;
    }
  });

  test("with one thread open, a row dropped on its pane's edge opens beside it", async () => {
    const calls: string[] = [];
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    setThreadDragHitTestForTests(() => paneOf(A));
    pressRow();
    drag(760, 450);
    release(760, 450);
    expect(calls).toEqual(['open:msg_C1:main:right']);
  });

  test("the pane's foot: closed (Reply, Looks good), it is the bottom edge and opens below; with the reply box open, a drop there does nothing", async () => {
    const calls: string[] = [];
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    const foot = paneOf(A).querySelector<HTMLElement>('.ib-pfoot')!;
    expect(foot.querySelector('.ib-rbox')).toBeNull();
    const reply = foot.querySelector<HTMLElement>('button') ?? foot;
    stub(document, 'elementFromPoint', { value: () => reply });
    setThreadDragHitTestForTests(() => paneOf(A));
    const word = () => document.querySelector('[data-thread-ghost] .ib-tdrag-w')!.textContent;
    pressRow();
    drag(400, 870);
    expect(word()).toBe('Open below');
    expect(document.querySelector('.ib-droppreview')).not.toBeNull();
    release(400, 870);
    expect(calls).toEqual(['open:msg_C1:main:bottom']);
    // The reply box open: the foot around it takes no pane drop (no word, no zone, nothing changes).
    calls.length = 0;
    pressR();
    expect(foot.querySelector('.ib-rbox')).not.toBeNull();
    stub(document, 'elementFromPoint', { value: () => foot });
    pressRow();
    drag(400, 870);
    expect(word()).toBe('');
    expect(document.querySelector('.ib-droppreview')).toBeNull();
    // The foot's part of the area's rim strip (the bottom 24 px) takes none either.
    drag(400, 892);
    expect(word()).toBe('');
    expect(document.querySelector('.ib-droppreview')).toBeNull();
    release(400, 892);
    expect(calls).toEqual([]);
  });

  test("a pane's header nudged within its own pane moves nothing, the rim strip over its header included; carried out to another pane's top rim, it moves to the whole top", async () => {
    putThread(queries, B, heldOf(B, false));
    const calls: string[] = [];
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    const head = paneOf(B).querySelector<HTMLElement>('.ib-phead')!;
    const press = (x: number, y: number) => act(() => void head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' })));
    // Pressed 4 px below the area's top (inside the 24 px rim strip and B's own box), moved 6 px, let go.
    press(1200, 4);
    drag(1203, 5);
    drag(1206, 5);
    expect(document.querySelector('.ib-dragghost')).not.toBeNull();
    expect(document.querySelector('.ib-dragghost')!.textContent).not.toContain('full width');
    expect(document.querySelector('.ib-droppreview')).toBeNull();
    release(1206, 5);
    expect(calls.filter((call) => call.startsWith('move'))).toEqual([]);
    // The same press carried over pane A's top rim: the whole top.
    press(1200, 4);
    drag(400, 6);
    expect(document.querySelector('.ib-dragghost')?.textContent).toContain('Move above, full width');
    release(400, 6);
    expect(calls.filter((call) => call.startsWith('move'))).toEqual(['move:p1:*:top']);
  });

  test('a press on a row that does not move is a click; Escape mid-drag puts it back', async () => {
    const calls: string[] = [];
    let clicks = 0;
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    setThreadDragHitTestForTests(() => paneOf(A));
    const row = pressRow();
    row.addEventListener('click', () => clicks++);
    drag(102, 901);
    release(102, 901);
    act(() => row.click());
    expect(clicks).toBe(1);
    pressRow();
    drag(40, 450);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    release(40, 450);
    expect(calls).toEqual([]);
    expect(document.querySelector('.ib-droppreview')).toBeNull();
  });

  test('a press on a pane header while a thread is carried starts nothing of its own', async () => {
    putThread(queries, B, heldOf(B, false));
    const calls: string[] = [];
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    setThreadDragHitTestForTests(() => paneOf(A));
    pressRow();
    drag(40, 450);
    const head = paneOf(B).querySelector<HTMLElement>('.ib-phead')!;
    act(() => void head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 1200, clientY: 20, pointerId: 2, pointerType: 'mouse' })));
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1100, clientY: 400, pointerId: 2, buttons: 1, bubbles: true })));
    expect(document.querySelector('.ib-dragghost')).toBeNull();
    release(40, 450);
    expect(calls.filter((call) => call.startsWith('move'))).toEqual([]);
  });

  test('a thread archived while beside others closes its pane; one opened archived stays, unless a kept layout brings it back', async () => {
    putThread(queries, B, heldOf(B, false));
    changeThread(queries, B, (held) => ({ ...held, thread: { ...held.thread, resolved_at: null } }));
    const calls: string[] = [];
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop));
    await wait(0);
    expect(calls).toEqual([]);
    // Archived (by the person or an agent) while on screen beside A.
    act(() => changeThread(queries, B, (held) => ({ ...held, thread: { ...held.thread, resolved_at: '2026-11-10T10:00:00.000Z' } })));
    // The window draws again for the record that archived it, as App does for every record.
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop));
    await wait(0);
    expect(calls).toContain(`gone:${B}`);
    act(() => root!.unmount());
    root = null;
    // Opened archived on purpose: it stays.
    const kept: string[] = [];
    drawPanes(windowOf(pair('main'), kept), hostFor(A, noop));
    await wait(0);
    expect(kept).toEqual([]);
    act(() => root!.unmount());
    root = null;
    // The same pane from the window's kept layout (a reload): archived since, it closes.
    const back: string[] = [];
    drawPanes({ ...windowOf(pair('main'), back), restored: new Set(['p1']) }, hostFor(A, noop));
    await wait(0);
    expect(back).toContain(`gone:${B}`);
  });

  test('R opens the reply box in the active pane only; what is typed there stays in its own thread when the other pane is active', async () => {
    putThread(queries, B, heldOf(B, false));
    drawPanes(windowOf(pair('main')), hostFor(A, noop));
    await wait(0);
    pressR();
    await wait(0);
    expect(box(A)).not.toBeNull();
    expect(box(B)).toBeNull();
    act(() => {
      const area = box(A)!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Only for A');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    drawPanes(windowOf(pair('p1')), hostFor(B, noop), heldOf(B, false));
    await wait(0);
    pressR();
    await wait(0);
    expect(box(B)?.value).toBe('');
    expect(box(A)?.value).toBe('Only for A');
  });

  test('a window too narrow for both shows the active pane alone, and both come back in place when it widens', async () => {
    putThread(queries, A, heldOf(A, false));
    putThread(queries, B, heldOf(B, false));
    mainWidth = 780;
    drawPanes(windowOf(pair('p1')), hostFor(B, noop), heldOf(B, false));
    await wait(0);
    expect(paneOf(A)).toBeNull();
    expect(paneOf(B)).not.toBeNull();
    const bSection = paneOf(B);
    mainWidth = 1600;
    act(() => void window.dispatchEvent(new Event('resize')));
    await wait(0);
    expect(paneOf(A)).not.toBeNull();
    expect(paneOf(B)).toBe(bSection);
    expect(hostOf(A).hasAttribute('data-pane-quiet')).toBe(true);
  });

  test('a pane that steps aside because the window narrowed is said by its subject once the resize settles; drawn narrow from the start, widened, or narrowed and widened at once, nothing is', async () => {
    putThread(queries, A, heldOf(A, false));
    putThread(queries, B, heldOf(B, false));
    const toasts: { lead: string; detail?: string; onUndo?: unknown }[] = [];
    const host = { ...hostFor(B, noop), showToast: (toast: { lead: string; detail?: string; onUndo?: unknown }) => void toasts.push(toast) };
    const panesHostWithRows = (h: ThreadSlotHost) => ({ ...h, rowOf: (id: string) => ({ subject: `Subject ${id}` }) as unknown as InboxListRow });
    const drawWithRows = (layout = pair('p1')) =>
      act(() =>
        root!.render(
          <QueryClientProvider client={queries}>
            <div className="pn-inbox">
              <main className="ib-main">
                <ThreadPanes windowPanes={windowOf(layout)} held={heldOf(B, false)} host={panesHostWithRows(host)} />
              </main>
            </div>
          </QueryClientProvider>,
        ),
      );
    // Drawn in a narrow window: A is aside from the start, which the person never saw go: nothing said.
    mainWidth = 780;
    drawPanes(windowOf(pair('p1')), host, heldOf(B, false));
    drawWithRows();
    await wait(0);
    expect(paneOf(A)).toBeNull();
    expect(toasts).toEqual([]);
    // Widened: A comes back, nothing said. Narrowed again: A steps aside, and the toast names it, with nothing to undo.
    mainWidth = 1600;
    act(() => void window.dispatchEvent(new Event('resize')));
    await wait(0);
    expect(paneOf(A)).not.toBeNull();
    expect(toasts).toEqual([]);
    expect(el!.querySelector('.ib-layout > .pierre-layout-sr')?.textContent).toBe('2 panes');
    // Narrowed and widened again at once (a window edge dragged back): A stepped aside for a moment; nothing said.
    mainWidth = 780;
    act(() => void window.dispatchEvent(new Event('resize')));
    await wait(100);
    expect(paneOf(A)).toBeNull();
    mainWidth = 1600;
    act(() => void window.dispatchEvent(new Event('resize')));
    await wait(1000);
    expect(paneOf(A)).not.toBeNull();
    expect(toasts).toEqual([]);
    // Narrowed, and it stays narrow: once the resize settles the toast names A, with nothing to undo. The engine
    // reports the panes' new sizes as the window resizes: the same placement, so still the resize.
    mainWidth = 780;
    act(() => void window.dispatchEvent(new Event('resize')));
    const split = pair('p1');
    drawWithRows(L.resize(split, { [(split.root as { id: string }).id]: [3, 1] }));
    await wait(0);
    expect(paneOf(A)).toBeNull();
    expect(toasts).toEqual([]);
    await wait(500);
    expect(toasts.map((toast) => [toast.lead, toast.detail, toast.onUndo])).toEqual([['No room for more panes', `“Subject ${A}” stepped aside`, undefined]]);
    // The engine's own count of what shows, said right (FreeLayout.tsx): one pane, not "1 panes".
    expect(el!.querySelector('.ib-layout > .pierre-layout-sr')?.textContent).toBe('1 pane');
    // The same narrow room measured again (another resize event) says nothing more.
    act(() => void window.dispatchEvent(new Event('resize')));
    await wait(1000);
    expect(toasts).toHaveLength(1);
    mainWidth = 1600;
  });

  test('closing the pane shown alone in a narrow window (an Undo, a ✕) draws the one that stepped aside, without a throw', async () => {
    putThread(queries, A, heldOf(A, false));
    putThread(queries, B, heldOf(B, false));
    mainWidth = 780;
    drawPanes(windowOf(pair('p1')), hostFor(B, noop), heldOf(B, false));
    await wait(0);
    expect(paneOf(A)).toBeNull();
    // B's pane closes: A is alone and active, while the last measure still has it stepped aside.
    drawPanes(windowOf(L.close(pair('p1'), 'p1')), hostFor(A, noop));
    await wait(0);
    expect(paneOf(A)).not.toBeNull();
    expect(paneOf(B)).toBeNull();
  });

  test("the window's open thread (useActiveHeld): moving into a pane already on screen keeps its copy; opening one not on screen waits", async () => {
    const C = 'msg_C1';
    for (const id of [A, B, C]) {
      putThread(queries, id, heldOf(id, false));
      act(() => staleThread(queries, id));
    }
    const got: (string | null)[] = [];
    function Probe({ panes, split }: { panes: PaneSet; split: boolean }) {
      got.push(useActiveHeld(panes, split)?.thread.thread_id ?? null);
      return null;
    }
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const render = (panes: PaneSet, split = true) =>
      act(() =>
        root!.render(
          <QueryClientProvider client={queries}>
            <Probe panes={panes} split={split} />
          </QueryClientProvider>,
        ),
      );
    const pair = (active: string): PaneSet => ({ panes: [{ id: 'main', thread: A }, { id: 'beside-1', thread: B }], active });
    // The window opening on a thread: it was on screen nowhere, so its stale copy waits.
    render(pair('main'));
    expect(got.at(-1)).toBeNull();
    render(pair('beside-1'));
    expect(got.at(-1)).toBe(B);
    // The pane beside closes: A was on screen.
    render({ panes: [{ id: 'main', thread: A }], active: 'main' });
    expect(got.at(-1)).toBe(A);
    // One pane opening another thread: its stale copy waits for the read, as before.
    render({ panes: [{ id: 'main', thread: C }], active: 'main' });
    expect(got.at(-1)).toBeNull();
    // Without the switch, main's: every opening waits, even of a thread the last draw had.
    render(pair('main'), false);
    render(pair('beside-1'), false);
    expect(got.at(-1)).toBeNull();
  });
});

// ── A pane through every change of layout (paneKeeper.tsx) ──
// The person's work in a pane: an open reply box with words in it, an answer picked, a message unfolded, the place
// they scrolled to and a recording in progress. None of it may go when the layout changes and comes back.

const K = 'msg_K1';
const ASK = ['Where should the retry live?', '', ':::question', 'Where should the retry live?', '', '- [ ] Pin it', '- [ ] Loosen it', ':::'].join('\n');
/** A thread with a question, two read messages before it and one new: the read ones fold. */
function keptThread(): InboxThread {
  const questions = parseInboxQuestionBlocks(ASK).map((q) => ({
    key: q.key, position: q.position, kind: q.kind, prompt: q.prompt, context: q.parsed.context, choices: q.parsed.choices,
    recommendation: null, suggested_text: null, stopped: q.stopped, holds_up: q.holds_up, asked_by_agent_id: 'ses_a', orphaned: false, state: 'open', answer: null,
    revision: 3, sent_revision: 0, picked_by: null, picked_at: null, sent_reply_id: null, message_id: `${K}_4`, superseded_by: null,
  }));
  return {
    thread_id: K,
    project: PROJECT,
    subject: `Subject ${K}`,
    thread_name: null,
    resolved_at: null,
    messages: [
      message(K, K, 1, 'The worker retries on a 409.', { person_seen_seq: 3 }),
      message(K, `${K}_2`, 2, 'The budget is five tries.'),
      message(K, `${K}_3`, 3, 'Each try waits longer.'),
      message(K, `${K}_4`, 4, ASK, { questions } as unknown as Partial<InboxMessageWire>),
    ],
  };
}
const heldK = () => ({ serverSession: 's', cursor: 0, thread: keptThread() });
const lookAt = (host: ThreadSlotHost, threadId: string, seq: number): ThreadSlotHost => ({
  ...host,
  paneReads: { view: () => ({ ...NO_OPEN, look: { threadId, seq, through: seq } }), retry: noop, park } as unknown as PaneReads,
});

/** Each change of layout: what it changes in the window, from two panes beside each other. */
const REFLOWS: [string, (host: ThreadSlotHost) => ThreadSlotHost, boolean][] = [
  ['a window too narrow for both', (host) => host, true],
  ['a file open beside the active pane', (host) => ({ ...host, fileOpen: true }), false],
  ['a stacked window', (host) => ({ ...host, stack: { thread: true, file: false } }), false],
  ['a phone', (host) => ({ ...host, phone: true }), false],
  ["a card's thread", (host) => ({ ...host, fromCard: 'crd_1' }), false],
  ["Reviews' thread", (host) => ({ ...host, route: { ...host.route, reviews: { project: null, view: 'all' } } as Route }), false],
  ['a file full screen', (host) => ({ ...host, route: { ...host.route, full: true } as Route }), false],
];

describe.skipIf(!hasDom)("a pane keeps the person's work through every change of layout", () => {
  // Scroll offsets as a browser keeps them: a box put in another place on the page (or taken off it) has forgotten
  // its own, and no scroll event says so; only the person's scrolls (set, then a scroll event) are heard.
  const tops = new WeakMap<Element, { top: number; place: Element | null }>();
  const placeOf = (el: Element) => el.closest('.ib-panehost');
  const mic: string[] = [];
  let tick: (() => void) | null = null;
  let clock = 1000;

  beforeEach(async () => {
    if (!hasDom) return;
    mic.length = 0;
    tick = null;
    stub(HTMLElement.prototype, 'scrollTop', {
      get(this: HTMLElement) {
        const kept = tops.get(this);
        return kept && kept.place === placeOf(this) ? kept.top : 0;
      },
      set(this: HTMLElement, top: number) {
        tops.set(this, { top, place: placeOf(this) });
      },
    });
    // No microphone and no transcription service: the window's own seam (voice.ts `browserDeps`), as voiceKeptWords.test.tsx.
    const { adoptVoiceSettings, browserDeps } = await import('../voice');
    const had = { ...browserDeps };
    Object.assign(browserDeps, {
      open: async () => ({ rate: 24_000, db: () => -20, stop: async () => (mic.push('stopped'), [new Float32Array(2400).fill(0.2)]), abort: () => mic.push('aborted'), onEnded: noop }),
      prompts: async () => false,
      transcribe: () => (mic.push('transcribing'), new Promise(() => {})),
      now: () => clock,
      every: (_ms: number, run: () => void) => ((tick = run), () => (tick = null)),
      after: () => noop,
    });
    stub(window, 'isSecureContext', { value: true });
    stub(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({}) } });
    stub(globalThis, 'AudioWorkletNode', { value: class {} });
    adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false });
    restore.push(() => {
      Object.assign(browserDeps, had);
      adoptVoiceSettings(null);
    });
  });

  /** A on the left (pane `main`), K right of it (pane `p1`). */
  const withK = (active: 'main' | 'p1') => L.focus(L.openAt(L.follow(L.EMPTY_LAYOUT, A), K, 'main', 'right'), active);
  const hostIn = (active: 'main' | 'p1') => (active === 'p1' ? lookAt(hostFor(K, noop), K, 3) : hostFor(A, noop));
  const heldIn = (active: 'main' | 'p1') => (active === 'p1' ? heldK() : heldOf(A, false));
  const replyBox = () => paneOf(K)?.querySelector<HTMLTextAreaElement>('textarea:not([data-question-other])') ?? null;
  const option = (words: string) => [...paneOf(K).querySelectorAll<HTMLElement>('[data-question-option]')].find((row) => row.textContent?.includes(words))!.querySelector<HTMLInputElement>('input')!;
  const body = () => paneOf(K).querySelector<HTMLElement>('.ib-pbody')!;
  const live = () => paneOf(K)?.querySelector('[data-voice-mic]')?.getAttribute('data-state') ?? null;

  /** K's pane with the person's work in it, K the active pane. */
  async function work() {
    putThread(queries, A, heldOf(A, false));
    putThread(queries, K, heldK());
    drawPanes(windowOf(withK('p1')), hostIn('p1'), heldIn('p1'));
    await wait(0);
    pressR();
    await wait(0);
    act(() => {
      const area = replyBox()!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Words for K');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => option('Pin it').click());
    await wait(0);
    expect(option('Pin it').checked).toBe(true);
    const folded = paneOf(K).querySelector<HTMLElement>('[data-message-article][data-folded]');
    expect(folded).not.toBeNull();
    const unfolded = folded!.getAttribute('data-message-article')!;
    act(() => folded!.querySelector<HTMLElement>('[data-fold-head]')!.click());
    await wait(0);
    act(() => {
      body().scrollTop = 300;
      body().dispatchEvent(new Event('scroll'));
    });
    act(() => void paneOf(K).querySelector('[data-voice-mic]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 7 })));
    await wait(0);
    for (let i = 0; i < 12; i++) {
      clock += 40;
      act(() => tick?.());
    }
    expect(live()).toBe('live');
    return { section: paneOf(K), box: replyBox()!, pick: option('Pin it'), unfolded };
  }

  /**
   * Everything `work` left in K's pane is still there, in the same elements. `folds` false: the thread itself moved
   * between Reviews' view of it and the Inbox's, where Thread.tsx decides its folds again on purpose (one thread, today).
   */
  function kept(before: Awaited<ReturnType<typeof work>>, folds = true, stopped = false) {
    expect(paneOf(K)).toBe(before.section);
    expect(replyBox()).toBe(before.box);
    expect(before.box.value).toBe('Words for K');
    expect(option('Pin it')).toBe(before.pick);
    expect(before.pick.checked).toBe(true);
    if (folds) expect(paneOf(K).querySelector(`[data-message-article="${before.unfolded}"]`)?.hasAttribute('data-folded')).toBe(false);
    expect(body().scrollTop).toBe(300);
    // A pane parked off the page runs no mic unseen: its take stopped and went to be written down (useThreadVoice.ts).
    expect(live()).toBe(stopped ? 'sending' : 'live');
    expect(mic).toEqual(stopped ? ['stopped', 'transcribing'] : []);
  }

  for (const role of ['active', 'beside'] as const) {
    const active = role === 'active' ? 'p1' : 'main';
    for (const [name, change, narrow] of REFLOWS) {
      test(`${name}, and back, with the pane ${role === 'active' ? 'the active one' : 'beside the active one'}`, async () => {
        const before = await work();
        if (role === 'beside') {
          drawPanes(windowOf(withK('main')), hostIn('main'), heldIn('main'));
          await wait(0);
          kept(before);
        }
        if (narrow) mainWidth = 780;
        drawPanes(windowOf(withK(active)), change(hostIn(active)), heldIn(active));
        if (narrow) act(() => void window.dispatchEvent(new Event('resize')));
        await wait(0);
        // The active pane shows; the other waits off the page, still mounted. A recording in it stops, and what was said is kept.
        expect(paneOf(role === 'active' ? K : A)).not.toBeNull();
        expect(paneOf(role === 'active' ? A : K)).toBeNull();
        expect(parked).toEqual([role === 'active' ? 'main' : 'p1']);
        expect(mic).toEqual(role === 'active' ? [] : ['stopped', 'transcribing']);
        mainWidth = 1600;
        drawPanes(windowOf(withK(active)), hostIn(active), heldIn(active));
        if (narrow) act(() => void window.dispatchEvent(new Event('resize')));
        await wait(0);
        expect(paneOf(A)).not.toBeNull();
        expect(parked).toEqual([]);
        kept(before, !(role === 'active' && name.startsWith('Reviews')), role === 'beside');
      });
    }
  }

  test('one pane, then another beside it, then one again', async () => {
    const before = await work();
    // K alone: A's pane closed.
    const alone = L.close(withK('p1'), 'main');
    drawPanes(windowOf(alone), hostIn('p1'), heldIn('p1'));
    await wait(0);
    expect(paneOf(A)).toBeNull();
    kept(before);
    // A opened beside it again, then closed again.
    drawPanes(windowOf(L.focus(L.openAt(alone, A, 'p1', 'left'), 'p1')), hostIn('p1'), heldIn('p1'));
    await wait(0);
    expect(paneOf(A)).not.toBeNull();
    kept(before);
    drawPanes(windowOf(alone), hostIn('p1'), heldIn('p1'));
    await wait(0);
    kept(before);
  });

  test('a thread deleted under a recording keeps its pane until the recording ends', async () => {
    const calls: string[] = [];
    await work();
    drawPanes(windowOf(withK('main'), calls), hostIn('main'), heldIn('main'));
    await wait(0);
    // Its read says it is gone (a 404): the pane would close, but the person is still speaking into it.
    const gone = hostIn('main');
    const deleted = { ...gone, paneReads: { ...gone.paneReads, view: (pane: string) => (pane === 'p1' ? { ...NO_OPEN, load: { threadId: K, state: 'missing', error: 'Not found', waiting: null } } : gone.paneReads.view(pane)) } as unknown as PaneReads };
    drawPanes(windowOf(withK('main'), calls), deleted, heldIn('main'));
    await wait(2000);
    expect(live()).toBe('live');
    expect(calls).not.toContain(`gone:${K}`);
    // The person lets go of the mic: the take goes to be written down, and the pane closes.
    act(() => void paneOf(K).querySelector('[data-voice-mic]')!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7 })));
    await wait(1000);
    expect(mic[0]).toBe('stopped');
    expect(calls).toContain(`gone:${K}`);
  });
});
