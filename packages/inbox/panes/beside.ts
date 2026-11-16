import { createContext, useContext, useEffect, useState } from 'react';
import type { SettingsModel } from '../api';
import { THREAD_BESIDE_FILE_WIDTH, paneGutters } from '../stack';
import { listAndThreads } from './sidebarHold';
import type { WindowPanes } from './useRoutePanes';

/**
 * "Open beside" (config.json `inboxSplitView`, off unless turned on; no Settings row): a thread opens in a second pane
 * next to the one open, the two sharing the room beside the list (the list's edge hides it, as for one thread, and
 * they take the window; a docked sidebar without room folds while the two are open). The rows' menu reads it from
 * here, so no list or menu takes a prop for it.
 */
export interface Beside {
  /** "Open beside" is offered for `threadId`: another thread is open, there is room, and only one pane shows. */
  offers: (threadId: string) => boolean;
  open: (threadId: string) => void;
}

export const BesideContext = createContext<Beside | null>(null);

export const useBeside = (): Beside | null => useContext(BesideContext);

/**
 * The narrowest window two thread panes fit with nothing beside them: two of the narrowest thread columns the window
 * draws (a thread beside a file, stack.ts) and the gutters around and between them. 904 px with the Soft look's 8 px
 * gutters. Narrower, a pair goes back to one pane.
 */
export const besideRoom = (gutters: number): number => 2 * THREAD_BESIDE_FILE_WIDTH + gutters;

/**
 * Whether the list and two threads fit in the window with the sidebar folded: the list's narrowest column, two 440 px
 * threads and the gutters, 1292 px with the Soft look's. Only then is "Open beside" offered. A docked sidebar that
 * leaves too little room folds on screen when the item is chosen (panes/sidebarHold.ts) and comes back when the second
 * pane closes; a pair that loses its room later (the person opens the sidebar, the window narrows) covers the list, as
 * one thread does.
 */
export function besideFits(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= listAndThreads(2);
}

/** Whether the window is wide enough for two panes now, following its width. */
export function useBesideRoom(): boolean {
  const fits = () => typeof window !== 'undefined' && window.innerWidth >= besideRoom(paneGutters());
  const [room, setRoom] = useState(fits);
  useEffect(() => {
    const measure = () => setRoom(fits());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return room;
}

/** The switch as the settings read sends it (server: inbox.ts, present only while on). */
export const splitViewOn = (settings: SettingsModel | null): boolean => (settings as { split_view?: { on?: unknown } } | null)?.split_view?.on === true;

/**
 * What the rows' menu offers: "Open beside" on another thread than `open` (null: nothing open a pane can split from).
 * `makeRoom` runs as it opens: the window folds a docked sidebar that leaves too little room (panes/sidebarHold.ts).
 */
export function besideOf(panes: WindowPanes, open: string | null, makeRoom?: () => void): Beside {
  return {
    offers: (threadId) => panes.allowed && panes.panes.panes.length === 1 && open !== null && open !== threadId && besideFits(),
    open: (threadId) => {
      makeRoom?.();
      panes.openBeside(threadId);
    },
  };
}
