/**
 * The list as the window draws it, derived from what it holds: the rows the list knows and the held list on screen,
 * the open thread's row, pins and snoozes, the project, machine and agent filters and the person's filter picks,
 * project names and counts, the list's title, and the held "N new" line. Reads only; App holds the state.
 */

import { useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import type { InboxListRow, InboxListSection, InboxThread } from '@plannotator/core/inbox-types';
import { patchedRow, withCombining, withPinPatches } from '../rowActions';
import { filterMachineRows, machineCounts, machineProjectNames } from '../machines';
import { appliedFilter, filterListSections, localDay, pickCount, useListFilter } from '../listFilter';
import { filterSections, heldNotice, listGroups, lookedRow, markHeldRowLooked, showLandsIn, waitingCount, type OpenThread } from '../held';
import { useAgentListFilter } from '../agentsList';
import { filterAgentRows } from '../agents/model';
import { filterTagRows } from '../threadTags';
import { withLiveTagPicks } from '../listFilterTags';
import { routineHold, useRoutineThreads } from '../listFilterRoutines';
import { useRecentActivity } from '../listFilterRecent';
import { leaveRecentView, recentViewSections, recentViewShown, useRecentView, useRecentViewLeaves } from '../listRecentView';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { STRANGERS_MARKUP } from '../selectionToolbar';
import { useRecentActs } from '../recentActs';
import { listCovered } from './focus';
import type { ListSort } from '../listView';
import { useThreadTagsHost } from '../useThreadTagsHost';
import { projectsWithReadable, shownProjects } from '../projectMenu';
import { projectActivity } from '../projectSort';
import { heldLines } from '../heldLines';
import { listProjectOf, type Route } from './route';
import type { RowWrites } from '../data/actions/rows';
import type { ListModel, ProjectFolder } from '../api';
import type { MachinesModel } from '../machines';

export interface ListViewInputs {
  latest: ListModel | null;
  projects: ProjectFolder[];
  route: Route;
  thread: InboxThread | null;
  threadRow: InboxListRow | null;
  rowPatches: RowWrites['patches'];
  /** Threads in a Combine still waiting for its new thread (useCombines.ts): their rows say "Combining…". */
  combining?: ReadonlyMap<string, string>;
  pinPatches: RowWrites['pins'];
  looking: ReadonlySet<string>;
  shown: InboxListSection[] | null;
  machines: MachinesModel;
  hideAway: boolean;
  openedHere: { readonly current: Set<string> };
  heldOpen: () => OpenThread | null;
  heldRead: ReadonlySet<string>;
  /** When the list on screen was last sorted whole (App's): Recent activity's order holds between them. */
  listSort: ListSort;
  tags: Omit<Parameters<typeof useThreadTagsHost>[0], 'routeTag' | 'machines' | 'windowRows' | 'openRow' | 'latestSections' | 'tagColours' | 'projects'>;
}

export function useListShown({ latest, projects, route, thread, threadRow, rowPatches, pinPatches, looking, shown, machines, hideAway, openedHere, heldOpen, heldRead, listSort, tags, combining }: ListViewInputs) {
  // What this window tells the server for Recent activity: the person's opens and films (recentActs.ts).
  useRecentActs();
  const latestSections = latest?.sections ?? [];
  // Every row the list knows, the Snoozed band's too: only counts read `latestSections`, which has none of those.
  const latestGroups = useMemo(() => (latest ? listGroups(latest) : []), [latest]);
  const latestRows = useMemo(() => new Map(latestGroups.flatMap((section) => section.threads).map((row) => [row.thread_id, row] as const)), [latestGroups]);
  // Pins (approval "inbox-pinned-threads"): an older Inbox sends no `pins`, so no Pinned section and no pin anywhere.
  const pinsOn = latest?.pins !== undefined;
  const pinRows = latest?.pins;
  const pinnedIds = useMemo(() => withPinPatches(new Set((pinRows ?? []).map((pin) => pin.thread_id)), pinPatches), [pinRows, pinPatches]);
  // The open thread's row: the list's, else its own read's (an archived thread is not in the list).
  const listedOpenRow = thread
    ? patchedRow(latestRows.get(thread.thread_id) ?? (threadRow?.thread_id === thread.thread_id ? threadRow : null), rowPatches)
    : null;
  // Its opening look on its way: read as looked at, as its row on the list is (`listShown`).
  const openThreadRow = listedOpenRow && looking.has(listedOpenRow.thread_id) ? lookedRow(listedOpenRow) : listedOpenRow;
  /** The list on screen as drawn: the held list, the row whose look is on its way read as looked at. */
  const listShown = useMemo(() => withCombining(shown && looking.size > 0 ? markHeldRowLooked(shown, looking) : shown, combining), [shown, looking, combining]);
  // Snoozes: an older Inbox sends no `snoozed`, so no Snooze anywhere. Pins' rule for another machine does not apply:
  // a snooze lives on the thread's home machine and goes there through the forward and the outbox, so a linked
  // machine's row offers it only when that machine keeps snoozes too (`rowSnoozes`).
  const snoozeOn = latest?.snoozed !== undefined;
  /** The projects where Mark all as read has something to do. */
  const projectsReadable = useMemo(() => projectsWithReadable(latestSections), [latestSections]);
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) counts.set(project.id, waitingCount(latestSections, project.id));
    return counts;
  }, [projects, latestSections]);
  const latestProjectActivity = useMemo(() => projectActivity(latestGroups), [latestGroups]);
  const filterProject = route.page === 'inbox' && route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  // The project the sidebar keeps while its list shows (Sidebar's `held`: its page is the Inbox, not a card's thread).
  const sidebarKeeps = (route.page === 'inbox' || route.page === 'tour') && !(route.page === 'inbox' && route.thread && route.card) ? route.project : null;
  // One name per project for the whole window (windowProjectNames): the sidebar, the rows, the pins, the list's
  // title and "N new in …" all read it, so the held list and the live sidebar never name a project two ways.
  // Linked machines: the machine the list shows (the sidebar's Machines filter), and a project of another machine
  // named with that machine ("billing-svc · MacBook") wherever the list shows more than one machine.
  const filterMachine = route.page === 'inbox' && route.machine ? (machines.all.find((m) => m.id === route.machine) ?? null) : null;
  /** Every row the window has (every section, the snoozed too): where an agent's threads are found. */
  const windowRows = useMemo(() => (latest ? [...latest.sections.flatMap((section) => section.threads), ...(latest.snoozed ?? [])] : []), [latest]);
  const threadAgentContext = useMemo(() => ({ rows: windowRows, machines }), [windowRows, machines]);
  // The Agents section's filter (`#agent=<id>`): one agent's threads, named by its row's name.
  const filterAgent = useAgentListFilter(route.page === 'inbox' ? (route.agent ?? null) : null, machines, windowRows);
  const { tagsOfRow, filterTagsOfRow, filterTag, shownTagId, threadTagsHost, sidebarTags, listColours } = useThreadTagsHost({ ...tags, routeTag: route.page === 'inbox' ? (route.tag ?? null) : null, machines, windowRows, openRow: threadRow, latestSections, tagColours: latest?.tag_colours ?? null, projects });
  const projectNames = useMemo(
    () => machineProjectNames({ projects, sidebar: shownProjects(projects, sidebarKeeps), sections: shown ?? [], pins: pinRows }, machines, !filterMachine),
    [projects, sidebarKeeps, shown, pinRows, machines, filterMachine],
  );
  /** The sidebar's Machines counts: rows waiting on the person per machine, as Projects counts them. */
  const sidebarMachineCounts = useMemo(() => machineCounts(latestSections, machines), [latestSections, machines]);
  const listProject = listProjectOf(route);
  const filterList = useCallback(
    (sections: readonly InboxListSection[]) =>
      filterTagRows(filterAgentRows(filterMachineRows(filterSections(sections, listProject), machines, filterMachine?.id ?? null, hideAway), filterAgent, machines.self), shownTagId, tagsOfRow),
    [listProject, machines, filterMachine, filterAgent, hideAway, shownTagId, tagsOfRow],
  );
  // The list's filter (listFilter.ts): this browser's picks; on a project's page its Project picks step aside, on a
  // tag's list its Tag picks. The day is in the keys so Today and the last N days move on at midnight.
  const [listFilterPicks, setListFilter] = useListFilter();
  const listFilterScoped = listProject !== null;
  const listFilterDay = localDay(Date.now());
  // Until the list is read its tags are not known: the Tag picks hold (no moment of unfiltered rows).
  const listTags = latest ? tags.listTags : undefined;
  // Routines (listFilterRoutines.ts): off, the Routine picks step aside; not read yet, a saved Routine pick holds the
  // list (no row drawn, never a moment of unfiltered rows); read, they apply.
  const routines = useRoutineThreads();
  const listFilterApplied = useMemo(
    () => withLiveTagPicks(appliedFilter(listFilterPicks, listFilterScoped, filterTag !== null, routines.state !== 'off'), listTags),
    [listFilterPicks, listFilterScoped, filterTag, listTags, routines.state],
  );
  const routineTest = routines.state === 'ready' ? routines.test : undefined;
  /** A saved Routine pick while the routines are not read: the list waits, drawing no row and no empty words. */
  const listHeld = routineHold(routines, listFilterApplied);
  // Recent activity, a view of this list (listRecentView.ts; not a filter, kept nowhere): one list, newest first by
  // when the person last acted (listFilterRecent.ts), within the filter's picks, its rows and places as of the last
  // whole sort. Leaving this list ends it. Back to a list the thread covered sorts it whole too (`useCoveredBacks`).
  const viewPlace = listPlaceOf(route);
  useRecentViewLeaves(viewPlace);
  const recentView = useRecentView(viewPlace);
  const recent = useRecentActivity(recentView, listSort, route.page === 'inbox' ? (route.thread ?? null) : null, listCovered);
  const recentHeld = (listed: InboxListSection[]) => {
    const kept = filterListSections(listed, listFilterApplied, Date.now(), heldRead, filterTagsOfRow, routineTest);
    return recent.held ? recentViewSections(listed, kept, recent.held, Date.now()) : kept;
  };
  /** The list as the person reads it: `filterList`, then the filter. "N new" and the rows read this. */
  const filterShown = useCallback(
    (sections: readonly InboxListSection[]) =>
      // The Tag picks keep a thread tagged itself or in a tagged project (projectTags.ts).
      listHeld ? filterList(sections).map((section) => ({ ...section, threads: [] })) : recentHeld(filterList(sections)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the day: a new one reads the spans again.
    [filterList, listFilterApplied, listFilterDay, heldRead, filterTagsOfRow, routineTest, listHeld, recent.held],
  );
  /** The sort InboxList reads: Recent activity's places while it is on, which also draws List's one list whatever the view. */
  const listSortShown = recent.sort;
  /** The rows before the filter: its menu's counts and choices. */
  const listFilterRows = useMemo(() => {
    const drawn = listShown ?? shown;
    return drawn ? filterList(drawn).flatMap((section) => section.threads) : [];
  }, [listShown, shown, filterList]);
  /** The list's sections as drawn, kept between renders that change none of it (InboxList's List memo reads them). */
  const listSections = useMemo(() => {
    const drawn = listShown ?? shown;
    return drawn ? filterShown(drawn) : null;
  }, [listShown, shown, filterShown]);
  /** The filter's picks alone, before Recent activity's view (null while it is off: `listSections` is that). */
  const pickedSections = useMemo(() => {
    const drawn = listShown ?? shown;
    return recentView && drawn && !listHeld ? filterListSections(filterList(drawn), listFilterApplied, Date.now(), heldRead, filterTagsOfRow, routineTest) : null;
  }, [recentView, listShown, shown, listHeld, filterList, listFilterApplied, heldRead, filterTagsOfRow, routineTest]);
  /** The filter left no row where the list holds some (the Snoozed band aside): "No threads match". */
  const listFilterEmpty = !listHeld && pickCount(listFilterApplied) > 0 && listSections !== null && noRows(pickedSections ?? listSections) && listFilterRows.some((row) => !row.snoozed);
  /** Recent activity's view left no row (the filter's picks did): its own words. */
  const recentEmpty = recentView && !listHeld && !listFilterEmpty && listSections !== null && noRows(listSections);
  // The list's name: Inbox, or the project's window name (or the machine's, or the agent's); its back buttons read the same.
  const listTitle = filterProject ? (projectNames.get(filterProject.id) ?? filterProject.name) : filterMachine ? filterMachine.name : filterAgent ? filterAgent.name : filterTag ? filterTag.name : 'Inbox';
  const heldNews = shown && latest ? heldNotice(filterShown(shown), filterShown(latestGroups), openedHere.current, heldOpen(), projectNames) : null;
  // What the line says (heldLines.ts): what came here, and in a project or filter view what came elsewhere.
  const scoped = listProject !== null || !!filterMachine || !!filterAgent || !!shownTagId;
  const lines = shown && latest ? heldLines({ shown, latest: latestGroups, view: filterShown, scope: scoped ? filterList : null, openedHere: openedHere.current, open: heldOpen(), names: projectNames }) : null;
  // Show opens the groups the rows it brings in land in (held.ts showLandsIn), so they are on screen.
  const notice =
    shown && ((heldNews?.text && lines?.here) || lines?.elsewhere)
      ? {
          count: heldNews?.text ? heldNews.count : 0,
          project: heldNews?.project ?? null,
          lands: showLandsIn(filterShown(shown), filterShown(latestGroups)),
          here: heldNews?.text ? (lines?.here ?? null) : null,
          elsewhere: lines?.elsewhere ?? null,
        }
      : null;
  return { recentEmpty, listSortShown, latestSections, latestGroups, latestRows, pinsOn, pinRows, pinnedIds, listedOpenRow, openThreadRow, listShown, snoozeOn, projectsReadable, projectCounts, latestProjectActivity, filterProject, filterMachine, windowRows, threadAgentContext, filterAgent, projectNames, sidebarMachineCounts, filterList, listFilterPicks, setListFilter, listFilterScoped, filterShown, listFilterRows, listSections, listFilterEmpty, listHeld, listTitle, notice, tagsOfRow, filterTag, threadTagsHost, sidebarTags, listColours };
}

