/**
 * Seen on sight, as the thread pane does it (design record
 * "inbox-new-in-open-thread", variant A, approved 2026-10-12; not in this
 * repo): an agent message that arrives while the thread is open counts as
 * seen once its first lines have been on screen for a second, with the tab
 * visible, the window focused and nothing over the thread. happy-dom has no
 * layout and no IntersectionObserver, so the test gives the elements their
 * boxes and drives a stand-in observer. Time is the test's: the dwell, the
 * recheck and every other timer run on fake timers that `wait` advances, so
 * the result never depends on how fast the runner is. The real browser proof is
 * tests/e2e/inbox-seen-on-sight.spec.ts; the rules alone are checked at the
 * bottom without a DOM.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import {
  FIRST_LINES_PX,
  FIRST_LINE_PX,
  RECHECK_MS,
  SEEN_DWELL_MS,
  firstLines,
  firstLinesInView,
  followBy,
  latestAgentSeq,
  lookThrough,
  measureFirstLines,
  requiredLines,
  samplePoints,
  unseenArrivals,
} from './seenOnSight';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-12T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const PERSON: InboxAuthor = { kind: 'person' };
const ROOT = 'msg_A1';

function message(id: string, author: InboxAuthor, seq: number, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author,
    subject: id === ROOT ? 'Refund events' : null,
    body,
    created_at: `2026-10-12T17:${String(30 + seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...(author.kind === 'person' ? { sent_annotations: 0 } : {}),
    ...extra,
  };
}

/** The thread as it was when the person opened it: the agent's message, their reply. The look covered seq 2. */
const OPENED: InboxMessageWire[] = [
  message(ROOT, AGENT, 2, 'The refund webhook is wired.', { person_seen_seq: 2 }),
  message('msg_P1', PERSON, 4, 'Good. Retries?'),
];
const threadOf = (opened: readonly InboxMessageWire[], ...arrivals: InboxMessageWire[]): InboxThread => ({
  thread_id: ROOT,
  project: PROJECT,
  subject: 'Refund events',
  thread_name: null,
  resolved_at: null,
  messages: [...opened, ...arrivals],
});
const thread = (...arrivals: InboxMessageWire[]): InboxThread => threadOf(OPENED, ...arrivals);
const A2 = message('msg_A2', AGENT, 6, 'Retries are on, three attempts.');
const A3 = message('msg_A3', AGENT, 8, 'And the dashboard shows them.');

// ── the stand-ins: boxes, the observer, the window in front ──

/** Each message's box in the view (the body is 0..800). Absent: far below. */
let boxes: Record<string, { top: number; height: number }> = {};
/** Things drawn over the thread (a sheet, a popover, the toast): the vertical span each covers. */
let covers: { top: number; bottom: number }[] = [];
const coverElement = typeof document !== 'undefined' ? document.createElement('div') : null;
const observers: { fire: () => void; observed: Element[] }[] = [];
let visibility: DocumentVisibilityState = 'visible';
let focused = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const restore: (() => void)[] = [];

function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => (saved ? Object.defineProperty(target, key, saved) : delete (target as Record<string, unknown>)[key]));
}

const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} });

