import { createContext, useContext } from 'react';
import type { SettingsModel } from '../api';
import * as L from './layoutModel';
import { fits } from './layoutRoom';
import { measureRoom } from './paneDrop';
import type { WindowPanes } from './useRoutePanes';

/**
 * "Open beside" (config.json `inboxSplitView`, off unless turned on; no Settings row): a thread opens in a new pane
 * right of the active one. The rows' menu reads it from here, so no list or menu takes a prop for it. Dragging the
 * row onto a pane does the same with a place of the person's choosing (paneDrop.ts).
 */
export interface Beside {
  /** "Open beside" is offered for `threadId`: another thread is open, `threadId` is in no pane, and the panes still fit. */
  offers: (threadId: string) => boolean;
  open: (threadId: string) => void;
}

export const BesideContext = createContext<Beside | null>(null);

export const useBeside = (): Beside | null => useContext(BesideContext);

/** The switch as the settings read sends it (server: inbox.ts, present only while on). */
export const splitViewOn = (settings: SettingsModel | null): boolean => (settings as { split_view?: { on?: unknown } } | null)?.split_view?.on === true;

/**
 * Whether one more pane right of the active one fits the room beside the list, a docked sidebar counted as room (it
 * folds on screen when the item is chosen: sidebarHold.ts). Each pane keeps 440 px (layoutRoom.ts).
 */
export function besideFits(layout: L.FreeLayout, open: string, threadId: string): boolean {
  if (typeof document === 'undefined') return false;
  const from = layout.active ? layout : L.follow(L.EMPTY_LAYOUT, open);
  const next = L.openAt(from, threadId, from.active!, 'right');
  const measured = measureRoom(true);
  return !!next.root && !!measured && fits(next.root, measured.room, measured.gap);
}

/**
 * What the rows' menu offers: "Open beside" on another thread than `open` (null: nothing open a pane can split from).
 * `makeRoom` runs as it opens, with the columns the panes will need: the window folds a docked sidebar that leaves too
 * little room (panes/sidebarHold.ts).
 */
export function besideOf(panes: WindowPanes, open: string | null, makeRoom?: (columns: number) => void): Beside {
  return {
    offers: (threadId) => panes.allowed && open !== null && open !== threadId && L.paneOfThread(panes.layout, threadId) === null && besideFits(panes.layout, open, threadId),
    open: (threadId) => {
      const at = panes.layout;
      if (open !== null && at.active) makeRoom?.(L.columns(L.openAt(at, threadId, at.active, 'right').root));
      panes.openBeside(threadId);
    },
  };
}