/** No row outside the Snoozed band. */
const noRows = (sections: readonly InboxListSection[]) => sections.every((section) => section.id === 'snoozed' || section.threads.length === 0);

/**
 * The list on screen, for Recent activity's view (listRecentView.ts): the sidebar's project, machine, agent and tag, as
 * App names it for the filter (its `place`); null where no Inbox list shows (another page, Reviews, a Board card's thread).
 */
export function listPlaceOf(route: Route): string | null {
  return route.page === 'inbox' && !route.reviews && !route.card ? [route.project, route.machine, route.agent, route.tag].join('\n') : null;
}

/** A layer anywhere on the page (a dialog, a menu, a listbox, the Customize sidebar panel): its Escape, while it shows. */
const LAYERS = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sidebar-customizer]';
/**
 * Never a layer by being on the page: a message body's raw HTML; anything hidden or inert; a floating reply or Ask AI
 * window, long-lived and not modal (its Escape is its own only with focus in it: `inOverlay`).
 */
const NOT_LAYERS = `${STRANGERS_MARKUP}, [hidden], [inert], [data-chat-window]:not([aria-modal="true"])`;

/**
 * The layer shows: not in a closed <dialog> (search's palette and Decision mode stay mounted closed), not display:none
 * on it or above it (a layer hidden by its class). Read from the tree and styles, not layout boxes, so it holds alike
 * in a test's DOM.
 */
