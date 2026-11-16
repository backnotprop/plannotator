/**
 * The reads that follow every thread on screen (panes/shownReads.ts, mounted through usePaneOpens.ts as App mounts
 * it), with two panes as a second pane will have them: what one open thread was read for before (records, a
 * catch-up, a linked machine's frames, its held writes, a launched session, a stale copy) now reads each thread on
 * screen, and only the ones it concerns.
 *
 * What regresses: a record, frame or stale copy of the other pane's thread leaving it unread; a read of a thread
 * the records owe nothing; a read of a thread no pane shows.
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
    out.shown = useShownReads(reads, { latest: deps.latest, filesSignals: deps.filesSignals }, client);
    out.reads = reads;
    return null;
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  const panes = focusPane(split(singlePane(a), 'main', { id: 'p2', thread: b }, 'right'), 'main');
  await act(async () => {
    root!.render(<Window panes={panes} />);
    await flush();
  });
  expect(asked.sort()).toEqual([a, b].sort());
  asked.length = 0;
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
});
