/**
 * A swarm thread's read, shared with what draws inside its messages (the plan card in the body of the agent reply that
 * `swarm propose` wrote, swarm/SwarmPlanCard.tsx). A message's body is drawn by a memoized view from its own data only
 * (parts/MessageView.tsx), so the swarm reaches it here instead: `useThreadSwarm` puts each read in, before paint, and
 * the card reads it by its thread's id, so it follows every read (an agent joining, a line changed) on its own.
 */
import { useSyncExternalStore } from 'react';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';

export interface SharedThreadSwarm {
  swarm: InboxThreadSwarm;
  /** Opens the thread's ghost pane. */
  openGhost: () => void;
  phone: boolean;
}

const shared = new Map<string, SharedThreadSwarm>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The thread pane's latest read of `threadId`'s swarm; null while Swarm is off, or the thread is not a swarm. */
export function shareThreadSwarm(threadId: string, value: SharedThreadSwarm | null): void {
  const was = shared.get(threadId) ?? null;
  if (was === value) return;
  if (value) shared.set(threadId, value);
  else shared.delete(threadId);
  for (const listener of listeners) listener();
}

/** What the thread pane shares of `threadId`'s swarm, or null. */
export function useSharedThreadSwarm(threadId: string): SharedThreadSwarm | null {
  return useSyncExternalStore(
    subscribe,
    () => shared.get(threadId) ?? null,
    () => null,
  );
}
