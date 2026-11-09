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
