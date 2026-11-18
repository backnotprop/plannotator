/**
 * The Board remembers its filter (the person's ask: "a filter that is remembered"), as the list does (listFilter.ts):
 * per browser, in a cookie, never on the server. What it keeps is what the Board last showed: its Project and its Tag,
 * from a pick, a link or Back alike; nothing picked removes the cookie. The sidebar's Board row and its key open the
 * Board with them, so it is as the person left it; the address still says them (`#board&initiative=…`), and the
 * filter's tokens and × read as before. A project or tag that is gone is no filter once the Board has loaded
 * (App's `boardFilter`, model.ts `boardInitiativeOf`), and the next look forgets it.
 */
import { useEffect } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const BOARD_FILTER_COOKIE = 'plannotator-inbox-board-filter';

export interface BoardFilterPicks {
  project: string | null;
  initiative: string | null;
}

const id = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(v) ? v : null);

/** The remembered picks; anything the cookie cannot say is no filter. */
export function rememberedBoardFilter(): BoardFilterPicks {
  try {
    const value = JSON.parse(storage.getItem(BOARD_FILTER_COOKIE) ?? 'null') as Record<string, unknown> | null;
    return { project: id(value?.project), initiative: id(value?.initiative) };
  } catch {
    return { project: null, initiative: null };
  }
}

export function rememberBoardFilter(picks: BoardFilterPicks): void {
  try {
    if (!picks.project && !picks.initiative) storage.removeItem(BOARD_FILTER_COOKIE);
    else storage.setItem(BOARD_FILTER_COOKIE, JSON.stringify({ project: picks.project, initiative: picks.initiative }));
  } catch {
    // A page with no cookies: the Board opens on every card, as before.
  }
}

/** Keep what the Board shows (BoardFilter calls it while it is drawn). */
export function useRememberBoardFilter(project: string | null, initiative: string | null): void {
  useEffect(() => rememberBoardFilter({ project, initiative }), [project, initiative]);
}