/** One turn of the event loop that the fake timers leave alone (they fake `setTimeout`, not `setImmediate`): fetch replies and effects settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  if (!hasDom) return;
  jest.useFakeTimers();
  boxes = {};
  covers = [];
  visibility = 'visible';
  focused = true;
  observers.length = 0;
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
      // The sender row: the top 30 px of its message.
      if (this.classList.contains('ib-fline')) return rect(box.top, 30);
      return this === article ? rect(box.top, box.height) : rect(box.top, 0);
    },
  });
  // What is drawn on top at a point: a cover over it, else the message whose box holds it, else the thread's body.
  stub(document, 'elementFromPoint', {
    value: (_x: number, y: number) => {
      if (covers.some((c) => y >= c.top && y < c.bottom)) return coverElement;
      for (const article of document.querySelectorAll<HTMLElement>('[data-message-article]')) {
        const box = boxes[article.getAttribute('data-message-article')!];
        if (box && y >= box.top && y < box.top + box.height) return article.querySelector('.ib-fline') ?? article;
      }
      return document.querySelector('.ib-pbody');
    },
  });
  stub(document, 'visibilityState', { get: () => visibility });
  stub(document, 'hasFocus', { value: () => focused });
  stub(globalThis, 'IntersectionObserver', {
    writable: true,
    value: class {
      observed: Element[] = [];
      live = true;
      constructor(callback: () => void) {
        observers.push({ fire: () => this.live && callback(), observed: this.observed });
      }
      observe(element: Element) {
        this.observed.push(element);
      }
      disconnect() {
        this.live = false;
        this.observed.length = 0;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  });
});

afterEach(() => {
  if (!hasDom) return;
  // Real timers come back even when the unmount or a restore throws, so fake
  // timers never leak into the next file.
  try {
    act(() => root?.unmount());
    host?.remove();
  } finally {
    root = null;
    host = null;
    globalThis.fetch = savedFetch;
    try {
      for (const undo of restore.splice(0).reverse()) undo();
    } finally {
      jest.useRealTimers();
    }
  }
});

/**
 * Let `ms` of the test's time pass: every timer due in it fires, in order, then the page settles.
 * Never await a real timer here (or anywhere in these tests): the fake timers
 * never fire it, and bun's per-test timeout cannot fire under fake timers
 * either, so the test would hang until the job's timeout-minutes.
 */
async function wait(ms: number) {
  await act(async () => {
    await settle();
    jest.advanceTimersByTime(ms);
    await settle();
  });
}

interface PaneProps {
  thread: InboxThread;
  onSeen: (through: number) => void;
  file?: { id: string; version: 'current' | 'sent'; focus: string | null } | null;
  phone?: boolean;
  covered?: boolean;
  /** The thread as the person opened it (default OPENED), and the look before and at the open. */
  base?: InboxMessageWire[];
  lookSeq?: number;
  seenThrough?: number;
}

function pane({ thread, onSeen, file = null, phone = false, covered = false, lookSeq = 2, seenThrough = 2 }: PaneProps) {
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={file}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        lookSeq={lookSeq}
        seenThrough={seenThrough}
        onSeen={onSeen}
        phone={phone}
        covered={covered}
      />
    </div>
  );
}

/** Open the thread as it was, then let `arrivals` land in it (the event stream's re-read). */
async function openThenArrive(props: Omit<PaneProps, 'thread'>, ...arrivals: InboxMessageWire[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane({ ...props, thread: threadOf(props.base ?? OPENED) }));
  });
  await wait(0);
  act(() => root!.render(pane({ ...props, thread: threadOf(props.base ?? OPENED, ...arrivals) })));
  await wait(0);
  return host;
}

const rerender = (props: PaneProps) => act(() => root!.render(pane(props)));
const fireObservers = () => act(() => observers.forEach((o) => o.fire()));

