/**
 * The places the sidebar goes to (Inbox, each tag, each project), read once and shared by the sidebar
 * (components/Sidebar.tsx) and the list title's picker (components/ListPlacePicker.tsx), so the two list the same
 * places in the same order, with the same counts, and a pick in either runs the same handler.
 */
import { useMemo } from 'react';
import type { SidebarProps } from './components/Sidebar';
import type { ProjectFolder } from './api';
import type { Route } from './app/route';
import { shownProjects } from './projectMenu';
import { sortProjects, useProjectSort } from './projectSort';

/** What of the sidebar's props names its places, the one on screen, their counts and where a click goes. */
export type SidebarPlaces = Pick<SidebarProps, 'page' | 'projectId' | 'machineId' | 'agentFilter' | 'tags' | 'inboxCount' | 'projects' | 'projectNames' | 'projectCounts' | 'projectActivity' | 'onInbox' | 'onProject'>;

/** Inbox is the place on screen: the Inbox page, with no project, machine, agent or tag narrowing it. */
export function inboxIsOn(places: Pick<SidebarPlaces, 'page' | 'projectId' | 'machineId' | 'agentFilter' | 'tags'>): boolean {
  return places.page === 'inbox' && places.projectId === null && !places.machineId && !places.agentFilter && !places.tags?.tagId;
}

/**
 * The projects the sidebar lists, in its order (Projects' sort toggle): those with something in the list, and the one
 * the list shows even when it holds nothing; each by the window's one name for it (windowProjectNames, App.tsx).
 */
export function useShownProjects(places: Pick<SidebarPlaces, 'page' | 'projectId' | 'projects' | 'projectNames' | 'projectActivity'>) {
  const held = places.page === 'inbox' ? places.projectId : null;
  const projectSort = useProjectSort();
  // Only most recent reads the activity, so another order does not sort again when a row's time changes.
  const activity = projectSort === 'recent' ? places.projectActivity : undefined;
  const shown = useMemo(
    () => sortProjects(shownProjects(places.projects, held).map((project) => ({ ...project, name: places.projectNames?.get(project.id) ?? project.name })), projectSort, activity),
    [places.projects, places.projectNames, held, projectSort, activity],
  );
  return { shown, projectSort };
}

/**
 * The window's places for its route (App.tsx): what the sidebar draws, and where each of its clicks goes (moved here
 * unchanged from the sidebar's props in App.tsx, so the list title's picker runs the very same handlers).
 */
export function sidebarPlacesOf(at: {
  route: Route;
  /** A Board card's thread is open over the Inbox page: the sidebar marks Board. */
  fromCard: boolean;
  filterMachine: { id: string } | null;
  filterAgent: { id: string; name: string } | null;
  tags: SidebarPlaces['tags'];
  inboxCount: number;
  projects: readonly ProjectFolder[];
  /** This machine's id (machines.ts `self`). */
  self: string | null;
  projectNames: ReadonlyMap<string, string>;
  projectCounts: ReadonlyMap<string, number>;
  projectActivity: ReadonlyMap<string, string>;
  refreshInbox: (scope: string | null, closeThread: boolean) => unknown;
  leave: (to: Route) => void;
}): SidebarPlaces {
  const { route, filterMachine, refreshInbox, leave } = at;
  return {
    page: route.page === 'tour' ? 'inbox' : at.fromCard ? 'board' : route.reviews ? 'reviews' : route.page,
    projectId: route.project,
    machineId: route.page === 'inbox' ? (filterMachine?.id ?? null) : null,
    agentFilter: at.filterAgent ? { id: at.filterAgent.id, name: at.filterAgent.name } : null,
    tags: at.tags,
    inboxCount: at.inboxCount,
    // One machine's list: that machine's projects only.
    projects: filterMachine ? at.projects.filter((p) => (p.machine ?? at.self) === filterMachine.id) : at.projects,
    projectNames: at.projectNames,
    projectCounts: at.projectCounts,
    projectActivity: at.projectActivity,
    // On the list it shows, Inbox (or a project) refreshes; with a thread open it closes it as before, and refreshes.
    onInbox: () => (route.page === 'inbox' && route.project === null && !route.machine && !route.agent && !route.tag ? void refreshInbox(null, route.thread !== null) : leave({ page: 'inbox', project: null, thread: null })),
    onProject: (projectId) =>
      route.page === 'inbox' && route.project === projectId ? void refreshInbox(projectId, route.thread !== null) : route.page === 'plans' ? leave({ page: 'plans', project: projectId, thread: null }) : leave({ page: 'inbox', project: projectId, machine: filterMachine?.id ?? null, thread: null }),
  };
}
