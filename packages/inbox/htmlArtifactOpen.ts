/**
 * Which html block is open big, from the Artifacts (the owner, 2026-11-25: "render html inline still and offer same
 * UX there. Can annotate inline and all. Ideally it would show in artifacts"). A block is not a file, so it never
 * opens in the file viewer (which loads nothing from the web, and a block that loads a chart library would draw
 * blank there): its tile opens the block's own page, big, with the block's own tools (ui's `HtmlEmbedBlock` with
 * `open`, drawn by components/HtmlArtifactOpen.tsx in its thread).
 *
 * One request at a time, outside the route: the thread's grid asks here and its thread draws it; the Wall asks here
 * and then opens the thread (`back` is the Wall's address, so closing goes back to the Wall). Closing from the grid
 * puts focus back on the tile it was opened from.
 */

import { useSyncExternalStore } from 'react';
import { backTo } from './history';
import { routeOf } from './app/route';
import { currentHash, writeRoute } from './app/writeRoute';

export interface HtmlArtifactRequest {
  threadId: string;
  /** `html:<message id>:<hash>`. */
  key: string;
  /** The address to go back to on close (the Wall's); null: stay (the thread's grid). */
  back: string | null;
  /** What had focus when it opened (the tile): focus comes back to it on close. */
  from: HTMLElement | null;
}

let request: HtmlArtifactRequest | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** Open a thread's html block big. `fromWall`: the Wall asked, and the thread opens next (closing goes back to it). */
export function openHtmlArtifact(threadId: string, key: string, options: { fromWall?: boolean } = {}): void {
  const from = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  request = { threadId, key, back: options.fromWall ? currentHash() : null, from };
  changed();
}

/** Close it: back to the Wall when it came from there, else focus on the tile it came from. */
export function closeHtmlArtifact(): void {
  const was = request;
  if (!was) return;
  request = null;
  changed();
  if (was.back !== null) {
    const back = was.back;
    if (!backTo(back)) writeRoute(routeOf(back));
    return;
  }
  if (was.from?.isConnected) was.from.focus({ preventScroll: true });
}

/** Forget it without going anywhere: its thread left the screen (a Back, another thread). */
export function dropHtmlArtifact(threadId: string): void {
  if (request?.threadId !== threadId) return;
  request = null;
  changed();
}

/** The open request for this thread, or null. */
export function useHtmlArtifactOpen(threadId: string): HtmlArtifactRequest | null {
  const now = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
    () => null,
  );
  return now?.threadId === threadId ? now : null;
}

/** Tests only. */
export function resetHtmlArtifactOpenForTest(): void {
  request = null;
  changed();
}
