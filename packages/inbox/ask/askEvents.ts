/**
 * What the event stream tells Ask AI, from App.tsx's one subscription:
 * a thread id when that chat changed, null when anything else may have moved
 * (the live sessions, a reconnect), which can change whether a thread's icon
 * shows. No state in App, so a chat's change draws only the chat.
 */
const listeners = new Set<(threadId: string | null) => void>();

export function emitAskChange(threadId: string | null): void {
  for (const listener of listeners) listener(threadId);
}

export function onAskChange(listener: (threadId: string | null) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
