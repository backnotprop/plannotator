import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inboxApi, type ListModel } from '../../api';
import { sameListModel } from '../../listSame';
import { inboxKeys } from '../keys';

export function readList(): Promise<ListModel> {
  return inboxApi.list();
}

export function heldList(client: QueryClient): ListModel | null {
  return client.getQueryData<ListModel>(inboxKeys.list()) ?? null;
}

export function putList(client: QueryClient, list: ListModel): void {
  client.setQueryData<ListModel>(inboxKeys.list(), list, { updatedAt: Date.now() });
}

export interface ListCursor {
  session: string;
  cursor: number;
}

export function takeListRead(held: ListModel | null, next: ListModel, cursor: ListCursor | null, options: { firstDone: boolean; adopt: boolean; settings: boolean; again?: boolean }): 'older' | 'again' | 'same' | 'new' {
  const newest = held && cursor?.session === held.serverSession ? Math.max(cursor.cursor, held.cursor) : held?.cursor;
  if (held && next.serverSession === held.serverSession && next.cursor < newest!) return options.adopt && !options.again ? 'again' : 'older';
  if (!options.adopt && held && options.firstDone && sameListModel(held, next, { cursor: options.settings })) return 'same';
  return 'new';
}

export async function readListTaking(held: () => ListModel | null, cursor: () => ListCursor | null, options: { firstDone: boolean; adopt: boolean; settings: boolean }): Promise<{ next: ListModel; held: ListModel | null; taken: 'older' | 'same' | 'new' }> {
  for (let again = false; ; again = true) {
    const next = await readList();
    const now = held();
    const taken = takeListRead(now, next, cursor(), { ...options, again });
    if (taken !== 'again') return { next, held: now, taken };
  }
}

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
