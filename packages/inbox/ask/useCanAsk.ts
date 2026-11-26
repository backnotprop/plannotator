/**
 * Whether the thread's owner can take a question now (`can_ask` on the thread's Ask read), for the review's Ask on
 * selected lines: read when the review opens and again on each Ask change of the thread (askEvents.ts), through the
 * page's one shared read (askReads.ts). Off (`enabled` false): never asks, and answers false.
 */
import { useEffect, useState } from 'react';
import { onAskChange } from './askEvents';
import { readAsk } from './askReads';

export function useCanAsk(threadId: string, enabled: boolean): boolean {
  const [canAsk, setCanAsk] = useState(false);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, threadId]);
  return enabled && canAsk;
}
