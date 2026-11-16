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
 * pane; a pane mounting again when another opens or the active one changes; an archived thread's pane staying; text
 * typed in one pane's reply box showing in another's; a narrow window losing the panes it cannot show.
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
import { singlePane, type PaneSet } from './model';
import * as L from './layoutModel';
import { LAYER, registerDropTarget } from '../drag/threadDrag';
import { changeThread, putThread, staleThread } from '../data/queries/thread';
import type { HeldThread } from '../data/apply/record';

const hasDom = typeof document !== 'undefined';
// The thread pane pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadSlot } = (hasDom ? await import('../thread/ThreadSlot') : {}) as typeof import('../thread/ThreadSlot');
const { ThreadPanes } = (hasDom ? await import('./ThreadPanes') : {}) as typeof import('./ThreadPanes');

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
      if (this.classList.contains('ib-main') || this.classList.contains('pn-inbox')) return { ...rect(0, 900), right: mainWidth, width: mainWidth };
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
              <div className="ib-lbody">
                <button type="button" className="ib-row" data-thread-id="msg_C1">
                  <span className="ib-subj">Subject C</span>
                </button>
              </div>
            )}
            <ThreadPanes windowPanes={windowPanes} held={held} host={panesHost(host)} />
          </main>
        </div>
      </QueryClientProvider>,
    ),
  );
}
const hostOf = (thread: string) => paneOf(thread).closest<HTMLElement>('[data-layout-pane]')!;
const drag = (x: number, y: number) => act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, bubbles: true })));
const release = (x: number, y: number) => act(() => void window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 1, bubbles: true })));
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
    const row = el!.querySelector<HTMLElement>('.ib-lbody [data-thread-id="msg_C1"]')!;
    const carry = (x: number, y: number) => {
      act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 900, pointerId: 1, pointerType: 'mouse' })));
      drag(x, y);
      release(x, y);
    };
    carry(40, 450);
    carry(400, 450);
    expect(calls).toEqual(['open:msg_C1:main:left', 'replace:main:msg_C1']);
    // The reply box's own target (a mention, another branch) sits above the panes: the pane's zone leaves it the drop.
    const mentions: string[] = [];
    const foot = paneOf(A).querySelector<HTMLElement>('.ib-pfoot')!;
    stub(document, 'elementFromPoint', { value: () => foot });
    const off = registerDropTarget({ id: 'reply-test', layer: LAYER.reply, accepts: (p) => p.kind === 'thread', hit: (x, y) => (document.elementFromPoint(x, y)?.closest('.ib-pfoot') ? { action: 'Mention' } : null), drop: (_hit, p) => void mentions.push(p.kind === 'thread' ? p.threadId : '') });
    try {
      carry(400, 850);
    } finally {
      off();
    }
    expect(mentions).toEqual(['msg_C1']);
    expect(calls).toEqual(['open:msg_C1:main:left', 'replace:main:msg_C1']);
    // Without such a target, a drop over the reply box does nothing.
    carry(400, 850);
    expect(calls).toHaveLength(2);
  });

  test("with one thread open, a row dropped on its pane's edge opens beside it", async () => {
    const calls: string[] = [];
    drawPanes(windowOf(L.follow(L.EMPTY_LAYOUT, A), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    const row = el!.querySelector<HTMLElement>('.ib-lbody [data-thread-id="msg_C1"]')!;
    act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 900, pointerId: 1, pointerType: 'mouse' })));
    // At the window's corner the pill flips to the pointer's left and above it, so it stays whole on screen.
    drag(window.innerWidth - 2, window.innerHeight - 2);
    const at = /translate\((-?\d+)px, (-?\d+)px\)/.exec(document.querySelector<HTMLElement>('.ib-dragghost')!.style.transform)!;
    expect(Number(at[1])).toBeLessThan(window.innerWidth - 2);
    expect(Number(at[2])).toBeLessThan(window.innerHeight - 2);
    drag(760, 450);
    release(760, 450);
    expect(calls).toEqual(['open:msg_C1:main:right']);
  });

  test('a press on a row that does not move is a click; Escape mid-drag puts it back', async () => {
    const calls: string[] = [];
    let clicks = 0;
    drawPanes(windowOf(pair('main'), calls), hostFor(A, noop), heldOf(A, false), true);
    await wait(0);
    calls.length = 0;
    const row = el!.querySelector<HTMLElement>('.ib-lbody [data-thread-id="msg_C1"]')!;
    row.addEventListener('click', () => clicks++);
    act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 900, pointerId: 1, pointerType: 'mouse' })));
    drag(102, 901);
    release(102, 901);
    act(() => row.click());
    expect(clicks).toBe(1);
    act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 900, pointerId: 1, pointerType: 'mouse' })));
    drag(40, 450);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    release(40, 450);
    expect(calls).toEqual([]);
    expect(document.querySelector('.ib-dragghost')).toBeNull();
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
    putThread(queries, B, heldOf(B, false));
    mainWidth = 860;
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
