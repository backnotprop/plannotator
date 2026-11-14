import { useState } from 'react';
import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { inboxApi, type ThreadModel } from '../../api';
import { reconcileRead, type HeldThread } from '../apply/record';
import { THREAD_KEEP, THREAD_KEEP_MS } from '../client';
import { inboxKeys } from '../keys';

export function readThread(threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<ThreadModel> {
  return inboxApi.thread(threadId, timeoutMs, signal);
}

export function heldThread(client: QueryClient, threadId: string): HeldThread | undefined {
  return client.getQueryData<HeldThread>(inboxKeys.thread(threadId));
}

export function putThread(client: QueryClient, threadId: string, read: ThreadModel): HeldThread {
  const held = reconcileRead(heldThread(client, threadId), read);
  client.setQueryData<HeldThread>(inboxKeys.thread(threadId), held);
  trimThreads(client);
  return heldThread(client, threadId) ?? held;
}

export function changeThread(client: QueryClient, threadId: string, change: (held: HeldThread) => HeldThread): void {
  const key = inboxKeys.thread(threadId);
  const state = client.getQueryState<HeldThread>(key);
  if (!state?.data) return;
  client.setQueryData<HeldThread>(key, change(state.data), { updatedAt: state.dataUpdatedAt });
  if (state.isInvalidated) void client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
}

export function showableThread(client: QueryClient, threadId: string, now: number = Date.now()): HeldThread | null {
  const state = client.getQueryState<HeldThread>(inboxKeys.thread(threadId));
  if (!state?.data || state.isInvalidated || now - state.dataUpdatedAt > THREAD_KEEP_MS) return null;
  if (state.data.run !== undefined) return null;
  return state.data;
}

export function isThreadStale(client: QueryClient, threadId: string): boolean {
  return client.getQueryState(inboxKeys.thread(threadId))?.isInvalidated ?? true;
}

export function staleThread(client: QueryClient, threadId: string): void {
  void client.invalidateQueries({ queryKey: inboxKeys.thread(threadId), exact: true, refetchType: 'none' });
}

export function staleThreads(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inboxKeys.threads(), refetchType: 'none' });
}

export function dropThread(client: QueryClient, threadId: string): void {
  client.removeQueries({ queryKey: inboxKeys.thread(threadId), exact: true });
}

export function pruneThreads(client: QueryClient, keep: (threadId: string) => boolean): void {
  for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
    const threadId = query.queryKey[2];
    if (typeof threadId === 'string' && !keep(threadId) && query.getObserversCount() === 0) client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

function trimThreads(client: QueryClient): void {
  const idle = client
    .getQueryCache()
    .findAll({ queryKey: inboxKeys.threads() })
    .filter((query) => query.getObserversCount() === 0)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of idle.slice(THREAD_KEEP)) client.removeQueries({ queryKey: query.queryKey, exact: true });
}

export function useHeldThread(threadId: string | null): HeldThread | null {
  const client = useQueryClient();
  const { data } = useQuery<HeldThread>({ queryKey: inboxKeys.thread(threadId ?? ''), queryFn: skipToken, notifyOnChangeProps: ['data'] });
  const unshowable = () => (threadId && data && !showableThread(client, threadId) ? data : null);
  const [opened, setOpened] = useState(() => ({ threadId, hidden: unshowable() }));
  let hidden = opened.hidden;
  if (opened.threadId !== threadId) {
    hidden = unshowable();
    setOpened({ threadId, hidden });
  }
  return threadId && data && data !== hidden ? data : null;
}
