/**
 * A read that fails or runs out goes again, a little later each time, and only once every try failed is the person
 * told (decision mode's thread read: one slow or failed read used to leave "Reading the question…" forever).
 */
export interface ReadRetryTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: ReadRetryTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `read` up to `tries` times; `onRead` gets the first success, `onFailed` runs once all failed. Returns a stop. */
export function readWithRetries<T>(read: () => Promise<T>, handlers: { onRead: (value: T) => void; onFailed: () => void }, options: { tries: number; waitMs: number; timers?: ReadRetryTimers }): () => void {
  const timers = options.timers ?? realTimers;
  let stopped = false;
  let timer: unknown;
  const attempt = (n: number) => {
    void read().then(
      (value) => {
        if (!stopped) handlers.onRead(value);
      },
      () => {
        if (stopped) return;
        if (n + 1 >= options.tries) handlers.onFailed();
        else timer = timers.set(() => attempt(n + 1), options.waitMs * (n + 1));
      },
    );
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer !== undefined) timers.clear(timer);
  };
}
