import { inboxApi } from '../../api';

export interface LookPoster {
  post(threadId: string, through: number): void;
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
