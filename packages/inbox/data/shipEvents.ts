/**
 * `event: ships` from this Inbox (packages/server/inbox.ts): a ship here changed (started, stopped, the watch saw a
 * change, the agent logged a step). The Reviews rows read the ships again (data/ships.ts). No imports: the event
 * stream (eventFrames.ts) and the hook both use it without importing each other.
 */
const listeners = new Set<() => void>();

export const shipEvents = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(): void {
    for (const listener of listeners) listener();
  },
};
