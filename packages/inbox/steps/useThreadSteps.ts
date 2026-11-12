import { useEffect, useState } from 'react';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { shownStepLists } from './model';

export type StepsChange = string | '*' | 'presence';
export type StepsSubscribe = (listener: (change: StepsChange) => void) => () => void;

export const STEPS_REFRESH_MS = 60_000;

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
    let showing = false;
    const load = () => {
      const mine = ++seq;
      read(threadId)
        .then((answer) => {
          if (!live || mine !== seq) return;
          const shown = answer.on ? shownStepLists(answer.steps) : [];
          showing = shown.length > 0;
          setLists({ thread: threadId, lists: shown });
          if (timer) clearTimeout(timer);
          timer = shown.length > 0 ? setTimeout(load, STEPS_REFRESH_MS) : null;
        })
        .catch(() => {
          if (!live || mine !== seq) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, STEPS_REFRESH_MS);
        });
    };
    load();
    const unsubscribe = subscribe?.((change) => {
      if (change === 'presence' ? showing : change === '*' || change === threadId) load();
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [threadId, on, subscribe, read]);
  return lists.thread === threadId ? lists.lists : [];
}
