export interface RuntimeRetryEpoch {
  bump(): void;
  subscribe(listener: () => void): () => void;
}

export function createRuntimeRetryEpoch(): RuntimeRetryEpoch {
  const listeners = new Set<() => void>();
  return {
    bump() {
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
