import { useSyncExternalStore } from 'react';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import type { IconName } from './icons';

export const PROJECTS_SORT_COOKIE = 'plannotator-inbox-projects-sort';

export type ProjectSort = 'added' | 'name' | 'recent';

export type ChosenProjectSort = Exclude<ProjectSort, 'added'>;

const SORTS: Readonly<Record<ProjectSort, { icon: IconName; now: string; next: ChosenProjectSort }>> = {
  added: { icon: 'sortList', now: 'Sorted by when added', next: 'name' },
  name: { icon: 'sortAZ', now: 'Sorted A to Z', next: 'recent' },
  recent: { icon: 'sortRecent', now: 'Sorted by most recent', next: 'name' },
};
const PRESS: Readonly<Record<ChosenProjectSort, string>> = { name: 'Sort A to Z', recent: 'Sort by most recent' };

export function projectSortControl(sort: ProjectSort): { icon: IconName; label: string; next: ChosenProjectSort; said: string } {
  const { icon, now, next } = SORTS[sort];
  return { icon, label: `${now}. ${PRESS[next]}`, next, said: `Projects: ${SORTS[next].now}.` };
}

export function parseProjectSort(raw: string | null): ProjectSort {
  return raw === 'name' || raw === 'recent' ? raw : 'added';
}

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

export function setProjectSort(sort: ChosenProjectSort): void {
  storage.setItem(PROJECTS_SORT_COOKIE, sort);
  for (const listener of [...listeners]) listener();
}

export function useProjectSort(): ProjectSort {
  return parseProjectSort(useSyncExternalStore(subscribe, read, () => ''));
}
