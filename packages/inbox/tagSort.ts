/**
 * The order of the sidebar's Tags, with the same toggle and the same three orders as Projects (projectSort.ts). No
 * cookie is today's order, the server's: oldest tag first, a new one at the bottom, so nobody's list changes until
 * they press. The first press goes A to Z, and from then on the button goes between A to Z and most recent, never
 * back to today's order. Most recent is the newest `last_at` among the tag's threads in the window's list, so a tag
 * with no thread there goes last. Nothing else reads this: Add tag, the Filter's Tag group and Search keep their
 * own orders. The choice is this browser's own, a cookie through `storage` apart from Projects' (a person may want
 * Projects by most recent and Tags A to Z), and every sidebar on the page follows it.
 */
import { useSyncExternalStore } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { parseProjectSort, projectSortControl, sortProjects, type ChosenProjectSort, type ProjectSort } from './projectSort';
import type { RowTags } from './threadTags';

export const TAGS_SORT_COOKIE = 'plannotator-inbox-tags-sort';

export type TagSort = ProjectSort;

/** The toggle's icon, words and next order: Projects' own, said for Tags. */
export const tagSortControl = (sort: TagSort) => projectSortControl(sort, 'Tags');

/** The tags in the chosen order, by the rules Projects sort by (`sortProjects`). */
export const sortTags = sortProjects;

/**
 * Each tag's latest activity: the newest `last_at` among the threads the window's list holds with that tag (a row's
 * tags as the window reads them, a linked machine's mapped to the merged ids).
 */
export function tagActivity(rows: readonly InboxListRow[], tagsOf: RowTags): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const row of rows) {
    for (const tag of tagsOf(row)) {
      const at = latest.get(tag);
      if (at === undefined || row.last_at > at) latest.set(tag, row.last_at);
    }
  }
  return latest;
}

const listeners = new Set<() => void>();
const read = () => storage.getItem(TAGS_SORT_COOKIE) ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Chooses the order in every sidebar on the page and remembers it. */
export function setTagSort(sort: ChosenProjectSort): void {
  storage.setItem(TAGS_SORT_COOKIE, sort);
  for (const listener of [...listeners]) listener();
}

export function useTagSort(): TagSort {
  return parseProjectSort(useSyncExternalStore(subscribe, read, () => ''));
}