describe.skipIf(!hasDom)('seen on sight in the thread pane', () => {
  test('an arrival whose first lines stay on screen for a second is seen; the look goes up to it; a screen reader hears it', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    await wait(60);
    expect(el.querySelector('[data-fold-live]')!.textContent).toBe('New message from Claude Code');
    expect(el.querySelector('[data-message-article="msg_A2"]')!.hasAttribute('data-arrived')).toBe(true);
    await wait(SEEN_DWELL_MS / 2);
    expect(seen).toEqual([]);
    await wait(SEEN_DWELL_MS / 2 + 150);
    expect(seen).toEqual([6]);
    expect(el.querySelector('[data-message-article="msg_A2"]')!.hasAttribute('data-sighted')).toBe(true);
  });

  test('a question that arrives is announced as one', async () => {
    const ask = message('msg_A2', AGENT, 6, ':::question\nRetry on 409?\n\n- [ ] Yes\n- [ ] No\n:::', {
      questions: [{ key: 'q-1', state: 'open' } as never],
    });
    boxes = { msg_A2: { top: 400, height: 200 } };
    const el = await openThenArrive({ onSeen: () => {} }, ask);
    await wait(60);
    expect(el.querySelector('[data-fold-live]')!.textContent).toBe('New message from Claude Code, with a question');
  });

  test('a hidden tab sees nothing; the dwell starts when the tab is visible again', async () => {
    visibility = 'hidden';
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([6]);
  });

  test('a window without focus sees nothing; the dwell starts when it comes to the front', async () => {
    focused = false;
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    focused = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([6]);
  });

  test('leaving the window mid-dwell restarts it: half a second, a blur, half a second is not seen', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    await wait(SEEN_DWELL_MS / 2);
    focused = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    focused = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    await wait(SEEN_DWELL_MS / 2 + 150);
    expect(seen).toEqual([]);
    await wait(SEEN_DWELL_MS / 2);
    expect(seen).toEqual([6]);
  });

  test('a file over the thread (a phone) covers it: nothing is seen until the file closes', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    const file = { id: 'att_1', version: 'current' as const, focus: null };
    await openThenArrive({ onSeen: (through) => seen.push(through), file, phone: true }, A2);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    rerender({ thread: thread(A2), onSeen: (through) => seen.push(through), file: null, phone: true });
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([6]);
  });

  test('a cover from the window (a dialog, a guided review) holds it the same way', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through), covered: true }, A2);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    rerender({ thread: thread(A2), onSeen: (through) => seen.push(through), covered: false });
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([6]);
  });

  test('scrolled up: the arrival below is not seen; the pill counts it alone and goes to it; seen once scrolled to', async () => {
    boxes = { msg_A1: { top: 0, height: 300 }, msg_P1: { top: 300, height: 200 }, msg_A2: { top: 2000, height: 200 } };
    const seen: number[] = [];
    const scrolled: string[] = [];
    stub(HTMLElement.prototype, 'scrollIntoView', {
      value(this: HTMLElement) {
        scrolled.push(this.getAttribute('data-message-article') ?? (this.hasAttribute('data-new-divider') ? 'divider' : this.className));
      },
    });
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    // The root was new when the thread opened (it carries the New tag) but it is in view: only the arrival counts.
    expect(el.querySelector('[data-message-article="msg_A1"]')!.hasAttribute('data-new')).toBe(false);
    expect(pill.textContent).toBe('1 new');
    expect(pill.hasAttribute('data-off')).toBe(false);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    act(() => pill.click());
    // The first new message below: the arrival, here also the first new one, so it lands at its divider.
    expect(scrolled.at(-1)).toBe('divider');
    expect(document.activeElement).toBe(el.querySelector('[data-message-article="msg_A2"] [data-fold-head]'));
    // The person reaches it: the scroll brings its first lines into view.
    boxes.msg_A2 = { top: 500, height: 200 };
    act(() => void el.querySelector('.ib-pbody')!.dispatchEvent(new Event('scroll')));
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([6]);
    // Seen: it leaves the pill's count even when scrolled away again.
    boxes.msg_A2 = { top: 2000, height: 200 };
    act(() => void el.querySelector('.ib-pbody')!.dispatchEvent(new Event('scroll')));
    expect(pill.hasAttribute('data-off')).toBe(true);
  });

  // The failure this guards: a phone's New message sheet (or
  // the annotations list, the Mark read toast) drawn over the end of the thread
  // hid the arrival, and it was still marked seen.
  test('something drawn over the first lines (a sheet) hides them: nothing is seen until it goes, and a cover mid-dwell restarts it', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    covers = [{ top: 300, bottom: 800 }];
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    // Only the lower half of the first lines under the toast: still hidden.
    covers = [{ top: 450, bottom: 800 }];
    await wait(SEEN_DWELL_MS + RECHECK_MS);
    expect(seen).toEqual([]);
    // The sheet goes (no event: the recheck notices); a cover for a moment mid-dwell restarts it.
    covers = [];
    await wait(RECHECK_MS + 350);
    covers = [{ top: 300, bottom: 800 }];
    await wait(RECHECK_MS + 100);
    covers = [];
    await wait(500);
    expect(seen).toEqual([]);
    await wait(SEEN_DWELL_MS);
    expect(seen).toEqual([6]);
  });

  // The failure this guards: the pill counted every message new at the open
  // as well as the arrival, and went to the first new message below the view,
  // an older one, so reaching the arrival took several clicks.
  test('the pill counts and goes to the unseen arrivals first; only when none waits below, to what was new at the open', async () => {
    const R = message(ROOT, AGENT, 2, 'The refund webhook is wired.');
    const B1 = message('msg_B1', AGENT, 3, 'Retries next.');
    const B2 = message('msg_B2', AGENT, 5, 'Retries are on.');
    const B3 = message('msg_B3', AGENT, 7, 'And the dashboard.');
    const C = message('msg_C', AGENT, 9, 'One more thing.');
    boxes = { [ROOT]: { top: 0, height: 300 }, msg_B1: { top: 1000, height: 200 }, msg_B2: { top: 1300, height: 200 }, msg_B3: { top: 1600, height: 200 }, msg_C: { top: 2000, height: 200 } };
    const scrolled: string[] = [];
    stub(HTMLElement.prototype, 'scrollIntoView', {
      value(this: HTMLElement) {
        scrolled.push(this.getAttribute('data-message-article') ?? (this.hasAttribute('data-new-divider') ? 'divider' : this.className));
      },
    });
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through), base: [R, B1, B2, B3], lookSeq: 2, seenThrough: 7 }, C);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    // Three messages were new at the open and are below too; the pill counts the arrival alone.
    expect(['msg_B1', 'msg_B2', 'msg_B3', 'msg_C'].every((id) => el.querySelector(`[data-message-article="${id}"]`)!.hasAttribute('data-new'))).toBe(true);
    expect(pill.textContent).toBe('1 new');
    // One click lands on the arrival, not the first new message.
    act(() => pill.click());
    expect(scrolled).toEqual(['msg_C']);
    expect(document.activeElement).toBe(el.querySelector('[data-message-article="msg_C"] [data-fold-head]'));
    // Seen there; scrolled back up, the pill falls back to what was new at the open, and goes to its divider.
    boxes.msg_C = { top: 400, height: 200 };
    act(() => void el.querySelector('.ib-pbody')!.dispatchEvent(new Event('scroll')));
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([9]);
    boxes.msg_C = { top: 2000, height: 200 };
    act(() => void el.querySelector('.ib-pbody')!.dispatchEvent(new Event('scroll')));
    expect(pill.textContent).toBe('3 new');
    act(() => pill.click());
    expect(scrolled.at(-1)).toBe('divider');
  });

  test('first lines under the pill do not count', async () => {
    // A3 sits below the view (the pill shows), A2's first lines in the pill's band at the bottom.
    boxes = { msg_A2: { top: 760, height: 400 }, msg_A3: { top: 2000, height: 200 } };
    const seen: number[] = [];
    await openThenArrive({ onSeen: (through) => seen.push(through) }, A2, A3);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
  });

  test('the look never passes an arrival the person was not shown: the later one seen alone records nothing', async () => {
    // Scrolled past A2 (its first lines above the view), A3 on screen.
    boxes = { msg_A2: { top: -400, height: 300 }, msg_A3: { top: 200, height: 200 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2, A3);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    expect(el.querySelector('[data-message-article="msg_A3"]')!.hasAttribute('data-sighted')).toBe(true);
    // Back up to A2: now both are seen, and the look goes up to A3.
    boxes = { msg_A2: { top: 100, height: 300 }, msg_A3: { top: 600, height: 200 } };
    fireObservers();
    await wait(SEEN_DWELL_MS + 150);
    expect(seen).toEqual([8]);
  });

  test('a message the person folds is not on screen and is not seen', async () => {
    boxes = { msg_A2: { top: 400, height: 200 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    act(() => el.querySelector<HTMLButtonElement>('[data-message-article="msg_A2"] [data-fold-head]')!.click());
    expect(el.querySelector('[data-message-article="msg_A2"]')!.hasAttribute('data-folded')).toBe(true);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
  });

  test('at the end of the thread an arrival scrolls just far enough to show its first lines; scrolled up, nothing moves', async () => {
    const scrolls: number[] = [];
    stub(HTMLElement.prototype, 'scrollBy', {
      value(this: HTMLElement, options: ScrollToOptions) {
        scrolls.push(options.top ?? 0);
      },
    });
    let end = true;
    stub(HTMLElement.prototype, 'scrollHeight', { get: () => 1200 });
    stub(HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    stub(HTMLElement.prototype, 'scrollTop', { get: () => (end ? 400 : 0), set: () => {} });
    boxes = { msg_A2: { top: 760, height: 300 } };
    await openThenArrive({ onSeen: () => {} }, A2);
    // Its first lines end at 760 + 30 + 96 = 886; the view ends at 800, with 12 px of room.
    expect(scrolls).toEqual([886 - (800 - 12)]);
    act(() => root!.unmount());
    root = null;
    end = false;
    scrolls.length = 0;
    await openThenArrive({ onSeen: () => {} }, A2);
    expect(scrolls).toEqual([]);
  });

  // The failures these guard (the owner, 2026-10-16: "Why does this whole
  // 'one new' thing keep showing, even though I've seen the whole message?
  // Shows when I scroll up."): the pill counted every message below the view
  // that was new at the open or not yet seen on sight, so a message the person
  // had read came back into its count as soon as they scrolled up past it.
  test('an arrival read with the window in the background (no dwell) leaves the pill for good: scrolling up never brings it back', async () => {
    focused = false;
    boxes = { msg_A1: { top: 0, height: 300 }, msg_P1: { top: 300, height: 200 }, msg_A2: { top: 2000, height: 200 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    const body = el.querySelector('.ib-pbody')!;
    expect(pill.hasAttribute('data-off')).toBe(false);
    // The person scrolls down and reads it while typing in another window: not seen on sight (no focus)...
    boxes = { msg_A1: { top: -1700, height: 300 }, msg_P1: { top: -1400, height: 200 }, msg_A2: { top: 300, height: 200 } };
    act(() => void body.dispatchEvent(new Event('scroll')));
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([]);
    expect(pill.hasAttribute('data-off')).toBe(true);
    // ...but it was on screen: back up at the top, the pill stays away.
    boxes = { msg_A1: { top: 0, height: 300 }, msg_P1: { top: 300, height: 200 }, msg_A2: { top: 2000, height: 200 } };
    act(() => void body.dispatchEvent(new Event('scroll')));
    expect(pill.hasAttribute('data-off')).toBe(true);
  });

  test('messages new at the open: the pill counts only those not yet on screen, and one read never comes back on scroll up', async () => {
    const R = message(ROOT, AGENT, 2, 'The refund webhook is wired.');
    const B1 = message('msg_B1', AGENT, 3, 'Retries next.');
    const B2 = message('msg_B2', AGENT, 5, 'Retries are on.');
    // B1 on screen at the open, B2 below it.
    boxes = { [ROOT]: { top: 0, height: 300 }, msg_B1: { top: 400, height: 200 }, msg_B2: { top: 1200, height: 200 } };
    const el = await openThenArrive({ onSeen: () => {}, base: [R, B1, B2], lookSeq: 2, seenThrough: 5 });
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    const body = el.querySelector('.ib-pbody')!;
    expect(pill.textContent).toBe('1 new');
    // Scrolled down to B2, then back to the top: both have been on screen.
    boxes = { [ROOT]: { top: -800, height: 300 }, msg_B1: { top: -400, height: 200 }, msg_B2: { top: 400, height: 200 } };
    act(() => void body.dispatchEvent(new Event('scroll')));
    expect(pill.hasAttribute('data-off')).toBe(true);
    boxes = { [ROOT]: { top: 0, height: 300 }, msg_B1: { top: 900, height: 200 }, msg_B2: { top: 1200, height: 200 } };
    act(() => void body.dispatchEvent(new Event('scroll')));
    expect(pill.hasAttribute('data-off')).toBe(true);
  });

  test('scrolled to the end, nothing is below: a short arrival whose top sits in the pill band shows no pill, and is seen', async () => {
    stub(HTMLElement.prototype, 'scrollHeight', { get: () => 1200 });
    stub(HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    stub(HTMLElement.prototype, 'scrollTop', { get: () => 400, set: () => {} });
    stub(HTMLElement.prototype, 'scrollBy', { value: () => {} });
    // The last message, fully visible above the foot, its top inside the pill's 56 px band.
    boxes = { msg_A2: { top: 752, height: 40 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    expect(pill.hasAttribute('data-off')).toBe(true);
    await wait(SEEN_DWELL_MS + 200);
    expect(seen).toEqual([6]);
  });

  test('a short arrival at the end that lands while the tab is hidden: on return, with no scroll, the pill goes and it is seen', async () => {
    stub(HTMLElement.prototype, 'scrollHeight', { get: () => 1200 });
    stub(HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    stub(HTMLElement.prototype, 'scrollTop', { get: () => 400, set: () => {} });
    stub(HTMLElement.prototype, 'scrollBy', { value: () => {} });
    visibility = 'hidden';
    boxes = { msg_A2: { top: 752, height: 40 } };
    const seen: number[] = [];
    const el = await openThenArrive({ onSeen: (through) => seen.push(through) }, A2);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await wait(SEEN_DWELL_MS + 400);
    expect({ off: pill.hasAttribute('data-off'), seen }).toEqual({ off: true, seen: [6] });
  });

  test('a hidden tab marks nothing: an arrival on screen while the tab is hidden still counts once the person scrolls away', async () => {
    visibility = 'hidden';
    boxes = { msg_A2: { top: 400, height: 200 } };
    const el = await openThenArrive({ onSeen: () => {} }, A2);
    const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
    const body = el.querySelector('.ib-pbody')!;
    act(() => void body.dispatchEvent(new Event('scroll')));
    visibility = 'visible';
    boxes = { msg_A2: { top: 2000, height: 200 } };
    act(() => void body.dispatchEvent(new Event('scroll')));
    expect(pill.textContent).toBe('1 new');
  });

  test("an arrival's first lines are measured where it sits, not where its entrance draws it", () => {
    const article = document.createElement('article');
    article.setAttribute('data-message-article', 'msg_X');
    const sender = document.createElement('div');
    sender.className = 'ib-fline';
    article.appendChild(sender);
    document.body.appendChild(article);
    try {
      // Drawn 6 px low while its entrance runs.
      boxes = { msg_X: { top: 406, height: 200 } };
      expect(measureFirstLines(article)).toEqual({ top: 406, bottom: 436 + FIRST_LINES_PX, line: 436 });
      article.setAttribute('data-arrived', '');
      const computed = window.getComputedStyle;
      stub(window, 'getComputedStyle', {
        writable: true,
        value: (element: Element) => (element === article ? ({ transform: 'matrix(1, 0, 0, 1, 0, 6)' } as CSSStyleDeclaration) : computed(element)),
      });
      expect(measureFirstLines(article)).toEqual({ top: 400, bottom: 430 + FIRST_LINES_PX, line: 430 });
    } finally {
      article.remove();
    }
  });
});

describe('the rules', () => {
  test('the first lines: the sender row and 96 px under it, or the whole message when shorter', () => {
    expect(firstLines({ top: 100, bottom: 600 }, 116, 146)).toEqual({ top: 116, bottom: 146 + FIRST_LINES_PX, line: 146 });
    expect(firstLines({ top: 100, bottom: 180 }, 116, 146)).toEqual({ top: 116, bottom: 180, line: 146 });
    expect(firstLines({ top: 100, bottom: 600 }, null, null)).toEqual({ top: 100, bottom: 100 + FIRST_LINES_PX, line: 100 + FIRST_LINE_PX });
  });

  // The failure this guards: on a view shorter than the first lines plus the
  // pill's band (a phone on its side, the keyboard up) nothing could ever be seen.
  test('a view too short for the first lines above the pill needs only the first line', () => {
    const lines = { top: 100, bottom: 226, line: 130 };
    expect(requiredLines(lines, { top: 0, bottom: 800 }, 56)).toEqual({ top: 100, bottom: 226 });
    expect(requiredLines(lines, { top: 0, bottom: 160 }, 56)).toEqual({ top: 100, bottom: 130 });
    expect(firstLinesInView(requiredLines({ top: 10, bottom: 136, line: 40 }, { top: 0, bottom: 160 }, 56), { top: 0, bottom: 160 }, 56)).toBe(true);
    // Without the pill the same view holds the first lines whole.
    expect(requiredLines(lines, { top: 0, bottom: 160 }, 0)).toEqual({ top: 100, bottom: 226 });
    expect(requiredLines(lines, { top: 0, bottom: 100 }, 0)).toEqual({ top: 100, bottom: 130 });
  });

  test('the points tested for a cover: the middle of the visible width, near the top of the lines and halfway down', () => {
    expect(samplePoints({ top: 100, bottom: 200 }, { left: 0, right: 600 }, { left: 100, right: 500 })).toEqual([
      { x: 300, y: 108 },
      { x: 300, y: 150 },
    ]);
    expect(samplePoints({ top: 100, bottom: 104 }, { left: 0, right: 200 }, { left: 0, right: 200 })).toEqual([
      { x: 100, y: 102 },
      { x: 100, y: 102 },
    ]);
  });

  test('in view: wholly inside, above the pill\'s band when it shows', () => {
    const view = { top: 0, bottom: 800 };
    expect(firstLinesInView({ top: 600, bottom: 760 }, view)).toBe(true);
    expect(firstLinesInView({ top: 600, bottom: 760 }, view, 56)).toBe(false);
    expect(firstLinesInView({ top: -10, bottom: 100 }, view)).toBe(false);
    expect(firstLinesInView({ top: 700, bottom: 900 }, view)).toBe(false);
    expect(firstLinesInView({ top: 100, bottom: 100 }, view)).toBe(false);
  });

  test('arrivals: agent messages after the look and after the person\'s last reply', () => {
    const messages = [message(ROOT, AGENT, 2, 'a'), message('msg_A2', AGENT, 4, 'b'), message('msg_P1', PERSON, 6, 'c'), message('msg_A3', AGENT, 8, 'd')];
    expect(unseenArrivals(messages, 2).map((m) => m.id)).toEqual(['msg_A3']);
    expect(unseenArrivals(messages, 8)).toEqual([]);
    expect(unseenArrivals(messages, null)).toEqual([]);
    expect(latestAgentSeq({ messages })).toBe(8);
    expect(latestAgentSeq({ messages: [{ ...messages[0]!, seq: undefined }] })).toBeNull();
  });

  test('the look goes as far as every arrival up to it was seen', () => {
    const arrivals = [message('msg_A2', AGENT, 6, 'b'), message('msg_A3', AGENT, 8, 'c'), message('msg_A4', AGENT, 10, 'd')];
    expect(lookThrough(arrivals, new Set())).toBeNull();
    expect(lookThrough(arrivals, new Set(['msg_A3']))).toBeNull();
    expect(lookThrough(arrivals, new Set(['msg_A2', 'msg_A4']))).toBe(6);
    expect(lookThrough(arrivals, new Set(['msg_A2', 'msg_A3', 'msg_A4']))).toBe(10);
  });

  test('follow: down by what the first lines need, never up', () => {
    expect(followBy({ top: 760, bottom: 886 }, { top: 0, bottom: 800 })).toBe(98);
    expect(followBy({ top: 300, bottom: 426 }, { top: 0, bottom: 800 })).toBe(0);
  });
});
