/**
 * Search's order (approval "inbox-search-sort"): "Best match" (today's order) or "Newest" (each group by its latest
 * message first). The pick is this browser's own, kept like the sidebar's closed sections: a cookie through
 * `storage`, so it survives a restart on another port, and a phone and the Mac decide separately. No cookie: Best
 * match. Not a server setting, never synced.
 */
import { useSyncExternalStore } from 'react';
import type { InboxSearchSort } from '@plannotator/core/inbox-search';
import { storage } from '@plannotator/ui/utils/storage';

export const SEARCH_SORT_COOKIE = 'plannotator-inbox-search-sort';

export const SEARCH_SORT_OPTIONS: readonly { value: InboxSearchSort; label: string }[] = [
  { value: 'best', label: 'Best match' },
  { value: 'newest', label: 'Newest' },
];

/** The cookie's value as an order; anything but "newest" reads as Best match. */
export const parseSearchSort = (raw: string | null): InboxSearchSort => (raw === 'newest' ? 'newest' : 'best');

const listeners = new Set<() => void>();
const read = (): InboxSearchSort => parseSearchSort(storage.getItem(SEARCH_SORT_COOKIE));
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The order this browser remembers, read now (the palette's request reads it without a render). */
export const readSearchSort = read;

/** Remember an order. Best match is the default, so it clears the cookie. */
export function setSearchSort(sort: InboxSearchSort): void {
  if (sort === 'newest') storage.setItem(SEARCH_SORT_COOKIE, 'newest');
  else storage.removeItem(SEARCH_SORT_COOKIE);
  for (const listener of [...listeners]) listener();
}

export function useSearchSort(): InboxSearchSort {
  return useSyncExternalStore(subscribe, read, () => 'best');
}
