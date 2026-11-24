/**
 * The PRs Grid draws in full (approval "inbox-agent-grid"): when each was put on its thread, its checks and review,
 * and when a merged or closed one was seen so. They come from the thread-PR reader the Inbox already runs (`GET
 * threads/:id/pulls`, sent to the thread's own computer for a linked one): no new route and no poll of its own.
 *
 * Read only while Grid is on screen, and only for the rows whose list summary names a PR; once read, a thread is
 * read again only when its `thread-pulls` event names it (or every thread, after a reconnect) or its row's summary
 * changes. At most two reads at a time. What was read is kept for the window's life, so coming back draws at once.
 */
import { useEffect, useState } from 'react';
import type { InboxThreadPullWire } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { threadPullsBus } from '../threadPulls/model';
import { tabShown } from '../data/shownPoll';

const READS_AT_ONCE = 2;

/** Each thread's PRs as last read, and the row summary they were read for. */
const kept = new Map<string, { key: string; pulls: readonly InboxThreadPullWire[] }>();

export type GridPullRead = (threadId: string) => Promise<{ pulls: readonly InboxThreadPullWire[] }>;

/**
 * `wanted`: the threads to have, each with its row summary's key (`gridPullThreads`); empty while Grid is off or not
 * shown, which reads nothing. Answers what is kept for them, drawn again as reads land.
 */
export function useGridPulls(wanted: readonly { thread: string; key: string }[], read: GridPullRead = (id) => inboxApi.threadPulls(id)): ReadonlyMap<string, readonly InboxThreadPullWire[]> {
  const [, setDrawn] = useState(0);
  const sig = wanted.map((w) => `${w.thread}=${w.key}`).join('|');
  useEffect(() => {
    if (wanted.length === 0) return;
    let live = true;
    const queue: string[] = [];
    let running = 0;
    const keyOf = new Map(wanted.map((w) => [w.thread, w.key]));
    const pump = () => {
      while (live && running < READS_AT_ONCE && queue.length > 0 && tabShown()) {
        const thread = queue.shift()!;
        const key = keyOf.get(thread)!;
        running++;
        read(thread)
          .then((answer) => {
            kept.set(thread, { key, pulls: answer.pulls });
            if (live) setDrawn((n) => n + 1);
          })
          .catch(() => {
            // A failed read keeps what was kept; its next event, or the row's next change, reads it again.
          })
          .finally(() => {
            running--;
            pump();
          });
      }
    };
    const want = (thread: string) => {
      if (!keyOf.has(thread) || queue.includes(thread)) return;
      queue.push(thread);
    };
    for (const { thread, key } of wanted) if (kept.get(thread)?.key !== key) want(thread);
    pump();
    const unsubscribe = threadPullsBus.subscribe((change) => {
      if (change === '*') for (const thread of keyOf.keys()) want(thread);
      else want(change);
      pump();
    });
    // A read held back while the tab was hidden goes when it shows.
    const back = () => pump();
    document.addEventListener('visibilitychange', back);
    return () => {
      live = false;
      unsubscribe();
      document.removeEventListener('visibilitychange', back);
    };
    // `sig` names every thread and key in `wanted`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, read]);
  const out = new Map<string, readonly InboxThreadPullWire[]>();
  for (const { thread } of wanted) {
    const got = kept.get(thread);
    if (got) out.set(thread, got.pulls);
  }
  return out;
}

/** Tests: forget what was read. */
export function forgetGridPulls(): void {
  kept.clear();
}
