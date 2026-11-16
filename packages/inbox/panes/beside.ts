import { createContext, useContext, useEffect, useState } from 'react';
import type { SettingsModel } from '../api';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, paneGutters } from '../stack';
import type { WindowPanes } from './useRoutePanes';

/**
 * "Open beside" (config.json `inboxSplitView`, off unless turned on; no Settings row): a thread opens in a second pane
 * next to the one open, the two sharing the room beside the list (the list's edge hides it, as for one thread, and
 * they take the window). The rows' menu reads it from here, so no list or menu takes a prop for it.
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
 * Whether the list and two threads fit beside the docked sidebar as it is now: the list's narrowest column, two 440 px
 * threads and the gutters, 1292 px with the Soft look's (the window less the sidebar). Only then is "Open beside"
 * offered; a pair that loses that room later (the sidebar opened, the window narrowed) covers the list, as one thread does.
 */
export function besideFits(): boolean {
  if (typeof window === 'undefined') return false;
  const sidebar = document.querySelector('.pn-inbox .ib-sb[data-state="expanded"] .ib-sb-inner')?.getBoundingClientRect().width ?? 0;
  return window.innerWidth - sidebar >= LIST_MIN_WIDTH + 2 * THREAD_BESIDE_FILE_WIDTH + paneGutters(null, 2);
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

/** What the rows' menu offers: "Open beside" on another thread than `open` (null: nothing open a pane can split from). */
export function besideOf(panes: WindowPanes, open: string | null): Beside {
  return {
    offers: (threadId) => panes.allowed && panes.panes.panes.length === 1 && open !== null && open !== threadId && besideFits(),
    open: panes.openBeside,
  };
}
