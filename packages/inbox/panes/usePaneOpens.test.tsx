/**
 * The window's opens (panes/usePaneOpens.ts) mounted as App mounts them, with two panes as a second pane will have
 * them and reads the test answers by hand.
 *
 * What regresses: Try again not reading again; a Try again taking back what the thread opened with; a pane closed
 * or removed mid-read still drawing, or keeping its thread in memory; the window's unmount leaving reads out; a thread
 * opened beside the active pane marked seen (the opening look) before the person is in that pane; a pane the person
 * goes back into never looking at what reached it while they were in another, so its thread stays new for good.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ThreadModel } from '../api';
import { InboxApiError } from '../apiError';
import { createKeyedSignal } from '../signal';
import { close, focusPane, open, singlePane, split, type PaneSet } from './model';
import { NO_OPEN, type PaneReads } from './paneReads';
import { usePaneOpening, usePaneReads } from './usePaneOpens';

const hasDom = typeof document !== 'undefined';
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

interface Pending {
  threadId: string;
  signal: AbortSignal | undefined;
  answer: (thread: InboxThread) => void;
  fail: (cause: unknown) => void;
}

let root: Root | null = null;
let el: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  el?.remove();
  root = null;
  el = null;
});

function mount(start: PaneSet) {
  const client = new QueryClient();
  const pending: Pending[] = [];
  const opened: string[] = [];
  const out: { reads: PaneReads | null } = { reads: null };
  const deps = {
    client,
    read: (threadId: string, _ms: number, signal?: AbortSignal) =>
      new Promise<ThreadModel>((resolve, reject) => {
        pending.push({ threadId, signal, answer: (thread) => resolve({ serverSession: 's', cursor: 1, thread }), fail: reject });
      }),
    drawReady: async () => {},
    latest: () => null,
    firstList: () => ({ done: true, promise: Promise.resolve() }),
    filesSignals: createKeyedSignal(),
  };
  function Window({ panes }: { panes: PaneSet }) {
    const reads = usePaneReads(deps, panes);
    out.reads = reads;
    usePaneOpening(reads, panes, (threadId) => void opened.push(threadId));
    return null;
  }
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  const draw = (panes: PaneSet) => act(() => root!.render(<Window panes={panes} />));
  draw(start);
  const take = (threadId: string) => {
    const at = pending.findIndex((p) => p.threadId === threadId);
    expect(at).toBeGreaterThanOrEqual(0);
    return pending.splice(at, 1)[0]!;
  };
  /** Answer or fail a read, and let what it draws land. */
  const land = async (step: () => void) =>
    act(async () => {
      step();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  return { client, pending, opened, draw, take, land, reads: () => out.reads! };
}

const twoPanes = () => focusPane(split(singlePane('thr_a'), 'main', { id: 'p2', thread: 'thr_b' }, 'right'), 'main');
const missing = () => new InboxApiError(404, 'not_found', 'Not found');
const collect = async () => {
  for (let i = 0; i < 4; i += 1) {
    Bun.gc(true);
    await Promise.resolve();
  }
};

describe.skipIf(!hasDom)('each pane opens its thread', () => {
  test('Try again on a missing thread reads it again, and the open completes', async () => {
    const w = mount(singlePane('thr_a'));
    await w.land(() => w.take('thr_a').fail(missing()));
    expect(w.reads().view('main').load?.state).toBe('missing');
    expect(w.pending).toHaveLength(0);
    act(() => w.reads().retry('main'));
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2])));
    expect(w.reads().view('main').load).toBeNull();
    expect(w.opened).toEqual(['thr_a']);
  });

  test('Try again keeps what the thread opened with; the open looks again', async () => {
    const w = mount(singlePane('thr_a'));
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2])));
    expect([...w.reads().view('main').openedWith!.ids]).toEqual(['thr_a']);
    act(() => w.reads().retry('main'));
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2, 4])));
    expect([...w.reads().view('main').openedWith!.ids]).toEqual(['thr_a']);
    expect(w.opened).toEqual(['thr_a', 'thr_a']);
  });

  test('a pane closed while its read is out gives the read up and draws nothing', async () => {
    const w = mount(twoPanes());
    const b = w.take('thr_b');
    w.draw(open(twoPanes(), null, 'p2'));
    expect(b.signal?.aborted).toBe(true);
    await w.land(() => b.answer(threadOf('thr_b', [2])));
    expect(w.reads().view('p2').look).toBeNull();
    expect(w.reads().view('p2').openedWith).toBeNull();
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2])));
    expect(w.opened).toEqual(['thr_a']);
  });

  test('a pane closed after its thread landed keeps nothing of it', async () => {
    const w = mount(twoPanes());
    await w.land(() => w.take('thr_b').answer(threadOf('thr_b', [2])));
    const kept = new WeakRef(w.reads().readOf('thr_b').loaded!);
    w.draw(open(twoPanes(), null, 'p2'));
    w.client.clear();
    await collect();
    expect(kept.deref()).toBeUndefined();
  });

  test('removed panes give up their reads and keep nothing of their threads', async () => {
    const three = split(twoPanes(), 'p2', { id: 'p3', thread: 'thr_c' }, 'right');
    const w = mount(three);
    await w.land(() => w.take('thr_b').answer(threadOf('thr_b', [2])));
    const kept = new WeakRef(w.reads().readOf('thr_b').loaded!);
    const c = w.take('thr_c');
    w.draw(close(close(three, 'p3'), 'p2'));
    expect(c.signal?.aborted).toBe(true);
    expect(w.reads().view('p2')).toBe(NO_OPEN);
    expect(w.reads().view('p3')).toBe(NO_OPEN);
    // The cache is the window's; what is asked here is that the pane let go of its copy.
    w.client.clear();
    await collect();
    expect(kept.deref()).toBeUndefined();
  });

  test('the window going away gives up its reads, and none lands after', async () => {
    const w = mount(singlePane('thr_a'));
    const a = w.take('thr_a');
    act(() => root!.unmount());
    root = null;
    expect(a.signal?.aborted).toBe(true);
    await w.land(() => a.answer(threadOf('thr_a', [2])));
    expect(w.opened).toEqual([]);
  });

  test('a thread opened beside the active pane is looked at only once the person is in that pane', async () => {
    const w = mount(twoPanes());
    await w.land(() => w.take('thr_b').answer(threadOf('thr_b', [2])));
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2])));
    expect(w.opened).toEqual(['thr_a']);
    w.draw(focusPane(twoPanes(), 'p2'));
    expect(w.opened).toEqual(['thr_a', 'thr_b']);
    w.draw(twoPanes());
    w.draw(focusPane(twoPanes(), 'p2'));
    expect(w.opened).toEqual(['thr_a', 'thr_b']);
  });

  test('going back into a pane looks at what reached it while the person was in another, as an open does; nothing new, no look', async () => {
    const w = mount(twoPanes());
    await w.land(() => w.take('thr_b').answer(threadOf('thr_b', [2])));
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2])));
    w.draw(focusPane(twoPanes(), 'p2'));
    expect(w.opened).toEqual(['thr_a', 'thr_b']);
    // While the person is in p2, an agent's message reaches thr_a (the event stream reads it again): not seen yet.
    const reread = w.reads().refreshThread('thr_a');
    await w.land(() => w.take('thr_a').answer(threadOf('thr_a', [2, 4])));
    await reread;
    expect(w.opened).toEqual(['thr_a', 'thr_b']);
    expect(w.reads().view('main').look?.through).toBe(2);
    // Back in the left pane: looked at, through the new message.
    w.draw(twoPanes());
    expect(w.opened).toEqual(['thr_a', 'thr_b', 'thr_a']);
    expect(w.reads().view('main').look?.through).toBe(4);
    // Back and forth with nothing new since: no look.
    w.draw(focusPane(twoPanes(), 'p2'));
    w.draw(twoPanes());
    expect(w.opened).toEqual(['thr_a', 'thr_b', 'thr_a']);
  });
});
