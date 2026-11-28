import { useSyncExternalStore } from 'react';

const shownDiffPanes = new Map<string, boolean>();
const listeners = new Set<() => void>();
let everyShownPaneNarrow = false;

export function reportShownDiffPane(tabId: string, narrow: boolean | null): void {
  if (narrow === null) shownDiffPanes.delete(tabId);
  else shownDiffPanes.set(tabId, narrow);
  const next = shownDiffPanes.size > 0 && [...shownDiffPanes.values()].every(Boolean);
  if (next === everyShownPaneNarrow) return;
  everyShownPaneNarrow = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => everyShownPaneNarrow;

export function useEveryDiffPaneTooNarrowForSplit(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
