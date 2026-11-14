export interface RecordPause<T> {
  ask(now: boolean): void;
  afterLook(ms: number): Promise<T | undefined>;
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
