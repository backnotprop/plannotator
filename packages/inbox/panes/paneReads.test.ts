/**
 * Each pane's open and reads (panes/paneReads.ts), with two panes as a second pane will have them: a read draws in the
 * pane showing its thread and nowhere else. What regresses: one pane's failure, look or "opened with" drawn in the
 * other; a pane moving on giving up the other pane's read; a read of a thread no pane shows drawing anything; an older
 * read of a pane's thread overwriting a newer one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, type ThreadModel } from '../api';
import { createKeyedSignal } from '../signal';
import { focusPane, open as openIn, singlePane, split, type PaneSet } from './model';
import { createPaneReads, type PaneOpenView } from './paneReads';

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-10-12T09:00:00.000Z' };

function threadOf(id: string, seqs: number[]): InboxThread {
  const messages: InboxMessageWire[] = seqs.map((seq, i) => ({
    id: i === 0 ? id : `${id}_${seq}`,
    project_id: PROJECT.id,
    thread_id: id,
    reply_to: i === 0 ? null : id,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' },
    subject: i === 0 ? id : null,
    body: `message ${seq}`,
    created_at: `2026-10-12T17:${String(10 + seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
  }));
  return { thread_id: id, project: PROJECT, subject: id, thread_name: null, resolved_at: null, messages };
}

/** Reads the test answers by hand: each call waits until the test resolves or rejects it. */
interface Pending {
  threadId: string;
  signal: AbortSignal | undefined;
  answer: (thread: InboxThread) => void;
  fail: (cause: unknown) => void;
}

function harness(start: PaneSet) {
  let panes = start;
  const pending: Pending[] = [];
  const drawn: ReadonlyMap<string, PaneOpenView>[] = [];
  const opened: string[] = [];
  const reads = createPaneReads({
    client: new QueryClient(),
    panes: () => panes,
    read: (threadId, _ms, signal) =>
      new Promise<ThreadModel>((resolve, reject) => {
        pending.push({ threadId, signal, answer: (thread) => resolve({ serverSession: 's', cursor: 1, thread }), fail: reject });
      }),
    drawReady: async () => {},
    latest: () => null,
    firstList: () => ({ done: true, promise: Promise.resolve() }),
    filesSignals: createKeyedSignal(),
    drawn: (views) => void drawn.push(views),
  });
  const stops = new Map<string, { thread: string | null; stop: () => void }>();
  /** A pane whose thread changed opens it, or closes (the window's own: usePaneOpens.test.tsx). */
  const show = (next: PaneSet) => {
    panes = next;
    for (const { id, thread } of next.panes) {
      if (stops.get(id)?.thread === thread) continue;
      stops.get(id)?.stop();
      if (!thread) reads.close(id);
      stops.set(id, { thread, stop: thread ? reads.open(id, thread, (threadId) => void opened.push(`${id}:${threadId}`)) : () => {} });
    }
  };
  const take = (threadId: string) => {
    const at = pending.findIndex((p) => p.threadId === threadId);
    expect(at).toBeGreaterThanOrEqual(0);
    return pending.splice(at, 1)[0]!;
  };
  return { reads, show, take, pending, drawn, opened, setPanes: (next: PaneSet) => (panes = next), stopAll: () => stops.forEach(({ stop }) => stop()) };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const twoPanes = (a: string, b: string) => split(singlePane(a), 'main', { id: 'p2', thread: b }, 'right');

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('two panes, one open each', () => {
  test("each read draws its look and what it opened with in its own pane, and each pane's open completes for its thread", async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    stop = h.stopAll;
    h.show(twoPanes('thr_a', 'thr_b'));
    h.take('thr_b').answer(threadOf('thr_b', [2, 4]));
    await settle();
    expect(h.reads.view('p2').look).toMatchObject({ threadId: 'thr_b', through: 4 });
    expect([...(h.reads.view('p2').openedWith?.ids ?? [])]).toEqual(['thr_b', 'thr_b_4']);
    expect(h.reads.view('main').look).toBeNull();
    expect(h.opened).toEqual(['p2:thr_b']);
    h.take('thr_a').answer(threadOf('thr_a', [2]));
    await settle();
    expect(h.reads.view('main').look?.threadId).toBe('thr_a');
    expect(h.reads.view('p2').look?.threadId).toBe('thr_b');
    expect(h.opened).toEqual(['p2:thr_b', 'main:thr_a']);
  });

  test('a failed read shows in its pane only; Try again counts per pane', async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    stop = h.stopAll;
    h.show(twoPanes('thr_a', 'thr_b'));
    h.take('thr_b').fail(new InboxApiError(404, 'not_found', 'Not found'));
    await settle();
    expect(h.reads.view('p2').load).toMatchObject({ threadId: 'thr_b', state: 'missing' });
    expect(h.reads.view('main').load).toBeNull();
    h.reads.retry('p2');
    expect(h.reads.view('p2').retry).toBe(1);
    expect(h.reads.view('main').retry).toBe(0);
  });

  test('a pane moving to another thread gives up only its own read; the other pane goes on', async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    stop = h.stopAll;
    h.show(twoPanes('thr_a', 'thr_b'));
    const a = h.take('thr_a');
    const b = h.take('thr_b');
    h.show(openIn(twoPanes('thr_a', 'thr_b'), 'thr_c', 'p2'));
    expect(b.signal?.aborted).toBe(true);
    expect(a.signal?.aborted).toBe(false);
    a.answer(threadOf('thr_a', [2]));
    await settle();
    expect(h.reads.view('main').look?.threadId).toBe('thr_a');
    expect(h.reads.view('p2').look).toBeNull();
  });

  test('a read of a thread no pane shows draws nothing, and still answers', async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    const read = h.reads.refreshThread('thr_z');
    h.take('thr_z').answer(threadOf('thr_z', [2]));
    expect((await read)?.thread_id).toBe('thr_z');
    expect(h.drawn).toEqual([]);
  });

  test('an older read of a pane’s thread never overwrites a newer one that landed', async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    const older = h.reads.refreshThread('thr_a');
    const first = h.take('thr_a');
    // A Send's own read lands first (`given`), numbered after the one still out.
    await h.reads.refreshThread('thr_a', { serverSession: 's', cursor: 2, thread: threadOf('thr_a', [2, 6]) });
    expect(h.reads.view('main').look?.through).toBe(6);
    expect(h.reads.readOf('thr_a').loaded?.messages).toHaveLength(2);
    first.answer(threadOf('thr_a', [2]));
    await older;
    expect(h.reads.readOf('thr_a').loaded?.messages).toHaveLength(2);
  });

  test('closing one pane clears what it drew; the other keeps its look, and the look routes by thread', async () => {
    const h = harness(twoPanes('thr_a', 'thr_b'));
    stop = h.stopAll;
    h.show(twoPanes('thr_a', 'thr_b'));
    h.take('thr_a').answer(threadOf('thr_a', [2]));
    h.take('thr_b').answer(threadOf('thr_b', [2]));
    await settle();
    h.reads.raiseThrough('thr_b', 9);
    expect(h.reads.lookOf('thr_b')?.through).toBe(9);
    expect(h.reads.lookOf('thr_a')?.through).toBe(2);
    h.reads.close('p2');
    expect(h.reads.view('p2').look).toBeNull();
    expect(h.reads.view('main').look?.threadId).toBe('thr_a');
    // The active pane's look is what Back from snooze reads.
    h.setPanes(focusPane(twoPanes('thr_a', 'thr_b'), 'main'));
    expect(h.reads.activeLook.current?.threadId).toBe('thr_a');
  });
});
