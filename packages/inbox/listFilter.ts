/**
 * The list's filter (the owner, 2026-11-08: "the classic filter icon and nothing else in the header under any state.
 * A number badge can show and the filter icon can change color"; `components/ListFilter.tsx` draws it): which threads
 * the list shows, by project (several), by when the thread last changed (Today, the last 7 or 30 days, a range of
 * days) and by agent (several). Each group narrows the list; picks inside one group widen it (billing-svc or web-app).
 *
 * A filter on the list the person reads, never a place: the sidebar's project stays a page of its own (its title, its
 * counts), so on a project's page the Project picks step aside and come back on Inbox. The sidebar's counts never
 * follow the filter; they count what waits on the person.
 *
 * Remembered per browser, as the list's view is (listView.ts): a cookie through `storage`, removed when nothing is
 * picked, never on the server. "Last 7 days" rolls forward with the days; a range keeps its days.
 *
 * Pull requests (shipping with PR linking, branch feat/inbox-pr-linking): Open, Draft, Merged, Closed, Has a PR, No PR,
 * several, read through `rowPullStates`. The group waits behind `LIST_FILTER_PULLS` until both land: off, it is
 * neither drawn nor read, and a remembered pick of it is ignored.
 *
 * This file holds no routes or server calls, so another host can share the rule.
 */
import { useSyncExternalStore } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { agentName } from './tags';

/** The Pull request group: off until PR linking (the list rows' `pulls`) and this filter land together. */
export const LIST_FILTER_PULLS = false;

let pullsOn: boolean = LIST_FILTER_PULLS;
/** Whether the Pull request group is drawn and read. */
export function listFilterPullsOn(): boolean {
  return pullsOn;
}
/** Tests only: the group on (or back to `LIST_FILTER_PULLS`). */
export function setListFilterPullsForTests(on: boolean | null): void {
  pullsOn = on ?? LIST_FILTER_PULLS;
}

/**
 * A coupled PR's state as the list row carries it (PR linking's `InboxThreadPullState`, core/inbox-thread-pulls.ts on
 * feat/inbox-pr-linking). Mirrored here until that branch lands; then import it.
 */
export type ListPullState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

/**
 * The row's PRs' states, or [] for none: the adapter between the list row and this filter. PR linking's row carries
 * `pulls?: { count, headline: { key, state } }` (`InboxThreadPullsSummary`): how many, and the one the row's mark
 * shows (the PR still in play, else the last). Only the headline's state is on the row, so a thread is "Open" when
 * the PR its row shows is open. STUB until feat/inbox-pr-linking is merged: read structurally, typed here.
 */
export function rowPullStates(row: InboxListRow): ListPullState[] {
  const pulls = (row as InboxListRow & { pulls?: { count: number; headline: { key: string; state: ListPullState } } | null }).pulls;
  if (!pulls || pulls.count <= 0) return [];
  return [pulls.headline.state];
}

/** The Pull request group's picks: a state, any PR, or none. */
export type PullPick = 'open' | 'draft' | 'merged' | 'closed' | 'any' | 'none';
const PULL_PICKS: readonly PullPick[] = ['open', 'draft', 'merged', 'closed', 'any', 'none'];
/** The menu's words, in order. */
export const PULL_OPTIONS: ReadonlyArray<{ value: PullPick; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'any', label: 'Has a PR' },
  { value: 'none', label: 'No PR' },
];

/** The row keeps a Pull request pick: its PR's state, any PR, or none. */
export function rowPullMatches(row: InboxListRow, pick: PullPick): boolean {
  const states = rowPullStates(row);
  if (pick === 'none') return states.length === 0;
  if (pick === 'any') return states.length > 0;
  return states.includes(pick);
}

export const LIST_FILTER_COOKIE = 'plannotator-inbox-list-filter';

/** A day as `YYYY-MM-DD`, in the window's own time zone. */
export type LocalDay = string;
export type UpdatedPick = 'today' | '7d' | '30d' | { from: LocalDay; to: LocalDay };

export interface ListFilter {
  /** Project ids; empty: every project. */
  projects: readonly string[];
  updated: UpdatedPick | null;
  /** Agents by their names (`agentName`); empty: every agent. */
  agents: readonly string[];
  /** Pull request picks; empty: every thread. Read only while `listFilterPullsOn()`. */
  pulls: readonly PullPick[];
}

export const NO_LIST_FILTER: ListFilter = { projects: [], updated: null, agents: [], pulls: [] };

