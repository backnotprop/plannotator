/**
 * `event: runs` from this Inbox (packages/server/inbox.ts): a run card's state changed on this computer (a run
 * started, ended or was stopped, from any window or a phone; a secret saved or removed: `all`). The run store reads
 * the cards it names again, so a card on screen does not have to poll while nothing runs. No imports: the event
 * stream (eventFrames.ts) and the store (runStore.ts) both use it without importing each other.
 */
export type RunStateChange = { message_ids: string[] } | { all: true };

const listeners = new Set<(change: RunStateChange) => void>();

export const runEvents = {
  subscribe(listener: (change: RunStateChange) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(change: RunStateChange): void {
    for (const listener of listeners) listener(change);
  },
};

/** The frame's data as a change, or null when it says nothing usable. */
export function readRunStateFrame(data: string): RunStateChange | null {
  try {
    const parsed = JSON.parse(data) as { message_ids?: unknown; all?: unknown };
    if (parsed.all === true) return { all: true };
    const ids = Array.isArray(parsed.message_ids) ? parsed.message_ids.filter((id): id is string => typeof id === 'string') : [];
    return ids.length > 0 ? { message_ids: ids } : null;
  } catch {
    return null;
  }
}
