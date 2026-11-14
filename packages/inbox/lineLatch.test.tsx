/**
 * What a page load arms of the line of one-time dialogs as time passes on a tab left loaded (reveal.ts
 * `useLineLatch`), wired to a line dialog as App wires it (`useLineReveal`, List view's moment).
 *
 * What regresses: a tab loaded while the line was held (inside the gap after a dialog) never arming the dialog the
 * Inbox names later, so someone whose tab stays loaded for days never sees a one-time dialog (the owner, 2026-11-09:
 * "never saw the List view dialog"); a tab still armed for a dialog the line has moved past; the tab polling (the
 * owner: "We have like a poll or something now ... Could it leak?"): more than one read per moment the Inbox named, a
 * timer scheduled when no moment is ahead, a timer kept while the tab is hidden, or a timer or listener left behind
 * when the window goes away; a load that had the tour or an update no longer keeping its first read.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxRevealId } from './api';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');

/** The latch's own timeout is the only one with this delay once its moment has passed: the tests find it by that. */
const SLACK = 137;
const TIMES = { pageAgeMs: 100, readMs: 40, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30, lineReadSlackMs: SLACK };

type Line = { next: InboxRevealId | null; ahead?: InboxRevealId[] };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedFetch: typeof fetch;
let savedSetTimeout: typeof setTimeout;
let savedClearTimeout: typeof clearTimeout;
/** What the Inbox would answer a settings read now: the line, and how long until a date can change it. */
let server: { line: Line; againIn: number | null } = { line: { next: null }, againIn: null };
let rereads = 0;
let claims: string[] = [];
let visible = true;
/** The latch's timeouts that are scheduled and neither fired nor cleared. */
const pending = new Set<unknown>();
/** Every timeout the latch ever scheduled, by its delay. */
let scheduled: number[] = [];
/** The listeners on `document` and `window` now, by type. */
const listeners = new Map<string, number>();
const restore: (() => void)[] = [];

