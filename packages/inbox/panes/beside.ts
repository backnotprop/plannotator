import { createContext, useContext, useEffect, useState } from 'react';
import type { SettingsModel } from '../api';
import { THREAD_BESIDE_FILE_WIDTH, paneGutters } from '../stack';
import type { WindowPanes } from './useRoutePanes';

/**
 * "Open beside" (config.json `inboxSplitView`, off unless turned on; no Settings row): a thread opens in a second pane
 * next to the one open, the two side by side over the whole window as a thread in full screen is. The rows' menu
 * reads it from here, so no list or menu takes a prop for it.
 */
export interface Beside {
  /** "Open beside" is offered for `threadId`: another thread is open, there is room, and only one pane shows. */
  offers: (threadId: string) => boolean;
  open: (threadId: string) => void;
}

export const BesideContext = createContext<Beside | null>(null);

export const useBeside = (): Beside | null => useContext(BesideContext);

/**
 * The narrowest window two thread panes fit: two of the narrowest thread columns the window draws (a thread beside a
 * file, stack.ts) and the gutters around and between them. 904 px with the Soft look's 8 px gutters.
 */
export const besideRoom = (gutters: number): number => 2 * THREAD_BESIDE_FILE_WIDTH + gutters;

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
    offers: (threadId) => panes.allowed && panes.panes.panes.length === 1 && open !== null && open !== threadId,
    open: panes.openBeside,
  };
}
