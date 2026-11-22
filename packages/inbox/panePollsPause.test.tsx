/**
 * The open thread's polls (the live sessions, a waiting reply's connection, who can be tagged, each tagged session's
 * connection, the sessions a Send reaches, the steps lists) do no work nobody sees:
 *  - a read that brings the same answer draws nothing (each used to set a new object, so the whole pane drew again
 *    every few seconds);
 *  - nothing is read while the tab is hidden or the pane parked (kept off the page by a narrow free layout); the
 *    moment it shows again, exactly one read, then the same rhythm as before.
 * What must not change, and is held here: while the pane shows, each poll reads as often as it did ("Queued",
 * "Sending" and Send now follow a waiting reply every 3 s; the route choice reads the sessions every 10 s), and a
 * changed answer draws at once.
 *
 * Time is the test's (fake timers); nothing here asserts how long anything takes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { Profiler, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import type { StepsChange } from './steps/useThreadSteps';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { useLiveSessions } = (hasDom ? await import('./components/NewMessage') : {}) as typeof import('./components/NewMessage');
const { useTaggable, useTagConnections } = (hasDom ? await import('./components/TagPicker') : {}) as typeof import('./components/TagPicker');
const { useEndedSessions } = (hasDom ? await import('./components/ReplyRoute') : {}) as typeof import('./components/ReplyRoute');
const { useThreadSteps } = (hasDom ? await import('./steps/useThreadSteps') : {}) as typeof import('./steps/useThreadSteps');

const THREAD = 'msg_T1';
let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: DocumentVisibilityState = 'visible';
const restore: (() => void)[] = [];
let commits = 0;

beforeEach(() => {
  if (!hasDom) return;
  jest.useFakeTimers();
  visibility = 'visible';
  commits = 0;
  const saved = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  restore.push(() => (saved ? Object.defineProperty(document, 'visibilityState', saved) : delete (document as unknown as Record<string, unknown>).visibilityState));
});

afterEach(() => {
  if (!hasDom) return;
  try {
    act(() => root?.unmount());
    host?.remove();
  } finally {
    root = null;
    host = null;
    try {
      for (const undo of restore.splice(0).reverse()) undo();
    } finally {
      jest.useRealTimers();
    }
  }
});

/** One turn the fake timers leave alone: replies and effects settle. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 4; i++) await act(turn);
}
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await turn();
  });
  await settle();
}
function render(node: ReactNode) {
  const tree = (
    <Profiler id="pane" onRender={() => commits++}>
      {node}
    </Profiler>
  );
  if (root) return act(() => root!.render(tree));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(tree);
  });
}
function show(next: DocumentVisibilityState) {
  visibility = next;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
}

/** A new object for each read, as the wire gives. */
let sessionsAnswer: Record<string, unknown> = {};
let taggableAnswer: Record<string, unknown> = {};
function stubReads(): { count: () => number } {
  let reads = 0;
  const sessions = spyOn(inboxApi, 'sessions').mockImplementation(async () => {
    reads++;
    return structuredClone(sessionsAnswer) as never;
  });
  const taggable = spyOn(inboxApi, 'taggable').mockImplementation(async () => {
    reads++;
    return structuredClone(taggableAnswer) as never;
  });
  restore.push(() => {
    sessions.mockRestore();
    taggable.mockRestore();
  });
  return { count: () => reads };
}

const LIVE = (busy: boolean) => ({
  home: null,
  project: null,
  sessions: [{ session: 'ses_a', host: 'claude-code', busy, started_at: '2026-11-21T09:00:00.000Z', last_seen_at: '2026-11-21T09:30:00.000Z', wrote_thread: true }],
  asker: { session: 'ses_a', live: true, connection: { polls: true, busy } },
  recipients: { ses_b: { polls: true, busy } },
});

interface Poll {
  name: string;
  every: number;
  /** The pane's hook, parked or not. */
  pane: (parked: boolean) => ReactNode;
}
function Hook({ use }: { use: () => unknown }) {
  use();
  return null;
}
const POLLS: Poll[] = [
  { name: "a waiting reply's connection (Queued, Sending, Send now)", every: 3_000, pane: (parked) => <Hook use={() => useLiveSessions(THREAD, 'ses_a', true, 3_000, parked)} /> },
  { name: 'the live sessions (New message, the route choice)', every: 10_000, pane: (parked) => <Hook use={() => useLiveSessions(THREAD, 'ses_a', true, undefined, parked)} /> },
  { name: 'who can be tagged', every: 10_000, pane: (parked) => <Hook use={() => useTaggable(THREAD, true, parked)} /> },
  { name: "each tagged session's connection", every: 3_000, pane: (parked) => <Hook use={() => useTagConnections(THREAD, ['ses_b'], true, parked)} /> },
  { name: 'the other sessions a Send reaches', every: 10_000, pane: (parked) => <Hook use={() => useEndedSessions(THREAD, ['ses_b'], parked)} /> },
];

