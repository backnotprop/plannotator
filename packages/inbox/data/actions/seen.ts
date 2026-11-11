/**
 * A look of this window sent to the Inbox (seen on sight, seenOnSight.ts: messages that arrived in the open thread
 * have been on screen, up to `through`). One look per thread on its way at a time, never past a later one; a look the
 * server did not take is sent again a few times, waiting longer each time, unless a later one covers it.
 *
 * Once a look lands, `landed` runs (the window raises its look and reads the list: the read its record brings,
 * App's `recordRead`), and `track` hears the whole of it, landing and list read, so Mark read can wait for it.
 */
import { inboxApi } from '../../api';

export interface LookPoster {
  /** Send the look up to `through` (nothing when one at least as far is on its way). */
  post(threadId: string, through: number): void;
  /** The window went away: no look is sent again. */
  stop(): void;
}

export function createLookPoster(options: {
  landed: (threadId: string, through: number) => Promise<unknown>;
  track: (threadId: string, look: Promise<unknown>) => void;
  retries: number;
  retryMs: number;
  send?: (threadId: string, through: number) => Promise<unknown>;
}): LookPoster {
  const send = options.send ?? ((threadId: string, through: number) => inboxApi.seen(threadId, through));
  /** Per thread, the furthest look on its way to the server. */
  const posting = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    post(threadId, through) {
      if ((posting.get(threadId) ?? -1) >= through) return;
      posting.set(threadId, through);
      const attempt = (tries: number) => {
        const look = send(threadId, through)
          .then(() => {
            if (posting.get(threadId) === through) posting.delete(threadId);
            return options.landed(threadId, through);
          })
          .catch(() => {
            // A later look on its way covers this one.
            if (posting.get(threadId) !== through) return;
            if (tries >= options.retries) {
              posting.delete(threadId);
              return;
            }
            const timer = setTimeout(() => {
              timers.delete(timer);
              attempt(tries + 1);
            }, options.retryMs * 2 ** tries);
            timers.add(timer);
          });
        options.track(threadId, look);
      };
      attempt(0);
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
