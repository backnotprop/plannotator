/**
 * The reads that follow every thread on screen (panes/shownReads.ts, mounted through usePaneOpens.ts as App mounts
 * it), with two panes as a second pane will have them: what one open thread was read for before (records, a
 * catch-up, a linked machine's frames, its held writes, a launched session, a stale copy) now reads each thread on
 * screen, and only the ones it concerns.
 *
 * What regresses: a record, frame or stale copy of the other pane's thread leaving it unread; a read of a thread
 * the records owe nothing; a read of a thread no pane shows; without the switch, any read other than main's for the
 * address's thread (another thread, a second read, a promise to wait on where main had none); a pane kept off the
 * page read on every write, or left unread once back after a read passed it by.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import type { InboxListRow, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { ListModel, ThreadModel } from '../api';
import { putThread, staleThread } from '../data/queries/thread';
import { rememberMachine } from '../inboxUrl';
import { newRecordBatch } from '../openThreadReads';
import { createKeyedSignal } from '../signal';
import { STALE_OPEN_MS } from '../threadFlights';
import { focusPane, singlePane, split, type PaneSet } from './model';
import type { PaneReads } from './paneReads';
import { MACHINE_THREAD_WAIT_MS, type ShownReads } from './shownReads';
import { usePaneOpening, usePaneReads, useShownReads } from './usePaneOpens';

const hasDom = typeof document !== 'undefined';
const MACHINE = 'ibx_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const PROJECT = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-10-12T09:00:00.000Z', repo: null, repo_known: true as const };

function threadOf(id: string, extra: Partial<InboxMessageWire> = {}): InboxThread {
  const message: InboxMessageWire = {
    id,
    project_id: PROJECT.id,
    thread_id: id,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' },
    subject: id,
    body: 'message',
    created_at: '2026-10-12T17:10:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    seq: 2,
    ...extra,
  };
  return { thread_id: id, project: PROJECT, subject: id, thread_name: null, resolved_at: null, messages: [message] };
}

const row = (threadId: string) => ({ thread_id: threadId, priority: null, snoozed: false, resolved_at: null }) as unknown as InboxListRow;
const listOf = (...threads: string[]) => ({ sections: [{ id: 'new', title: 'New', threads: threads.map(row) }] }) as unknown as ListModel;

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  jest.useRealTimers();
});

/** Two panes open on `a` (active) and `b`, both read; then every read the test makes is counted in `asked`. */
async function mountTwo(a: string, b: string, list: ListModel, threads: Record<string, InboxThread> = {}) {
  const panes = focusPane(split(singlePane(a), 'main', { id: 'p2', thread: b }, 'right'), 'main');
  const w = await mountWith(panes, true, { thread: a }, list, threads);
  expect(w.asked.sort()).toEqual([a, b].sort());
  w.asked.length = 0;
  return w;
}

/** Without the switch: the one pane on the address's thread (`address.thread`, which the test moves), read. */
async function mountOne(address: { thread: string | null }, list: ListModel) {
  const w = await mountWith(singlePane(address.thread), false, address, list, {});
  w.asked.length = 0;
  return w;
}

async function mountWith(panes: PaneSet, splitOn: boolean, address: { thread: string | null }, list: ListModel, threads: Record<string, InboxThread>) {
  const client = new QueryClient();
  const asked: string[] = [];
  const out: { reads: PaneReads | null; shown: ShownReads | null } = { reads: null, shown: null };
  const deps = {
    client,
    read: async (threadId: string): Promise<ThreadModel> => {
      asked.push(threadId);
      return { serverSession: 's', cursor: 1, thread: threads[threadId] ?? threadOf(threadId) };
    },
    drawReady: async () => {},
    latest: () => list,
    firstList: () => ({ done: true, promise: Promise.resolve() }),
    filesSignals: createKeyedSignal(),
  };
  function Window({ panes }: { panes: PaneSet }) {
    const reads = usePaneReads(deps, panes);
    usePaneOpening(reads, panes, () => {});
    out.shown = useShownReads(reads, { latest: deps.latest, filesSignals: deps.filesSignals, split: splitOn, open: () => address.thread }, client);
    out.reads = reads;
    return null;
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<Window panes={panes} />);
    await flush();
  });
  return { client, asked, shown: () => out.shown!, reads: () => out.reads! };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const settle = (step: () => unknown) =>
  act(async () => {
    step();
    await flush();
  });