describe.skipIf(!hasDom)('the pane polls', () => {
  for (const poll of POLLS) {
    test(`${poll.name}: same answers draw nothing, a change draws once; hidden or parked reads nothing; shown again, one read`, async () => {
      sessionsAnswer = LIVE(false);
      taggableAnswer = { serverSession: 's', owner: null, sessions: [] };
      const reads = stubReads();
      render(poll.pane(false));
      await settle();
      expect(reads.count()).toBe(1);

      // Shown: the rhythm as before, and the same answers draw nothing.
      commits = 0;
      for (let tick = 0; tick < 3; tick++) await wait(poll.every);
      expect(reads.count()).toBe(4);
      expect(commits).toBe(0);
      // Not the ended-sessions read: it keeps only "ended", which did not change.
      if (!poll.name.startsWith('the other sessions')) {
        sessionsAnswer = LIVE(true);
        taggableAnswer = { serverSession: 's', owner: null, sessions: [{ session: 'ses_b', host: 'codex', label: null, taggable: true, owner: false, wrote_thread: false }] };
        await wait(poll.every);
        expect(commits).toBe(1);
      } else await wait(poll.every);
      const shownReads = reads.count();

      // The tab hidden: nothing, however long.
      show('hidden');
      await wait(poll.every * 10);
      expect(reads.count()).toBe(shownReads);
      // Shown again: one read at once, then the rhythm from there.
      show('visible');
      await settle();
      expect(reads.count()).toBe(shownReads + 1);
      await wait(poll.every);
      expect(reads.count()).toBe(shownReads + 2);

      // Parked: nothing; back on the page: one read at once.
      render(poll.pane(true));
      await wait(poll.every * 10);
      expect(reads.count()).toBe(shownReads + 2);
      commits = 0;
      render(poll.pane(false));
      await settle();
      expect(reads.count()).toBe(shownReads + 3);
    });
  }

  test('a parked pane keeps what it last read: nothing goes blank while it is off the page', async () => {
    sessionsAnswer = LIVE(true);
    stubReads();
    const seen: unknown[] = [];
    render(<Hook use={() => seen.push(useLiveSessions(THREAD, 'ses_a', true, 3_000, false).model)} />);
    await settle();
    const held = seen.at(-1);
    expect(held).not.toBeNull();
    render(<Hook use={() => seen.push(useLiveSessions(THREAD, 'ses_a', true, 3_000, true).model)} />);
    await settle();
    expect(seen.at(-1)).toBe(held);
  });

  test('the steps lists: presence moving with the same lists draws nothing; hidden, it reads once when shown', async () => {
    const lists: InboxStepsWire[] = [{ id: 'stp_1', thread_id: THREAD, agent: { host: 'claude-code', session: 'ses_a', name: null }, steps: [{ id: 's1', text: 'Write the retry', state: 'doing' }] } as unknown as InboxStepsWire];
    let reads = 0;
    const read = async () => {
      reads++;
      return { on: true, steps: structuredClone(lists) };
    };
    const listeners = new Set<(change: StepsChange) => void>();
    const subscribe = (listener: (change: StepsChange) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };
    const emit = (change: StepsChange) => act(() => listeners.forEach((l) => l(change)));
    const pane = (parked: boolean) => <Hook use={() => useThreadSteps(THREAD, true, subscribe, read, parked)} />;
    render(pane(false));
    await settle();
    expect(reads).toBe(1);

    // A `deliveries` frame moves presence about once a second while agents work: each reads, none draws.
    commits = 0;
    for (let frame = 0; frame < 10; frame++) {
      emit('presence');
      await settle();
    }
    expect(reads).toBe(11);
    expect(commits).toBe(0);

    // Hidden: the frames and the minute's timer read nothing; shown, one read.
    show('hidden');
    for (let frame = 0; frame < 10; frame++) emit('presence');
    await wait(5 * 60_000);
    expect(reads).toBe(11);
    show('visible');
    await settle();
    expect(reads).toBe(12);

    // Parked: nothing; back, one read.
    render(pane(true));
    emit('presence');
    await wait(5 * 60_000);
    expect(reads).toBe(12);
    render(pane(false));
    await settle();
    expect(reads).toBe(13);
  });
});
