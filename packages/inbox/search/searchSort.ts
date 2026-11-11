import { useSyncExternalStore } from 'react';
import type { InboxSearchSort } from '@plannotator/core/inbox-search';
import { storage } from '@plannotator/ui/utils/storage';

export const SEARCH_SORT_COOKIE = 'plannotator-inbox-search-sort';

export const SEARCH_SORT_OPTIONS: readonly { value: InboxSearchSort; label: string }[] = [
  { value: 'best', label: 'Best match' },
  { value: 'newest', label: 'Newest' },
];

export const parseSearchSort = (raw: string | null): InboxSearchSort => (raw === 'newest' ? 'newest' : 'best');

const listeners = new Set<() => void>();
const read = (): InboxSearchSort => parseSearchSort(storage.getItem(SEARCH_SORT_COOKIE));
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const readSearchSort = read;

export function setSearchSort(sort: InboxSearchSort): void {
  if (sort === 'newest') storage.setItem(SEARCH_SORT_COOKIE, 'newest');
  else storage.removeItem(SEARCH_SORT_COOKIE);
  for (const listener of [...listeners]) listener();
}

export function useSearchSort(): InboxSearchSort {
  return useSyncExternalStore(subscribe, read, () => 'best');
}
