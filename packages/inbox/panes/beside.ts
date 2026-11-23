import { createContext, useContext } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { LayoutNode } from '@plannotator/vendor-pierre-layouts';
import type { SettingsModel } from '../api';
import type { InboxToastModel } from '../components/Toast';
import * as L from './layoutModel';
import { placeToSide, steppedAside, type SidePlace } from './layoutRoom';
import { measureRoom, paneRects } from './paneDrop';
import type { WindowPanes } from './useRoutePanes';

/**
 * "Open to the side" (config.json `inboxSplitView`, Settings → General → Appearance, off by default): a thread opens in a new
 * pane, placed by the room (layoutRoom.ts `placeToSide`: right of the active pane, else below it, else the largest
 * pane split). The rows' menu reads it from here, so no list or menu takes a prop for it. Dragging the row onto a
 * pane does the same with a place of the person's choosing (paneDrop.ts).
 */
export interface Beside {
  /** "Open to the side" is offered for `threadId`: a thread is open, and `threadId` is in no pane. */
  offers: (threadId: string) => boolean;
  open: (threadId: string) => void;
}

export const BesideContext = createContext<Beside | null>(null);

export const useBeside = (): Beside | null => useContext(BesideContext);

/**
 * The switch as the settings read sends it (server: inbox.ts `split_view`; Settings → General → Appearance, and
 * `event: capabilities` when it changes). Null from a settings model without it: no Settings row.
 */
export function splitViewSetting(settings: SettingsModel | null): { on: boolean } | null {
  const on = (settings as { split_view?: { on?: unknown } } | null)?.split_view?.on;
  return typeof on === 'boolean' ? { on } : null;
}

export const splitViewOn = (settings: SettingsModel | null): boolean => splitViewSetting(settings)?.on === true;

/**
 * Where "Open to the side" opens `threadId` in the room beside the list now, a docked sidebar counted as room (it
 * folds on screen when the item is chosen: sidebarHold.ts). Null without a window to measure: right of the active pane.
 */
export function sidePlace(layout: L.FreeLayout, threadId: string): SidePlace | null {
  if (typeof document === 'undefined' || !layout.active) return null;
  const measured = measureRoom(true);
  if (!measured) return null;
  const place = placeToSide(layout, threadId, measured.room, measured.gap, paneRects());
  if (place.stepsAside.length === 0) return place;
  // Nothing fits even with the sidebar folded, so it does not fold: what steps aside is what the room now leaves.
  const now = measureRoom();
  return now ? { ...place, stepsAside: steppedAside(layout, place.next, now.room, now.gap) } : place;
}

/** What the window tells the person when a pane steps aside for one opened to the side. */
export interface BesideNotice {
  toast: (toast: Omit<InboxToastModel, 'id'>) => void;
  /** Takes the toast away if it is still the one on screen, the one with this Undo. */
  dismiss: (undo: () => void) => void;
  rowOf: (threadId: string) => InboxListRow | null;
}

/** The toast for panes that stepped aside: their subjects, and Undo, which closes the new pane so they come back. */
export function steppedAsideToast(threads: readonly string[], rowOf: BesideNotice['rowOf'], undo: () => void): Omit<InboxToastModel, 'id'> {
  const names = threads.map((thread) => rowOf(thread)?.subject || 'A thread');
  const lead = names.length === 1 ? 'No room for another pane' : 'No room for more panes';
  const detail = names.length === 1 ? `“${names[0]}” stepped aside` : `${names.length} panes stepped aside`;
  return { icon: 'check', lead, detail, speech: `${lead}: ${detail}.`, onUndo: undo };
}

/**
 * The toast for panes that stepped aside because the room shrank (the window narrowed, the sidebar opened): the same
 * words, with nothing to undo. They come back in place once the room is there again (layoutRoom.ts).
 */
export function roomShrankToast(threads: readonly string[], rowOf: BesideNotice['rowOf']): Omit<InboxToastModel, 'id'> {
  const names = threads.map((thread) => rowOf(thread)?.subject || 'A thread');
  const lead = 'No room for more panes';
  const detail = names.length === 1 ? `“${names[0]}” stepped aside` : `${names.length} panes stepped aside`;
  return { icon: 'check', lead, detail, speech: `${lead}: ${detail}.` };
}

/** What a layout places, its sizes left out: its rows and columns, each pane's thread, the active pane. */
export function placementKey(layout: L.FreeLayout): string {
  const shape = (node: LayoutNode | null): unknown => (!node ? null : node.type === 'split' ? [node.direction, node.children.map(shape)] : node.id);
  return JSON.stringify([shape(layout.root), Object.entries(layout.threads).sort(), layout.active]);
}

/** The placement the stepped-aside toast on screen announced, and its Undo: null once the layout is another. */
let announced: { key: string; undo: () => void; dismiss: BesideNotice['dismiss'] } | null = null;

/**
 * Every layout the window holds comes here (useRoutePanes.ts). Once it is not the placement the toast announced (the
 * new pane shows another thread, it closed, another pane opened or moved, the person went into another pane), the
 * toast leaves and its Undo does nothing: Undo only ever takes back the placement it named.
 */
export function besideLayoutSeen(layout: L.FreeLayout): void {
  if (!announced || placementKey(layout) === announced.key) return;
  const gone = announced;
  announced = null;
  gone.dismiss(gone.undo);
}

/**
 * What the rows' menu offers: "Open to the side" on another thread than `open` (null: nothing open a pane can split
 * from). `makeRoom` runs as it opens, with the columns the panes will need: the window folds a docked sidebar that
 * leaves too little room (panes/sidebarHold.ts). `notice` says which panes stepped aside when nothing fit.
 */
export function besideOf(panes: WindowPanes, open: string | null, makeRoom?: (columns: number) => void, notice?: BesideNotice): Beside {
  return {
    offers: (threadId) => panes.allowed && open !== null && open !== threadId && L.paneOfThread(panes.layout, threadId) === null,
    open: (threadId) => {
      const place = open !== null ? sidePlace(panes.layout, threadId) : null;
      if (!place) {
        if (open !== null && panes.layout.active) makeRoom?.(L.columns(L.openAt(panes.layout, threadId, panes.layout.active, 'right').root));
        panes.openBeside(threadId);
        return;
      }
      if (place.stepsAside.length === 0) makeRoom?.(L.columns(place.next.root));
      panes.openAt(threadId, place.target, place.edge);
      const added = place.next.active!;
      if (!place.stepsAside.length || !notice) return;
      const undo = () => {
        if (announced?.undo !== undo) return;
        announced = null;
        notice.dismiss(undo);
        panes.closePane(added);
      };
      notice.toast(steppedAsideToast(place.stepsAside.map((id) => panes.layout.threads[id]!), notice.rowOf, undo));
      announced = { key: placementKey(place.next), undo, dismiss: notice.dismiss };
    },
  };
}