describe.skipIf(!hasDom)('reads that follow every thread on screen', () => {
  test("a pause's records read the thread they name, in whichever pane; one gone from the list is read too", async () => {
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'));
    await settle(() => w.shown().afterRecords({ ...newRecordBatch(), threads: new Set(['thr_b']) }, Promise.resolve(listOf('thr_a', 'thr_b'))));
    expect(w.asked).toEqual(['thr_b']);
    w.asked.length = 0;
    await settle(() => w.shown().afterRecords(newRecordBatch(), Promise.resolve(listOf('thr_b'))));
    expect(w.asked).toEqual(['thr_a']);
  });

  test('a catch-up reads every thread on screen', async () => {
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'));
    await settle(() => w.shown().all());
    expect(w.asked.sort()).toEqual(['thr_a', 'thr_b']);
  });

  test("a linked machine's frames read its thread on screen once they pause; its held writes settling read it too", async () => {
    rememberMachine(['thr_far'], MACHINE);
    const w = await mountTwo('thr_a', 'thr_far', listOf('thr_a', 'thr_far'));
    jest.useFakeTimers();
    w.shown().machineFrame(MACHINE);
    w.shown().machineFrame(MACHINE);
    w.shown().machineFrame('ibx_01HYYYYYYYYYYYYYYYYYYYYYYY');
    await settle(() => jest.advanceTimersByTime(MACHINE_THREAD_WAIT_MS));
    expect(w.asked).toEqual(['thr_far']);
    w.asked.length = 0;
    await settle(() => w.shown().onMachines(new Set([MACHINE])));
    expect(w.asked).toEqual(['thr_far']);
  });

  test('the live sessions moving read the launched thread on screen, not the other', async () => {
    const launched = threadOf('thr_b', { launch: { id: 'lch_1' } as never });
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'), { thr_b: launched });
    await settle(() => w.shown().launched());
    expect(w.asked).toEqual(['thr_b']);
  });

  test('a stale copy of either thread on screen is read after the wait; one no pane shows is not', async () => {
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'));
    putThread(w.client, 'thr_z', { serverSession: 's', cursor: 1, thread: threadOf('thr_z') });
    jest.useFakeTimers();
    staleThread(w.client, 'thr_z');
    staleThread(w.client, 'thr_b');
    staleThread(w.client, 'thr_a');
    await settle(() => jest.advanceTimersByTime(STALE_OPEN_MS));
    expect(w.asked.sort()).toEqual(['thr_a', 'thr_b']);
  });

  // Review of #3528 (finding 5): every write read every pane kept off the page again.
  test('a pane kept off the page reads nothing; back on the page it reads once, only when something passed it by', async () => {
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'));
    const off = new Set(['p2'] as PaneSet['active'][]);
    // Nothing passed it by: back without a read.
    await settle(() => w.reads().park(off));
    await settle(() => w.reads().park(new Set()));
    expect(w.asked).toEqual([]);
    await settle(() => w.reads().park(off));
    expect(w.shown().shown()).toEqual(['thr_a']);
    await settle(() => w.shown().afterRecords({ ...newRecordBatch(), threads: new Set(['thr_b']) }, Promise.resolve(listOf('thr_a', 'thr_b'))));
    await settle(() => w.shown().all());
    await settle(() => w.shown().launched());
    expect(w.asked).toEqual(['thr_a']);
    w.asked.length = 0;
    jest.useFakeTimers();
    staleThread(w.client, 'thr_b');
    await settle(() => jest.advanceTimersByTime(STALE_OPEN_MS));
    expect(w.asked).toEqual([]);
    // Back: one read, however many passed it by.
    await settle(() => w.reads().park(new Set()));
    expect(w.asked).toEqual(['thr_b']);
    w.asked.length = 0;
    // Off and back again with nothing new: none.
    await settle(() => w.reads().park(off));
    await settle(() => w.reads().park(new Set()));
    expect(w.asked).toEqual([]);
  });

  // Re-check 2 of #3528: a pane off the page whose thread was deleted elsewhere came back still showing it.
  test('a pane kept off the page whose thread the list stops listing reads it once back; still listed, it does not', async () => {
    const w = await mountTwo('thr_a', 'thr_b', listOf('thr_a', 'thr_b'));
    const off = new Set(['p2'] as PaneSet['active'][]);
    await settle(() => w.reads().park(off));
    await settle(() => w.shown().afterRecords(newRecordBatch(), Promise.resolve(listOf('thr_a', 'thr_b'))));
    await settle(() => w.reads().park(new Set()));
    expect(w.asked).toEqual([]);
    await settle(() => w.reads().park(off));
    await settle(() => w.shown().afterRecords(newRecordBatch(), Promise.resolve(listOf('thr_a'))));
    expect(w.asked).toEqual([]);
    await settle(() => w.reads().park(new Set()));
    expect(w.asked).toEqual(['thr_b']);
  });
});

