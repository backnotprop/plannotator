/**
 * The pause between the stream's records and the one read that follows them (the window's `readAfterRecord`):
 * records that come close together share one read, started `delayMs` after the last of them, or at once when asked.
 *
 * A look of this window (seen on sight) writes a record of its own before its answer comes back, so the read that
 * record brings is the look's list read too (`afterLook`): one already waiting starts now, else the next record to
 * come starts its read at once. None within `ms` (the look changed nothing, or the stream is down): undefined, and the
 * look reads the list itself.
 */
export interface RecordPause<T> {
  /** Records ask for the read: after the pause, or (`now`) at once, with the records still waiting. */
  ask(now: boolean): void;
  /** The read of the records after a look, started now (see the header). */
  afterLook(ms: number): Promise<T | undefined>;
  /** The window went away: nothing waits any more. */
  stop(): void;
}

export function createRecordPause<T>(read: () => Promise<T>, delayMs: number): RecordPause<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const looks: ((read: Promise<T>) => void)[] = [];
  const start = (): Promise<T> => {
    if (timer) clearTimeout(timer);
    timer = null;
    return read();
  };
  return {
    ask(now) {
      if (timer) clearTimeout(timer);
      timer = null;
      const waiting = looks.splice(0);
      if (!now && waiting.length === 0) {
        timer = setTimeout(start, delayMs);
        return;
      }
      const started = start();
      for (const take of waiting) take(started);
    },
    afterLook(ms) {
      if (timer) return start();
      return new Promise<T | undefined>((resolve) => {
        const take = (started: Promise<T>) => {
          clearTimeout(giveUp);
          resolve(started);
        };
        const giveUp = setTimeout(() => {
          const at = looks.indexOf(take);
          if (at >= 0) looks.splice(at, 1);
          resolve(undefined);
        }, ms);
        looks.push(take);
      });
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const take of looks.splice(0)) take(Promise.resolve(null as T));
    },
  };
}
