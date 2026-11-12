import { useState, useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const SIDEBAR_CLOSED_COOKIE = 'plannotator-inbox-sidebar-closed';

export type SidebarSection = 'pinned' | 'agents' | 'projects';
const SECTIONS: readonly SidebarSection[] = ['pinned', 'agents', 'projects'];
const FORMER: Readonly<Record<string, SidebarSection>> = { machines: 'agents' };

export function parseClosedSections(raw: string | null): ReadonlySet<SidebarSection> {
  const named = new Set((raw ?? '').split(',').map((name) => FORMER[name] ?? name));
  return new Set(SECTIONS.filter((section) => named.has(section)));
}

const listeners = new Set<() => void>();
const read = () => storage.getItem(SIDEBAR_CLOSED_COOKIE) ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setSidebarSectionOpen(section: SidebarSection, open: boolean): void {
  const closed = new Set(parseClosedSections(read()));
  if (open) closed.delete(section);
  else closed.add(section);
  const value = SECTIONS.filter((name) => closed.has(name)).join(',');
  if (value) storage.setItem(SIDEBAR_CLOSED_COOKIE, value);
  else storage.removeItem(SIDEBAR_CLOSED_COOKIE);
  for (const listener of [...listeners]) listener();
}

export function useSidebarSections(remember = true): { closed: (section: SidebarSection) => boolean; toggle: (section: SidebarSection) => void } {
  const raw = useSyncExternalStore(subscribe, read, () => '');
  const [local, setLocal] = useState<ReadonlySet<SidebarSection>>(() => new Set());
  const closed = remember ? parseClosedSections(raw) : local;
  return {
    closed: (section) => closed.has(section),
    toggle: (section) => {
      if (remember) return setSidebarSectionOpen(section, closed.has(section));
      setLocal((last) => {
        const next = new Set(last);
        if (next.has(section)) next.delete(section);
        else next.add(section);
        return next;
      });
    },
  };
}
