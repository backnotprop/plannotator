/**
 * Pinned and Projects open and close like folders (owner's pick, direction C
 * "The section is the folder", 2026-10-29). Which ones are closed is this
 * browser's own choice, kept like the sidebar's open state and width: a
 * cookie through `storage`, so it survives a restart on another port and a
 * phone and the Mac decide separately. No cookie: both open. Not a server
 * setting, never synced.
 */
import { useState, useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const SIDEBAR_CLOSED_COOKIE = 'plannotator-inbox-sidebar-closed';

export type SidebarSection = 'pinned' | 'projects';
const SECTIONS: readonly SidebarSection[] = ['pinned', 'projects'];

/** The cookie's value ("pinned", "projects", "pinned,projects") as the closed sections; anything else is ignored. */
export function parseClosedSections(raw: string | null): ReadonlySet<SidebarSection> {
  const named = new Set((raw ?? '').split(','));
  return new Set(SECTIONS.filter((section) => named.has(section)));
}

const listeners = new Set<() => void>();
const read = () => storage.getItem(SIDEBAR_CLOSED_COOKIE) ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Opens or closes one section in every sidebar on the page (the docked one, the peek, the phone sheet) and remembers it. */
export function setSidebarSectionOpen(section: SidebarSection, open: boolean): void {
  const closed = new Set(parseClosedSections(read()));
  if (open) closed.delete(section);
  else closed.add(section);
  const value = SECTIONS.filter((name) => closed.has(name)).join(',');
  if (value) storage.setItem(SIDEBAR_CLOSED_COOKIE, value);
  else storage.removeItem(SIDEBAR_CLOSED_COOKIE);
  for (const listener of [...listeners]) listener();
}

/**
 * The sections' state for one sidebar. `remember: false` (the onboarding
 * tour's sidebar) ignores the cookie: both start open, and a toggle there is
 * the tour's own and is not kept.
 */
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
