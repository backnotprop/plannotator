/**
 * The list as the window draws it, derived from what it holds: the rows the list knows and the held list on screen,
 * the open thread's row, pins and snoozes, the project, machine and agent filters and the person's filter picks,
 * project names and counts, the list's title, and the held "N new" line. Reads only; App holds the state.
 */

import { useCallback, useMemo } from 'react';
import type { InboxListRow, InboxListSection, InboxThread } from '@plannotator/core/inbox-types';
import { patchedRow, withPinPatches } from '../rowActions';
import { filterMachineRows, machineCounts, machineProjectNames } from '../machines';
import { appliedFilter, filterListSections, localDay, pickCount, useListFilter } from '../listFilter';
import { filterSections, heldNews as heldNewsOf, heldNotice, listGroups, lookedRow, markHeldRowLooked, showLandsIn, waitingCount, type OpenThread } from '../held';
import { useAgentListFilter } from '../agentsList';
import { filterAgentRows } from '../agents/model';
import { projectsWithReadable, shownProjects } from '../projectMenu';
import { projectActivity } from '../projectSort';
import type { Route } from './route';
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
  pinPatches: RowWrites['pins'];
  looking: ReadonlySet<string>;
  shown: InboxListSection[] | null;
  machines: MachinesModel;
  hideAway: boolean;
  openedHere: { readonly current: Set<string> };
  heldOpen: () => OpenThread | null;
}

export function useListShown({ latest, projects, route, thread, threadRow, rowPatches, pinPatches, looking, shown, machines, hideAway, openedHere, heldOpen }: ListViewInputs) {
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
  const listShown = useMemo(() => (shown && looking.size > 0 ? markHeldRowLooked(shown, looking) : shown), [shown, looking]);
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
  // The Agents section's filter (`#agent=<id>`): one agent's threads, named by its row's name.
  const filterAgent = useAgentListFilter(route.page === 'inbox' ? (route.agent ?? null) : null, machines, windowRows);
  const projectNames = useMemo(
    () => machineProjectNames({ projects, sidebar: shownProjects(projects, sidebarKeeps), sections: shown ?? [], pins: pinRows }, machines, !filterMachine),
    [projects, sidebarKeeps, shown, pinRows, machines, filterMachine],
  );
  /** The sidebar's Machines counts: rows waiting on the person per machine, as Projects counts them. */
  const sidebarMachineCounts = useMemo(() => machineCounts(latestSections, machines), [latestSections, machines]);
  /** One project's rows, then one machine's, then one agent's, then without the machines the person hid while away. */
  const filterList = useCallback(
    (sections: readonly InboxListSection[]) => filterAgentRows(filterMachineRows(filterSections(sections, route.project), machines, filterMachine?.id ?? null, hideAway), filterAgent, machines.self),
    [route.project, machines, filterMachine, filterAgent, hideAway],
  );
  // The list's filter (listFilter.ts): this browser's picks; on a project's page its Project picks step aside. The
  // day is in the keys so Today and the last N days move on at midnight.
  const [listFilterPicks, setListFilter] = useListFilter();
  const listFilterScoped = route.project !== null;
  const listFilterDay = localDay(Date.now());
  const listFilterApplied = useMemo(() => appliedFilter(listFilterPicks, listFilterScoped), [listFilterPicks, listFilterScoped]);
  /** The list as the person reads it: `filterList`, then the filter. "N new" and the rows read this. */
  const filterShown = useCallback(
    (sections: readonly InboxListSection[]) => filterListSections(filterList(sections), listFilterApplied, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the day: a new one reads the spans again.
    [filterList, listFilterApplied, listFilterDay],
  );
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
  /** The filter left no row where the list holds some (the Snoozed band aside): "No threads match". */
  const listFilterEmpty =
    pickCount(listFilterApplied) > 0 &&
    listSections !== null &&
    listSections.every((section) => section.id === 'snoozed' || section.threads.length === 0) &&
    listFilterRows.some((row) => !row.snoozed);
  // The list's name: Inbox, or the project's window name (or the machine's, or the agent's); its back buttons read the same.
  const listTitle = filterProject ? (projectNames.get(filterProject.id) ?? filterProject.name) : filterMachine ? filterMachine.name : filterAgent ? filterAgent.name : 'Inbox';
  const heldNews = shown && latest ? heldNotice(filterShown(shown), filterShown(latestGroups), openedHere.current, heldOpen(), projectNames) : null;
  // Show opens the groups the rows it brings in land in (held.ts showLandsIn), so they are on screen.
  // `news`: the same threads, for the pill at the list's edge while the line is out of view (ListNewPill.tsx).
  const notice =
    heldNews?.text && shown
      ? {
          count: heldNews.count,
          project: heldNews.project ?? null,
          lands: showLandsIn(filterShown(shown), filterShown(latestGroups)),
          news: heldNewsOf(filterShown(shown), filterShown(latestGroups), openedHere.current, heldOpen()),
        }
      : null;
  return { latestSections, latestGroups, latestRows, pinsOn, pinRows, pinnedIds, listedOpenRow, openThreadRow, listShown, snoozeOn, projectsReadable, projectCounts, latestProjectActivity, filterProject, filterMachine, windowRows, filterAgent, projectNames, sidebarMachineCounts, filterList, listFilterPicks, setListFilter, listFilterScoped, filterShown, listFilterRows, listSections, listFilterEmpty, listTitle, notice };
}
