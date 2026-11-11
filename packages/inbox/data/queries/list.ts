/**
 * The window's list (`GET /api/inbox/threads`, read as a change since the list held: listRead.ts), in the cache. The
 * list read puts it here (`putList`), and so do the stream's records the list can take in place (`apply/list.ts`); the
 * window draws what `useListModel` gives.
 *
 * What the list read decides before it is held (`takeListRead`): a read that lands after a newer one (a slow answer
 * on a bad network, a catch-up's) is dropped, by the Inbox run and cursor; one that brought nothing new keeps the list
 * held (listSame.ts), so nothing is drawn again.
 *
 * `useListModel` hears the cache at once (a write calls it in the same task), so the list on screen (App's held rows,
 * set in that task too) and the list held are drawn together, never one render apart.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inboxApi, type ListModel } from '../../api';
import { sameListModel } from '../../listSame';
import { inboxKeys } from '../keys';

/** One list read: only the rows changed since the list this window holds (listRead.ts). */
export function readList(): Promise<ListModel> {
  return inboxApi.list();
}

export function heldList(client: QueryClient): ListModel | null {
  return client.getQueryData<ListModel>(inboxKeys.list()) ?? null;
}

/** The list held now; never dropped while the window is open (no observer counts it, so it is kept for good). */
export function putList(client: QueryClient, list: ListModel): void {
  client.setQueryData<ListModel>(inboxKeys.list(), list, { updatedAt: Date.now() });
}

/** The newest cursor a list read brought, by Inbox run (a read with nothing new keeps the list held, with its older cursor). */
export interface ListCursor {
  session: string;
  cursor: number;
}

/**
 * What a list read that landed does: `older` (a newer one landed first: the list held stays), `same` (nothing new:
 * the list held stays, and nothing is drawn again), or `new` (hold it). `cursor` is the newest cursor taken so far.
 */
export function takeListRead(held: ListModel | null, next: ListModel, cursor: ListCursor | null, options: { firstDone: boolean; adopt: boolean; settings: boolean }): 'older' | 'same' | 'new' {
  // Only an older cursor of the same Inbox run counts; an equal one may carry a delivery, a draft or a pin.
  const newest = held && cursor?.session === held.serverSession ? Math.max(cursor.cursor, held.cursor) : held?.cursor;
  if (held && next.serverSession === held.serverSession && next.cursor < newest!) return 'older';
  if (!options.adopt && held && options.firstDone && sameListModel(held, next, { cursor: options.settings })) return 'same';
  return 'new';
}

/** The list held, redrawn the moment the cache holds another (see the header). */
export function useListModel(client: QueryClient): ListModel | null {
  const [list, setList] = useState<ListModel | null>(() => heldList(client));
  useEffect(() => {
    setList(heldList(client));
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' && event.type !== 'removed') return;
      const key = event.query.queryKey;
      if (key.length !== 2 || key[0] !== 'inbox' || key[1] !== 'list') return;
      setList(heldList(client));
    });
  }, [client]);
  return list;
}
