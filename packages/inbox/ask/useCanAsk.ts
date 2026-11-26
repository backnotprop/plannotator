/**
 * Whether the thread's owner can take a question now (`can_ask` on the thread's Ask read), for the review's Ask on
 * selected lines: read when the review opens and again on each Ask change of the thread (askEvents.ts), through the
 * page's one shared read (askReads.ts). Off (`enabled` false), or a linked machine's thread (Ask is this Inbox's own,
 * as the Ask window's is: useInboxAsk): never asks, and answers false.
 */
import { useEffect, useState } from 'react';
import { onAskChange } from './askEvents';
import { readAsk } from './askReads';
import { onLinkedMachine } from '../linkedReads';

export function useCanAsk(threadId: string, enabled: boolean): boolean {
  const [canAsk, setCanAsk] = useState(false);
  const on = enabled && !onLinkedMachine(threadId);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const reload = () =>
      readAsk(threadId).then(
        (model) => {
          if (live) setCanAsk(model.can_ask);
        },
        () => {},
      );
    void reload();
    const stop = onAskChange((changed) => {
      if (changed === null || changed === threadId) void reload();
    });
    return () => {
      live = false;
      stop();
    };
  }, [on, threadId]);
  return on && canAsk;
}
