/**
 * The list's Archived group (approval "inbox-archived-group"): its rows, read only while the group is open. Closed, it
 * holds nothing: no read, and the rows a read brought are dropped from the cache. Open, it reads the newest archived
 * first, `limit` at a time (every linked machine's too when one is linked, this Inbox's own drawn before they answer),
 * and again when the list it sits under gains or loses a thread (an archive or an Unarchive anywhere).
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi, type ArchivedModel, type ListModel } from '../../api';
import { inboxKeys } from '../keys';

/** Rows the group shows at first, and how many more "Show 20 more" adds. */
export const ARCHIVED_STEP = 20;
/** The most the group shows; past it the group points to Search. */
export const ARCHIVED_MOST = 100;

export interface ArchivedAsk {
  project: string | null;
  merged: boolean;
  limit: number;
}

export interface ArchivedRead {
  page: ArchivedModel | null;
  /** This Inbox's rows alone, drawn while the linked machines' answer is on its way: "Nothing archived." waits. */
  partial: boolean;
  failed: unknown;
}

/** Called only while the group is open: the group draws its rows' part only then, and closing drops what it read. */
export function useArchivedPage(ask: ArchivedAsk): ArchivedRead {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: inboxKeys.archived(ask.project, ask.merged, ask.limit),
    queryFn: () => inboxApi.archived({ project: ask.project, limit: ask.limit, machines: ask.merged }),
    gcTime: 0,
    // "Show 20 more" keeps the rows on screen while the longer page is read.
    placeholderData: (previous) => previous,
  });
  // Machines linked: this Inbox's own rows first, so a slow machine (its wait is up to 2 s) does not hold them back.
  const own = useQuery({
    queryKey: inboxKeys.archived(ask.project, false, ask.limit),
    queryFn: () => inboxApi.archived({ project: ask.project, limit: ask.limit, machines: false }),
    gcTime: 0,
    enabled: ask.merged && query.data === undefined,
  });
  const early = ask.merged && query.data === undefined ? (own.data ?? null) : null;
  useEffect(() => {
    const stop = followList(client);
    return () => {
      stop();
      client.removeQueries({ queryKey: inboxKeys.archivedAll() });
    };
  }, [client]);
  return { page: query.data ?? early, partial: early !== null, failed: query.isError ? query.error : null };
}

/** The threads a list read holds (every section and the snoozed). */
function listIds(list: ListModel | undefined): string {
  if (!list) return '';
  const ids = [...list.sections.flatMap((section) => section.threads), ...(list.snoozed ?? [])].map((row) => row.thread_id);
  return ids.sort().join(',');
}

/** Read the group again whenever the list's threads change. Nothing on screen redraws for it but the group. */
function followList(client: QueryClient): () => void {
  let seen = listIds(client.getQueryData<ListModel>(inboxKeys.list()));
  return client.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (event.type !== 'updated' || key.length !== 2 || key[0] !== 'inbox' || key[1] !== 'list') return;
    const now = listIds(event.query.state.data as ListModel | undefined);
    if (now === seen) return;
    seen = now;
    void client.invalidateQueries({ queryKey: inboxKeys.archivedAll() });
  });
}

/** An archived row the open group holds, for its row menu. */
export function archivedRowOf(client: QueryClient, threadId: string): InboxListRow | null {
  for (const [, page] of client.getQueriesData<ArchivedModel>({ queryKey: inboxKeys.archivedAll() })) {
    const row = page?.threads.find((r) => r.thread_id === threadId);
    if (row) return row;
  }
  return null;
}

/** Unarchive drawn at once: the row leaves the group. The answer puts it back when the write did not land. */
export function dropArchivedRow(client: QueryClient, threadId: string): () => void {
  const before = client.getQueriesData<ArchivedModel>({ queryKey: inboxKeys.archivedAll() });
  client.setQueriesData<ArchivedModel>({ queryKey: inboxKeys.archivedAll() }, (page) =>
    page && page.threads.some((row) => row.thread_id === threadId) ? { ...page, total: Math.max(0, page.total - 1), threads: page.threads.filter((row) => row.thread_id !== threadId) } : page,
  );
  return () => {
    for (const [key, page] of before) client.setQueryData(key, page);
  };
}
