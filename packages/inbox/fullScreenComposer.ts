import { useCallback, useSyncExternalStore } from 'react';

export type ComposerMode = 'comment' | 'reply';

const picked = new Map<string, ComposerMode>();
const minimized = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function composerModeFor(threadId: string, hasDraft: boolean, takesComments: boolean): ComposerMode {
  if (!takesComments) return 'reply';
  return picked.get(threadId) ?? (hasDraft ? 'reply' : 'comment');
}

export function pickComposerMode(threadId: string, mode: ComposerMode): void {
  if (picked.get(threadId) === mode) return;
  picked.set(threadId, mode);
  changed();
}

export function composerMinimized(threadId: string, foldedByDefault = false): boolean {
  return minimized.get(threadId) ?? foldedByDefault;
}

export function setComposerMinimized(threadId: string, on: boolean): void {
  if (minimized.get(threadId) === on) return;
  minimized.set(threadId, on);
  changed();
}

export function forgetComposerOpened(threadId: string): void {
  if (minimized.get(threadId) !== false) return;
  minimized.delete(threadId);
  changed();
}

export function openComposerComment(threadId: string): () => void {
  const hadTab = picked.get(threadId);
  const hadFold = minimized.get(threadId);
  showComposerComment(threadId);
  return () => {
    if (hadTab === undefined) picked.delete(threadId);
    else picked.set(threadId, hadTab);
    // No fold now: the next HTML page opened clear before this draft's cleanup ran, so a card the person had opened stays forgotten.
    const forgotten = !minimized.has(threadId);
    if (hadFold === undefined || (hadFold === false && forgotten)) minimized.delete(threadId);
    else minimized.set(threadId, hadFold);
    changed();
  };
}

export function showComposerComment(threadId: string): void {
  picked.set(threadId, 'comment');
  minimized.set(threadId, false);
  changed();
}

export function resetComposerState(): void {
  picked.clear();
  minimized.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useComposerFolded(threadId: string | null, foldedByDefault = false): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return threadId !== null && composerMinimized(threadId, foldedByDefault);
}

export function useComposerState(threadId: string, hasDraft: boolean, takesComments: boolean, foldedByDefault = false) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const setMode = useCallback((mode: ComposerMode) => pickComposerMode(threadId, mode), [threadId]);
  const setMinimized = useCallback((on: boolean) => setComposerMinimized(threadId, on), [threadId]);
  return {
    mode: composerModeFor(threadId, hasDraft, takesComments),
    setMode,
    minimized: composerMinimized(threadId, foldedByDefault),
    setMinimized,
  };
}
