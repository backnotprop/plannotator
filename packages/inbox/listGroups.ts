import { useState, useSyncExternalStore } from 'react';
import type { InboxListGroupId } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';

export const LIST_GROUPS_COOKIE = 'plannotator-inbox-list-groups';

const GROUPS: readonly InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
const CLOSED_BY_DEFAULT: ReadonlySet<InboxListGroupId> = new Set(['quiet', 'snoozed']);
const PAGE_LOADED = Date.now();

export type GroupState = { open: true } | { open: false; since: number };
type Choices = ReadonlyMap<InboxListGroupId, GroupState>;

export function parseListGroups(raw: string | null): Choices {
  const out = new Map<InboxListGroupId, GroupState>();
  for (const token of (raw ?? '').split(',')) {
    const [id, value] = token.split(':') as [InboxListGroupId, string | undefined];
    if (!GROUPS.includes(id) || value === undefined) continue;
    if (value === 'open') out.set(id, { open: true });
    else if (/^\d+$/.test(value)) out.set(id, { open: false, since: Number(value) });
  }
  return out;
}

function formatListGroups(choices: Choices): string {
  return GROUPS.flatMap((id) => {
    const state = choices.get(id);
    return state ? [`${id}:${state.open ? 'open' : state.since}`] : [];
  }).join(',');
}

export function groupState(choices: Choices, id: InboxListGroupId): GroupState {
  return choices.get(id) ?? (CLOSED_BY_DEFAULT.has(id) ? { open: false, since: PAGE_LOADED } : { open: true });
}

const listeners = new Set<() => void>();
let written: string | null = null;
const read = () => storage.getItem(LIST_GROUPS_COOKIE) ?? written ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function write(next: Choices): void {
  const value = formatListGroups(next);
  if (value) storage.setItem(LIST_GROUPS_COOKIE, value);
  else storage.removeItem(LIST_GROUPS_COOKIE);
  written = (storage.getItem(LIST_GROUPS_COOKIE) ?? '') === value ? null : value;
  for (const listener of [...listeners]) listener();
}

function toggled(choices: Choices, id: InboxListGroupId, now: number): Map<InboxListGroupId, GroupState> {
  const next = new Map(choices);
  if (groupState(choices, id).open) next.set(id, { open: false, since: now });
  else if (CLOSED_BY_DEFAULT.has(id)) next.set(id, { open: true });
  else next.delete(id);
  return next;
}

export function useListGroups(remember = true): {
  state: (id: InboxListGroupId) => GroupState;
  toggle: (id: InboxListGroupId) => void;
  reset: (id: InboxListGroupId) => void;
  open: (ids: readonly InboxListGroupId[]) => void;
} {
  const raw = useSyncExternalStore(subscribe, read, () => '');
  const [local, setLocal] = useState<Choices>(() => new Map());
  const choices = remember ? parseListGroups(raw) : local;
  return {
    state: (id) => groupState(choices, id),
    toggle: (id) => {
      if (remember) return write(toggled(parseListGroups(read()), id, Date.now()));
      setLocal((last) => toggled(last, id, Date.now()));
    },
    reset: (id) => {
      if (remember) {
        const now = parseListGroups(read());
        if (!now.has(id)) return;
        const next = new Map(now);
        next.delete(id);
        return write(next);
      }
      setLocal((last) => {
        if (!last.has(id)) return last;
        const next = new Map(last);
        next.delete(id);
        return next;
      });
    },
    open: (ids) => {
      if (remember) {
        const now = parseListGroups(read());
        const next = opened(now, ids);
        if (next !== now) write(next);
        return;
      }
      setLocal((last) => opened(last, ids));
    },
  };
}

function opened(choices: Choices, ids: readonly InboxListGroupId[]): Choices {
  let next = choices;
  for (const id of ids) if (!groupState(next, id).open) next = toggled(next, id, Date.now());
  return next;
}

export function resetListGroupsForTests(): void {
  storage.removeItem(LIST_GROUPS_COOKIE);
  written = null;
  for (const listener of [...listeners]) listener();
}
