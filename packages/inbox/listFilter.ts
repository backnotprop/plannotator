import { useSyncExternalStore } from 'react';
import type { InboxListRow, InboxListSection, InboxThreadPullState } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { agentName } from './tags';

export function rowPullStates(row: Pick<InboxListRow, 'pulls'>): InboxThreadPullState[] {
  const pulls = row.pulls;
  if (!pulls || pulls.count <= 0) return [];
  return [pulls.headline.state];
}

export type PullPick = 'open' | 'draft' | 'merged' | 'closed' | 'any' | 'none';
const PULL_PICKS: readonly PullPick[] = ['open', 'draft', 'merged', 'closed', 'any', 'none'];
export const PULL_OPTIONS: ReadonlyArray<{ value: PullPick; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'any', label: 'Has a PR' },
  { value: 'none', label: 'No PR' },
];

export function rowPullMatches(row: Pick<InboxListRow, 'pulls'>, pick: PullPick): boolean {
  const states = rowPullStates(row);
  if (pick === 'none') return states.length === 0;
  if (pick === 'any') return states.length > 0;
  return states.includes(pick);
}

export const LIST_FILTER_COOKIE = 'plannotator-inbox-list-filter';

export type LocalDay = string;
export type UpdatedPick = 'today' | '7d' | '30d' | { from: LocalDay; to: LocalDay };

export interface ListFilter {
  projects: readonly string[];
  updated: UpdatedPick | null;
  agents: readonly string[];
  pulls: readonly PullPick[];
}

export const NO_LIST_FILTER: ListFilter = { projects: [], updated: null, agents: [], pulls: [] };

export const UPDATED_OPTIONS: ReadonlyArray<{ value: 'today' | '7d' | '30d'; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export function appliedFilter(filter: ListFilter, scoped: boolean): ListFilter {
  return scoped && filter.projects.length > 0 ? { ...filter, projects: [] } : filter;
}

export function pickCount(filter: ListFilter): number {
  return filter.projects.length + filter.agents.length + (filter.updated ? 1 : 0) + filter.pulls.length;
}

function dayStart(day: LocalDay): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

export function localDay(ms: number): LocalDay {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

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

export function rowAgentNames(row: Pick<InboxListRow, 'participants' | 'author' | 'addressee'>): string[] {
  const sessions =
    row.participants && row.participants.length > 0
      ? row.participants.map((p) => p.host)
      :
        [row.addressee ? row.addressee.host : row.author.kind === 'agent' ? (row.author.host ?? null) : null];
  return [...new Set(sessions.filter((host): host is string => !!host).map((host) => agentName(host)))];
}

export function agentHost(row: Pick<InboxListRow, 'participants' | 'author' | 'addressee'>, name: string): string | null {
  const hosts = row.participants && row.participants.length > 0 ? row.participants.map((p) => p.host) : [row.addressee ? row.addressee.host : row.author.kind === 'agent' ? (row.author.host ?? null) : null];
  return hosts.find((host) => !!host && agentName(host) === name) ?? null;
}

type Group = 'projects' | 'updated' | 'agents' | 'pulls';

export function rowMatches(row: InboxListRow, filter: ListFilter, now: number, skip?: Group): boolean {
  if (skip !== 'projects' && filter.projects.length > 0 && !filter.projects.includes(row.project.id)) return false;
  if (skip !== 'updated' && filter.updated) {
    const [from, to] = updatedSpan(filter.updated, now);
    const at = Date.parse(row.last_at);
    if (!(at >= from && at < to)) return false;
  }
  if (skip !== 'agents' && filter.agents.length > 0 && !rowAgentNames(row).some((name) => filter.agents.includes(name))) return false;
  if (skip !== 'pulls' && filter.pulls.length > 0 && !filter.pulls.some((pick) => rowPullMatches(row, pick))) return false;
  return true;
}

export function filterListSections(sections: readonly InboxListSection[], filter: ListFilter, now: number): InboxListSection[] {
  if (pickCount(filter) === 0) return sections as InboxListSection[];
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => rowMatches(row, filter, now)) }));
}

export function countWhere(rows: readonly InboxListRow[], filter: ListFilter, now: number, group: Group, test: (row: InboxListRow) => boolean): number {
  let n = 0;
  for (const row of rows) if (rowMatches(row, filter, now, group) && test(row)) n += 1;
  return n;
}

export const toggled = (list: readonly string[], value: string): string[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

const isDay = (v: unknown): v is LocalDay => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200).slice(0, 100) : []);

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
let current: ListFilter | null = null;
const read = (): ListFilter => (current ??= parseListFilter(safeGet()));

function safeGet(): string | null {
  try {
    return storage.getItem(LIST_FILTER_COOKIE);
  } catch {
    return null;
  }
}

export function writeListFilter(next: ListFilter): void {
  try {
    if (pickCount(next) === 0) storage.removeItem(LIST_FILTER_COOKIE);
    else storage.setItem(LIST_FILTER_COOKIE, JSON.stringify({ projects: next.projects, updated: next.updated, agents: next.agents, pulls: next.pulls }));
  } catch {
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

export function useListFilter(remember = true): [ListFilter, (next: ListFilter) => void] {
  const filter = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : none, none);
  return [filter, remember ? writeListFilter : noChange];
}

export function resetListFilterForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}
