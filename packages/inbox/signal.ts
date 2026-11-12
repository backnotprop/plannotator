export interface Signal {
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
