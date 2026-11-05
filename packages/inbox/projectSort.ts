/**
 * The order of the sidebar's Projects (a person's feedback, the owner's "either
 * alphabetically or most recent ... an elegant toggle"). No cookie is today's
 * order, the server's: oldest project first, a new one at the bottom. Nothing
 * else reads this: the project pickers and the Board's filter keep their own
 * orders. Which order is this browser's own choice, kept like the sections'
 * open state (sidebarSections.ts): a cookie through `storage`, never synced, and
 * every sidebar on the page follows it (the docked one, the peek, the phone sheet).
 */
import { useSyncExternalStore } from 'react';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import type { IconName } from './icons';

export const PROJECTS_SORT_COOKIE = 'plannotator-inbox-projects-sort';

export type ProjectSort = 'added' | 'name' | 'recent';

const SORTS: Readonly<Record<ProjectSort, { icon: IconName; now: string; press: string; next: ProjectSort }>> = {
  // One button goes round all three: today's order stays one press away, so trying the toggle loses nothing.
  added: { icon: 'sortList', now: 'Sorted by when added', press: 'Sort by when added', next: 'name' },
  name: { icon: 'sortAZ', now: 'Sorted A to Z', press: 'Sort A to Z', next: 'recent' },
  recent: { icon: 'sortRecent', now: 'Sorted by most recent', press: 'Sort by most recent', next: 'added' },
};

/** The toggle: its icon (the order on screen), its name and tooltip (that order, then what a press does), the next order and what a press says. */
export function projectSortControl(sort: ProjectSort): { icon: IconName; label: string; next: ProjectSort; said: string } {
  const { icon, now, next } = SORTS[sort];
  return { icon, label: `${now}. ${SORTS[next].press}`, next, said: `Projects: ${SORTS[next].now}.` };
}

/** The cookie's value as an order; anything else is today's. */
export function parseProjectSort(raw: string | null): ProjectSort {
  return raw === 'name' || raw === 'recent' ? raw : 'added';
}

/**
 * Each project's latest activity: the newest `last_at` (the time a row shows, a
 * message from either side) among the threads the window's list holds. So an
 * archived thread is no activity, as it is no row.
 */
export function projectActivity(sections: readonly InboxListSection[]): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const section of sections) {
    for (const row of section.threads) {
      const at = latest.get(row.project.id);
      if (at === undefined || row.last_at > at) latest.set(row.project.id, row.last_at);
    }
  }
  return latest;
}

/**
 * The projects in the chosen order. `added` is the order they came in. A to Z
 * goes by the name on screen, ignoring case and accents and counting numbers as
 * numbers (`app2` before `app10`). Most recent puts a project with no thread in
 * the list (the one the list still shows after its last was archived) last. A
 * tie keeps the order they came in.
 */
export function sortProjects<P extends { id: string; name: string }>(projects: readonly P[], sort: ProjectSort, activity: ReadonlyMap<string, string> = new Map()): readonly P[] {
  if (sort === 'name') return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  if (sort === 'recent') {
    const at = (project: P) => activity.get(project.id) ?? '';
    return [...projects].sort((a, b) => (at(a) === at(b) ? 0 : at(a) > at(b) ? -1 : 1));
  }
  return projects;
}

const listeners = new Set<() => void>();
const read = () => storage.getItem(PROJECTS_SORT_COOKIE) ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Chooses the order in every sidebar on the page and remembers it; today's order leaves no cookie. */
export function setProjectSort(sort: ProjectSort): void {
  if (sort === 'added') storage.removeItem(PROJECTS_SORT_COOKIE);
  else storage.setItem(PROJECTS_SORT_COOKIE, sort);
  for (const listener of [...listeners]) listener();
}

export function useProjectSort(): ProjectSort {
  return parseProjectSort(useSyncExternalStore(subscribe, read, () => ''));
}
