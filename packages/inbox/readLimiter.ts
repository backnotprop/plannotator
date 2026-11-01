/**
 * One read at a time, and at most one after it. The thread list is the page's
 * largest read and every store record, pick and draft save asks for it, so on a
 * slow link eight picks stacked eight whole lists in front of the Send that
 * followed them. Whoever asks while a read is on its way shares the one read
 * that starts when it ends: that read began after they asked, so it holds what
 * they wrote. A failed read fails only those who waited on it.
 */
export function oneAtATime<T>(read: () => Promise<T>): () => Promise<T> {
  let running = false;
  let queued: { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } | null = null;

  const start = (): Promise<T> => {
    running = true;
    const run = read();
    const next = () => {
      running = false;
      const waiting = queued;
      queued = null;
      if (waiting) waiting.resolve(start());
    };
    run.then(next, next);
    return run;
  };

  return () => {
    if (!running) return start();
    if (!queued) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      queued = { promise, resolve };
    }
    return queued.promise;
  };
}