// Without the switch every read here is main's (App.tsx before panes: `routeRef.current.thread` read inline, one
// machine timer, `watchStaleOpen`). These pin main's behaviour where a per-thread path would differ.
describe.skipIf(!hasDom)('without the switch, the open thread is read as main read it', () => {
  test('nothing open: a catch-up reads nothing and gives nothing to wait for; one open: its own read', async () => {
    const address = { thread: null as string | null };
    const w = await mountOne(address, listOf('thr_a'));
    expect(w.shown().all()).toBeNull();
    address.thread = 'thr_a';
    let reading: unknown = null;
    await settle(() => (reading = w.shown().all()));
    expect(w.asked).toEqual(['thr_a']);
    expect(Array.isArray(await reading)).toBe(false);
  });

  test("a linked machine's frames share one timer: the latest frame's open thread is read, once, as main did", async () => {
    rememberMachine(['thr_far', 'thr_far2'], MACHINE);
    const address = { thread: 'thr_far' as string | null };
    const w = await mountOne(address, listOf('thr_far', 'thr_far2', 'thr_a'));
    jest.useFakeTimers();
    w.shown().machineFrame(MACHINE);
    address.thread = 'thr_far2';
    w.shown().machineFrame(MACHINE);
    await settle(() => jest.advanceTimersByTime(MACHINE_THREAD_WAIT_MS));
    expect(w.asked).toEqual(['thr_far2']);
    w.asked.length = 0;
    // A frame of the open thread's machine, then the person opens a local thread: main's timer still reads it.
    w.shown().machineFrame(MACHINE);
    address.thread = 'thr_a';
    w.shown().machineFrame(MACHINE);
    await settle(() => jest.advanceTimersByTime(MACHINE_THREAD_WAIT_MS));
    expect(w.asked).toEqual(['thr_far2']);
  });

  test("records and a gone row read the address's thread; a stale copy is read once (main's watch alone)", async () => {
    const address = { thread: 'thr_a' as string | null };
    const w = await mountOne(address, listOf('thr_a'));
    await settle(() => w.shown().afterRecords({ ...newRecordBatch(), threads: new Set(['thr_a']) }, Promise.resolve(listOf('thr_a'))));
    expect(w.asked).toEqual(['thr_a']);
    w.asked.length = 0;
    await settle(() => w.shown().afterRecords(newRecordBatch(), Promise.resolve(listOf())));
    expect(w.asked).toEqual(['thr_a']);
    w.asked.length = 0;
    jest.useFakeTimers();
    staleThread(w.client, 'thr_a');
    await settle(() => jest.advanceTimersByTime(STALE_OPEN_MS));
    expect(w.asked).toEqual(['thr_a']);
    // A run of pick saves that ends after the person moved on reads for the thread open now, as main did.
    address.thread = 'thr_b';
    expect(w.shown().ownOpen('thr_a')).toBe('thr_b');
  });
});