function layerShows(layer: Element): boolean {
  if (layer.closest(NOT_LAYERS)) return false;
  for (let el: Element | null = layer; el; el = el.parentElement) {
    if (el.tagName === 'DIALOG' && !el.hasAttribute('open')) return false;
    if (getComputedStyle(el).display === 'none') return false;
  }
  return getComputedStyle(layer).visibility !== 'hidden';
}

/**
 * Something else may own this Escape: a field, a layer showing anywhere (some listen on the window after App, so they
 * never get to mark the key used first), or a popup open from where focus is (a tooltip).
 */
function escapeOwnedElsewhere(from: Element | null): boolean {
  if (modalOpen()) return true;
  if (from && (isEditableTarget(from) || inOverlay(from) || from.closest('[aria-expanded="true"], [data-popup-open]'))) return true;
  return [...document.querySelectorAll(LAYERS)].some(layerShows);
}

/**
 * Escape's last rung on the Inbox list (App's ladder, after an open thread closes; no shortcut of its own): Recent
 * activity's view goes. Not while something else may own the key or used it already, and not on a held key's repeats
 * (the press that closed a thread runs on no further). Focus that the swap back to the groups would drop goes to the
 * same thread's row where they draw it, else to the filter button.
 */
export function leaveRecentViewOnEscape(event: KeyboardEvent, route: Route): void {
  if (event.key !== 'Escape' || !recentViewShown() || listPlaceOf(route) === null || route.thread || route.file) return;
  if (event.defaultPrevented || event.repeat || isComposingKey(event)) return;
  const from = keyTarget(event);
  if (escapeOwnedElsewhere(from)) return;
  event.preventDefault();
  const column = from?.closest('.ib-listcol') ?? null;
  const row = from?.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? null;
  // Drawn now, so focus can follow before the frame paints.
  flushSync(leaveRecentView);
  if (!column || (from?.isConnected && document.activeElement === from)) return;
  // The list draws some rows twice (the wide and the three-line row), one hidden: the one on screen.
  const rows = row ? [...column.querySelectorAll<HTMLElement>(`.ib-lbody [data-thread-id="${CSS.escape(row)}"]`)] : [];
  const again = rows.find((el) => el.getClientRects().length > 0) ?? rows.find((el) => getComputedStyle(el).display !== 'none');
  (again ?? column.querySelector<HTMLElement>('[data-list-filter]'))?.focus();
}
