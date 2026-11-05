/**
 * The order of the sidebar's Projects (a person's feedback, the owner's "either
 * alphabetically or most recent ... an elegant toggle"). No cookie is today's
 * order, the server's: oldest project first, a new one at the bottom, so nobody's
 * list changes until they press. The first press goes A to Z, and from then on
 * the button goes between A to Z and most recent, never back to today's order.
 * Nothing else reads this: the project pickers and the Board's filter keep their
 * own orders. Which order is this browser's own choice, kept like the sections'
 * open state (sidebarSections.ts): a cookie through `storage`, never synced, and
 * every sidebar on the page follows it (the docked one, the peek, the phone sheet).
 */
import { useSyncExternalStore } from 'react';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import type { IconName } from './icons';

export const PROJECTS_SORT_COOKIE = 'plannotator-inbox-projects-sort';

export type ProjectSort = 'added' | 'name' | 'recent';

/** What a press can choose: the owner's "either alphabetically or most recent". Today's order is only where a list starts. */
export type ChosenProjectSort = Exclude<ProjectSort, 'added'>;

const SORTS: Readonly<Record<ProjectSort, { icon: IconName; now: string; next: ChosenProjectSort }>> = {
  added: { icon: 'sortList', now: 'Sorted by when added', next: 'name' },
  name: { icon: 'sortAZ', now: 'Sorted A to Z', next: 'recent' },
  recent: { icon: 'sortRecent', now: 'Sorted by most recent', next: 'name' },
};
const PRESS: Readonly<Record<ChosenProjectSort, string>> = { name: 'Sort A to Z', recent: 'Sort by most recent' };

/** The toggle: its icon (the order on screen), its name and tooltip (that order, then what a press does), the next order and what a press says. */
export function projectSortControl(sort: ProjectSort): { icon: IconName; label: string; next: ChosenProjectSort; said: string } {
  const { icon, now, next } = SORTS[sort];
  return { icon, label: `${now}. ${PRESS[next]}`, next, said: `Projects: ${SORTS[next].now}.` };
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

const BY_NAME = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * The projects in the chosen order. `added` is the order they came in. A to Z
 * goes by the name on screen, ignoring case and accents and counting numbers as
 * numbers (`app2` before `app10`). Most recent puts a project with no thread in
 * the list (the one the list still shows after its last was archived) last. A
 * tie keeps the order they came in.
 */
export function sortProjects<P extends { id: string; name: string }>(projects: readonly P[], sort: ProjectSort, activity: ReadonlyMap<string, string> = new Map()): readonly P[] {
  if (sort === 'name') return [...projects].sort((a, b) => BY_NAME.compare(a.name, b.name));
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

/** Chooses the order in every sidebar on the page and remembers it. */
export function setProjectSort(sort: ChosenProjectSort): void {
  storage.setItem(PROJECTS_SORT_COOKIE, sort);
  for (const listener of [...listeners]) listener();
}

export function useProjectSort(): ProjectSort {
  return parseProjectSort(useSyncExternalStore(subscribe, read, () => ''));
}
