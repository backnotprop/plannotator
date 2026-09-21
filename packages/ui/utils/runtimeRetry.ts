/**
 * A shared retry epoch for lazily loaded diagram runtimes.
 *
 * Mermaid and Graphviz memoize one runtime per module, so when a chunk
 * import fails every block on the page fails together. Each block's Retry
 * button used to bump only that block's own token, leaving its siblings on
 * their error panels after the shared runtime had recovered. Bumping the
 * epoch notifies every subscribed block, so one Retry re-attempts all of
 * them (the memoized loader still issues a single import for the batch).
 */
export interface RuntimeRetryEpoch {
  /** Ask every subscriber to re-attempt. */
  bump(): void;
  /** Subscribe; returns the unsubscribe. */
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
