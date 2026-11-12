const listeners = new Set<(threadId: string | null) => void>();

export function emitAskChange(threadId: string | null): void {
  for (const listener of listeners) listener(threadId);
}

export function onAskChange(listener: (threadId: string | null) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
