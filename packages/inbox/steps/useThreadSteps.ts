/**
 * A thread's steps, kept current (approval "inbox-thread-steps"): read when the thread opens, again when a
 * steps line names it, when the live sessions move (a turn starts or ends, a session stops polling: presence),
 * after a reconnect's catch-up, and once a minute while a list shows (an idle bar passing moves presence with
 * no event). Nothing while the switch is off: the server would answer none anyway.
 */

import { useEffect, useState } from 'react';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { shownStepLists } from './model';

/** What a steps change names: a thread, or every thread (presence moved, a catch-up). */
export type StepsChange = string | '*';
export type StepsSubscribe = (listener: (change: StepsChange) => void) => () => void;

/** How often a shown list is read again with no event (presence crosses its 10 min and 2 h bars by time alone). */
export const STEPS_REFRESH_MS = 60_000;

/** The listeners a window keeps for steps changes; `emit` from the event stream, `subscribe` from each thread. */
export function createStepsBus(): { subscribe: StepsSubscribe; emit: (change: StepsChange) => void } {
  const listeners = new Set<(change: StepsChange) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (change) => {
      for (const listener of [...listeners]) listener(change);
    },
  };
}

export function useThreadSteps(threadId: string, on: boolean, subscribe: StepsSubscribe | null, read: (threadId: string) => Promise<{ on: boolean; steps: InboxStepsWire[] }> = inboxApi.threadSteps): InboxStepsWire[] {
  const [lists, setLists] = useState<{ thread: string; lists: InboxStepsWire[] }>({ thread: threadId, lists: [] });
  useEffect(() => {
    if (!on) {
      setLists({ thread: threadId, lists: [] });
      return;
    }
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const mine = ++seq;
      read(threadId)
        .then((answer) => {
          // Only the newest read lands: an older one answering late never puts back an old list.
          if (!live || mine !== seq) return;
          const shown = answer.on ? shownStepLists(answer.steps) : [];
          setLists({ thread: threadId, lists: shown });
          if (timer) clearTimeout(timer);
          timer = shown.length > 0 ? setTimeout(load, STEPS_REFRESH_MS) : null;
        })
        .catch(() => {
          // A failed read keeps what shows; the next event or the timer reads again.
          if (!live || mine !== seq) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, STEPS_REFRESH_MS);
        });
    };
    load();
    const unsubscribe = subscribe?.((change) => {
      if (change === '*' || change === threadId) load();
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [threadId, on, subscribe, read]);
  // Another thread's lists never show while the new one's first read is out.
  return lists.thread === threadId ? lists.lists : [];
}
