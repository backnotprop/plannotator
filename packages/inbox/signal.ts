/**
 * A signal with no state: the window tells the open thread's pane to read
 * something again (its files, its reply draft) without drawing anything.
 * Before, a counter in the window's state did it, which drew the whole window
 * and the thread with every message for each record, only to start a read
 * that most often brought nothing new.
 */
export interface Signal {
  /** Hear each emit until the returned call. */
  subscribe(listener: () => void): () => void;
  emit(): void;
}

export function createSignal(): Signal {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** One signal per thread: an emit reaches only the panes showing that thread. */
export interface KeyedSignal {
  /** The same signal for a thread every time, so a pane's subscription holds across renders. */
  of(key: string): Signal;
  emit(key: string): void;
}

export function createKeyedSignal(): KeyedSignal {
  const signals = new Map<string, Signal>();
  const of = (key: string): Signal => {
    let signal = signals.get(key);
    if (!signal) signals.set(key, (signal = createSignal()));
    return signal;
  };
  return { of, emit: (key) => signals.get(key)?.emit() };
}
