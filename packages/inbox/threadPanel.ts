/**
 * The thread panel view (the owner, 2026-11-01): the list keeps the short width it has beside a thread and the
 * thread's pane stays on the right with no thread open, showing EmptyThreadPanel until one is. A choice in the
 * list's ⋮ menu, off by default, so the wide list stays what every window opens to.
 *
 * Remembered like the list's look options (listLook.ts): per browser, in a cookie through `storage`, "1" while on
 * and removed when off, never on the server. Kept apart from them because it is not a look: the one-time list
 * options dialog does not offer it, and the window's layout reads it, not only the list.
 *
 * A phone shows one screen at a time and a window too narrow for two panes stacks them (stack.ts), so neither ever
 * shows the panel: an empty pane must never stand alone. The choice stays stored and applies once there is room.
 *
 * This file holds no routes or server calls, so another host can share the rule and draw its own two panes.
 */
import { useCallback, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const THREAD_PANEL_COOKIE = 'plannotator-inbox-thread-panel';

/** The ⋮ menu item's words. */
export const THREAD_PANEL_LABEL = 'Keep thread panel open';

/** The remembered choice; anything but "1" (or no cookie) is off. */
export function readThreadPanel(): boolean {
  return storage.getItem(THREAD_PANEL_COOKIE) === '1';
}

/** Remember the choice; off removes the cookie, so an untouched browser carries none. */
export function writeThreadPanel(on: boolean): void {
  if (on) storage.setItem(THREAD_PANEL_COOKIE, '1');
  else storage.removeItem(THREAD_PANEL_COOKIE);
}

/** Whether the window draws the panel with no thread open: the choice, where two panes can show side by side. */
export function threadPanelShows(on: boolean, window: { phone: boolean; stacked: boolean }): boolean {
  return on && !window.phone && !window.stacked;
}

/** The choice, read once before the first paint (so a reload never draws the wide list first), and its setter. */
export function useThreadPanel(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readThreadPanel);
  const set = useCallback((next: boolean) => {
    writeThreadPanel(next);
    setOn(next);
  }, []);
  return [on, set];
}