function countListeners(target: EventTarget, types: readonly string[]) {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]) => {
    if (types.includes(type)) listeners.set(type, (listeners.get(type) ?? 0) + 1);
    return add(type, ...rest);
  }) as typeof target.addEventListener;
  target.removeEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?]) => {
    if (types.includes(type)) listeners.set(type, (listeners.get(type) ?? 0) - 1);
    return remove(type, ...rest);
  }) as typeof target.removeEventListener;
  restore.push(() => {
    target.addEventListener = add;
    target.removeEventListener = remove;
  });
}

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  server = { line: { next: null }, againIn: null };
  rereads = 0;
  claims = [];
  visible = true;
  pending.clear();
  scheduled = [];
  listeners.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  // The latch's timeouts, told apart by their delay: its slack past the moment, or longer for a moment still ahead.
  savedSetTimeout = globalThis.setTimeout;
  savedClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
    const ours = typeof delay === 'number' && ((delay >= SLACK && delay <= SLACK + 400) || delay > 60_000);
    const id: unknown = savedSetTimeout(
      () => {
        pending.delete(id);
        handler();
      },
      delay,
      ...rest,
    );
    if (ours) {
      pending.add(id);
      scheduled.push(delay);
    }
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    pending.delete(id);
    savedClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  countListeners(document, ['visibilitychange']);
  countListeners(window, ['pagehide']);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/api/inbox/reveal') && init?.method === 'POST') {
      claims.push((JSON.parse(String(init.body)) as { id: string }).id);
      return new Response(JSON.stringify({ show: true, reveal: { next: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  globalThis.setTimeout = savedSetTimeout;
  globalThis.clearTimeout = savedClearTimeout;
  for (const undo of restore.splice(0)) undo();
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

const wait = (ms: number) => act(() => new Promise((resolve) => savedSetTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}

const ROWS = ['a', 'b', 'c', 'd', 'e'].map(
  (id) =>
    ({
      thread_id: id,
      project: { id: 'prj_a', name: 'billing-svc' },
      subject: `Thread ${id}`,
      section: 'new',
      unseen: 0,
      questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    }) as unknown as InboxListRow,
);

interface State {
  /** The page's newest settings read: the line, and the moment the Inbox named, on the page's clock. */
  line: Line;
  againAt: number | null;
  thread: string | null;
  /** The tour or an update was on screen on this load. */
  frozen: boolean;
}

/** App's wiring: the latch over the page's settings, a reread that reads the Inbox's line into them, List view armed from it. */
function Harness({ state, onRead }: { state: State; onRead: () => void }) {
  const latch = reveal.useLineLatch({ read: reveal.revealArmed({ reveal: state.line }), frozen: state.frozen, againAt: state.againAt, reread: onRead });
  reveal.useLineReveal({
    id: 'list_view',
    due: latch?.next === 'list_view' || (latch?.ahead.includes('list_view') ?? false),
    blocked: false,
    rows: ROWS,
    toast: false,
    thread: state.thread,
    clear: state.thread === null,
    place: state.thread ?? '',
    heldBack: () => false,
    leaveCounts: (_visit, _now, _row, next) => reveal.listViewRevealLeaveCounts(next),
    mayClaim: (pageAge) => pageAge >= TIMES.pageAgeMs,
    holds: () => true,
  });
  return null;
}

/** A page whose first settings read said `line`, with a date `againIn` ms ahead that can change it (null: none). */
function mount(line: Line, againIn: number | null, frozen = false) {
  let state: State = { line, againAt: againIn === null ? null : Date.now() + againIn, thread: null, frozen };
  // A settings read (App's `rereadLine`): the line as the Inbox has it now, and the next moment it names.
  const read = () => {
    rereads += 1;
    set({ line: server.line, againAt: server.againIn === null ? null : Date.now() + server.againIn });
  };
  const draw = () => act(() => root!.render(<Harness state={state} onRead={read} />));
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    if (root) draw();
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  draw();
  return set;
}

/** The moment: a thread read, then back on the list, and the settling wait. */
async function readAndLeave(set: (next: Partial<State>) => void) {
  set({ thread: 'a' });
  await wait(TIMES.readMs + 20);
  set({ thread: null });
  await wait(TIMES.settledMs + 120);
}

describe.skipIf(!hasDom)('what a load arms of the line, on a tab left loaded', () => {
  test('a tab loaded while the line was held reads it once at the moment the Inbox named, arms the dialog it names then, and claims it at its moment', async () => {
    // The gap after the last dialog ends in a moment (already past here: the timeout is the slack alone).
    server = { line: { next: null, ahead: ['list_view'] }, againIn: null };
    const set = mount({ next: null }, 400);
    await wait(TIMES.pageAgeMs + 20);
    await readAndLeave(set);
    expect(claims).toEqual([]);
    expect(rereads).toBe(0);
    await until(() => rereads > 0);
    await readAndLeave(set);
    await until(() => claims.length > 0);
    expect(claims).toEqual(['list_view']);
    // One read for the one moment, and nothing scheduled after it: the Inbox named no other.
    await wait(SLACK * 3);
    expect(rereads).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(pending.size).toBe(0);
  });

  test('the line moved past the dialog this tab was armed for (shown elsewhere): after the read it is not claimed here', async () => {
    server = { line: { next: null }, againIn: null };
    const set = mount({ next: 'list_view' }, -1);
    await wait(TIMES.pageAgeMs + 20);
    await until(() => rereads > 0);
    await readAndLeave(set);
    expect(claims).toEqual([]);
  });

  test('no moment ahead: nothing is scheduled and the Inbox is never asked; a moment far ahead is one timeout, not a poll', async () => {
    const set = mount({ next: null }, null);
    await wait(SLACK * 3);
    expect(scheduled).toEqual([]);
    expect(rereads).toBe(0);
    // A settings read for another reason names a moment 40 minutes ahead: one timeout for it, and no read before it.
    set({ againAt: Date.now() + 40 * 60_000 });
    await wait(SLACK * 3);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeGreaterThan(39 * 60_000);
    expect(pending.size).toBe(1);
    expect(rereads).toBe(0);
  });

  test('a hidden tab keeps no timer; back in front after the moment it reads once, at once', async () => {
    visible = false;
    mount({ next: null }, -1);
    await wait(SLACK * 3);
    expect(pending.size).toBe(0);
    expect(rereads).toBe(0);
    visible = true;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(pending.size).toBe(1);
    await until(() => rereads > 0);
    expect(rereads).toBe(1);
    // Hidden again with a moment pending: the timeout is cleared, not left to fire in the background.
    server = { line: { next: null }, againIn: -1 };
    mount({ next: null }, 40 * 60_000);
    expect(pending.size).toBe(1);
    visible = false;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(pending.size).toBe(0);
  });

  test('the window going away leaves nothing behind: no timer and no listener, and the Inbox is not asked afterwards', async () => {
    mount({ next: null }, 40 * 60_000);
    expect(pending.size).toBe(1);
    expect(listeners.get('visibilitychange')).toBe(1);
    expect(listeners.get('pagehide')).toBe(1);
    // The page is put away (bfcache, a phone's app switcher): the timeout goes at once.
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(pending.size).toBe(0);
    act(() => root!.unmount());
    root = null;
    expect(listeners.get('visibilitychange')).toBe(0);
    expect(listeners.get('pagehide')).toBe(0);
    // Unmounted with its moment a slack away: it never fires.
    mount({ next: null }, -1);
    expect(pending.size).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(pending.size).toBe(0);
    await wait(SLACK * 3);
    expect(rereads).toBe(0);
    expect(listeners.get('visibilitychange')).toBe(0);
    expect(listeners.get('pagehide')).toBe(0);
  });

  test('a load that had the tour or an update keeps its first read, and keeps no timer', async () => {
    const set = mount({ next: null }, -1, true);
    await wait(TIMES.pageAgeMs + 20);
    expect(scheduled).toEqual([]);
    // A settings read for another reason names List view: this load still arms nothing.
    set({ line: { next: 'list_view' } });
    await readAndLeave(set);
    expect(claims).toEqual([]);
    expect(rereads).toBe(0);
  });
});
