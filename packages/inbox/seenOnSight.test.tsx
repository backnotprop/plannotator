/**
 * Seen on sight, as the thread pane does it (design record
 * "inbox-new-in-open-thread", variant A, approved 2026-10-12; not in this
 * repo): an agent message that arrives while the thread is open counts as
 * seen once its first lines have been on screen for a second, with the tab
 * visible, the window focused and nothing over the thread. happy-dom has no
 * layout and no IntersectionObserver, so the test gives the elements their
 * boxes and drives a stand-in observer. The real browser proof is
 * tests/e2e/inbox-seen-on-sight.spec.ts; the rules alone are checked at the
 * bottom without a DOM.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { FIRST_LINES_PX, SEEN_DWELL_MS, firstLines, firstLinesInView, followBy, latestAgentSeq, lookThrough, unseenArrivals } from './seenOnSight';

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
const thread = (...arrivals: InboxMessageWire[]): InboxThread => ({
  thread_id: ROOT,
  project: PROJECT,
  subject: 'Refund events',
  thread_name: null,
  resolved_at: null,
  messages: [...OPENED, ...arrivals],
});
const A2 = message('msg_A2', AGENT, 6, 'Retries are on, three attempts.');
const A3 = message('msg_A3', AGENT, 8, 'And the dashboard shows them.');

// ── the stand-ins: boxes, the observer, the window in front ──

/** Each message's box in the view (the body is 0..800). Absent: far below. */
let boxes: Record<string, { top: number; height: number }> = {};
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

beforeEach(() => {
  if (!hasDom) return;
  boxes = {};
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
      if (this.classList.contains('ib-sender') || this.classList.contains('ib-fline')) return rect(box.top, 30);
      return this === article ? rect(box.top, box.height) : rect(box.top, 0);
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
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  for (const undo of restore.splice(0).reverse()) undo();
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

interface PaneProps {
  thread: InboxThread;
  onSeen: (through: number) => void;
  file?: { id: string; version: 'current' | 'sent'; focus: string | null } | null;
  phone?: boolean;
  covered?: boolean;
}

function pane({ thread, onSeen, file = null, phone = false, covered = false }: PaneProps) {
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        decisions={[]}
        onOpenDecisionPage={() => {}}
        file={file}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        lookSeq={2}
        seenThrough={2}
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
    root.render(pane({ ...props, thread: thread() }));
  });
  await wait(0);
  act(() => root!.render(pane({ ...props, thread: thread(...arrivals) })));
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
});

describe('the rules', () => {
  test('the first lines: the sender row and 96 px under it, or the whole message when shorter', () => {
    expect(firstLines({ top: 100, bottom: 600 }, 116, 146)).toEqual({ top: 116, bottom: 146 + FIRST_LINES_PX });
    expect(firstLines({ top: 100, bottom: 180 }, 116, 146)).toEqual({ top: 116, bottom: 180 });
    expect(firstLines({ top: 100, bottom: 600 }, null, null)).toEqual({ top: 100, bottom: 100 + FIRST_LINES_PX });
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