/** The menu's words for the three set spans, in order; "Custom range…" follows them. */
export const UPDATED_OPTIONS: ReadonlyArray<{ value: 'today' | '7d' | '30d'; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

/**
 * The picks that apply where the list is: on a project's page (`scoped`) its Project picks step aside. How many of
 * them there are is the header's badge: one per ticked row of the menu.
 */
export function appliedFilter(filter: ListFilter, scoped: boolean): ListFilter {
  return scoped && filter.projects.length > 0 ? { ...filter, projects: [] } : filter;
}

export function pickCount(filter: ListFilter): number {
  return filter.projects.length + filter.agents.length + (filter.updated ? 1 : 0) + (pullsOn ? filter.pulls.length : 0);
}

/** Midnight of `day` (local), as ms. */
function dayStart(day: LocalDay): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/** The local day of a time, `YYYY-MM-DD`. */
export function localDay(ms: number): LocalDay {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * The span a pick keeps, as [from, to) in ms: Today from this midnight; the last 7 days from the midnight six days
 * before (today and the six before it), 30 the same; a range from its first day's midnight to the end of its last.
 * Calendar days, so a clock change is still one day.
 */
export function updatedSpan(pick: UpdatedPick, now: number): [number, number] {
  if (typeof pick !== 'string') {
    const [a, b] = pick.from <= pick.to ? [pick.from, pick.to] : [pick.to, pick.from];
    const end = new Date(dayStart(b));
    end.setDate(end.getDate() + 1);
    return [dayStart(a), end.getTime()];
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (pick !== 'today') start.setDate(start.getDate() - (pick === '7d' ? 6 : 29));
  return [start.getTime(), Infinity];
}

/** The row's agents by name, as its tiles group them: every session when several, else its one agent. */
export function rowAgentNames(row: Pick<InboxListRow, 'participants' | 'author' | 'addressee'>): string[] {
  const sessions =
    row.participants && row.participants.length > 0
      ? row.participants.map((p) => p.host)
      : // The row's one agent (InboxList's `rowAgent`): the addressee of a thread the person started, else the author.
        [row.addressee ? row.addressee.host : row.author.kind === 'agent' ? (row.author.host ?? null) : null];
  return [...new Set(sessions.filter((host): host is string => !!host).map((host) => agentName(host)))];
}

/** The row's host for an agent name (the menu's mark). */
export function agentHost(row: Pick<InboxListRow, 'participants' | 'author' | 'addressee'>, name: string): string | null {
  const hosts = row.participants && row.participants.length > 0 ? row.participants.map((p) => p.host) : [row.addressee ? row.addressee.host : row.author.kind === 'agent' ? (row.author.host ?? null) : null];
  return hosts.find((host) => !!host && agentName(host) === name) ?? null;
}

type Group = 'projects' | 'updated' | 'agents' | 'pulls';

/** The row is shown under `filter`; `skip` leaves one group out (a menu row's count: the other groups' picks). */
export function rowMatches(row: InboxListRow, filter: ListFilter, now: number, skip?: Group): boolean {
  if (skip !== 'projects' && filter.projects.length > 0 && !filter.projects.includes(row.project.id)) return false;
  if (skip !== 'updated' && filter.updated) {
    const [from, to] = updatedSpan(filter.updated, now);
    const at = Date.parse(row.last_at);
    if (!(at >= from && at < to)) return false;
  }
  if (skip !== 'agents' && filter.agents.length > 0 && !rowAgentNames(row).some((name) => filter.agents.includes(name))) return false;
  if (pullsOn && skip !== 'pulls' && filter.pulls.length > 0 && !filter.pulls.some((pick) => rowPullMatches(row, pick))) return false;
  return true;
}

/**
 * The sections the list draws under the filter: each group keeps its place and only its matching rows, so Smart
 * groups count the matches and a group left with none is not drawn (InboxList draws only groups with rows).
 * Nothing picked: the same sections, untouched.
 */
export function filterListSections(sections: readonly InboxListSection[], filter: ListFilter, now: number): InboxListSection[] {
  if (pickCount(filter) === 0) return sections as InboxListSection[];
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => rowMatches(row, filter, now)) }));
}

/** How many rows a menu row would leave: that row's rule with the other groups' picks. */
export function countWhere(rows: readonly InboxListRow[], filter: ListFilter, now: number, group: Group, test: (row: InboxListRow) => boolean): number {
  let n = 0;
  for (const row of rows) if (rowMatches(row, filter, now, group) && test(row)) n += 1;
  return n;
}

export const toggled = (list: readonly string[], value: string): string[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

// ---- remembered per browser ----

const isDay = (v: unknown): v is LocalDay => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200).slice(0, 100) : []);

/** The cookie's value as a filter; anything it cannot read is no filter. */
export function parseListFilter(raw: string | null): ListFilter {
  if (!raw) return NO_LIST_FILTER;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const u = value.updated as unknown;
    const updated: UpdatedPick | null =
      u === 'today' || u === '7d' || u === '30d' ? u : u && typeof u === 'object' && isDay((u as { from?: unknown }).from) && isDay((u as { to?: unknown }).to) ? { from: (u as { from: string }).from, to: (u as { to: string }).to } : null;
    const pulls = strings(value.pulls).filter((p): p is PullPick => (PULL_PICKS as readonly string[]).includes(p));
    return { projects: strings(value.projects), updated, agents: strings(value.agents), pulls };
  } catch {
    return NO_LIST_FILTER;
  }
}

const listeners = new Set<() => void>();
/** The filter on this page: read from the cookie once, then each pick (a page with no cookies keeps its own). */
let current: ListFilter | null = null;
const read = (): ListFilter => (current ??= parseListFilter(safeGet()));

function safeGet(): string | null {
  try {
    return storage.getItem(LIST_FILTER_COOKIE);
  } catch {
    return null;
  }
}

/** Remember the filter for every list on the page; nothing picked removes the cookie. */
export function writeListFilter(next: ListFilter): void {
  try {
    if (pickCount(next) === 0) storage.removeItem(LIST_FILTER_COOKIE);
    else storage.setItem(LIST_FILTER_COOKIE, JSON.stringify({ projects: next.projects, updated: next.updated, agents: next.agents, pulls: next.pulls }));
  } catch {
    // A page with no cookies: the filter holds until it reloads.
  }
  current = next;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const none = (): ListFilter => NO_LIST_FILTER;
const ignore = () => () => {};
const noChange = () => {};

/** The filter and its setter. `remember` false (the onboarding tour): no filter, nothing read or written. */
export function useListFilter(remember = true): [ListFilter, (next: ListFilter) => void] {
  const filter = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : none, none);
  return [filter, remember ? writeListFilter : noChange];
}

/** Tests only: a fresh page that has read nothing. */
export function resetListFilterForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}
