/**
 * Threads in the cache, by id: each as its read brought it, with the live stream's records applied since
 * (`apply/stream.ts`). The window reads a thread through `readThread` and puts the answer here (`putThread`); the
 * pane draws what `useHeldThread` gives, so a record, a Send's answer or a save redraws only what it changed.
 *
 * Going back to a thread draws its held copy at once (`showableThread`) while it is read again quietly. A copy is
 * shown only while nothing could have changed it unseen:
 *  - a gap in the stream marks every held thread stale (`staleThreads`): records that came meanwhile were not applied;
 *  - a record the window cannot apply (a 👍, a subject, a reply's comments) marks that thread stale (`staleThread`);
 *  - a copy older than THREAD_KEEP_MS is not shown (the server refreshes a repo's links on a read; records applied
 *    since keep the read's time);
 *  - never a launched thread (its run line moves with no record) or another machine's (App decides those two).
 * At most THREAD_KEEP threads no pane shows are kept; the least recently read go first.
 */
import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';
import { inboxApi, type ThreadModel } from '../../api';
import { reconcileRead, type HeldThread } from '../apply/record';
import { THREAD_KEEP, THREAD_KEEP_MS } from '../client';
import { inboxKeys } from '../keys';

/** One read of a thread from the Inbox (the window's `GET /api/inbox/threads/:id`). */
export function readThread(threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<ThreadModel> {
  return inboxApi.thread(threadId, timeoutMs, signal);
}

export function heldThread(client: QueryClient, threadId: string): HeldThread | undefined {
  return client.getQueryData<HeldThread>(inboxKeys.thread(threadId));
}

/** A read of the thread, kept: what records applied after it stay (`reconcileRead`). Returns what is held now. */
export function putThread(client: QueryClient, threadId: string, read: ThreadModel): HeldThread {
  const held = reconcileRead(heldThread(client, threadId), read);
  client.setQueryData<HeldThread>(inboxKeys.thread(threadId), held);
  trimThreads(client);
  return heldThread(client, threadId) ?? held;
}

/** The thread held, changed in place (a record, a save's answer): the read's time stays, so its age still counts. */
export function changeThread(client: QueryClient, threadId: string, change: (held: HeldThread) => HeldThread): void {
  const key = inboxKeys.thread(threadId);
  const state = client.getQueryState<HeldThread>(key);
  if (!state?.data) return;
  client.setQueryData<HeldThread>(key, change(state.data), { updatedAt: state.dataUpdatedAt });
  // A stale copy stays stale: the change went onto a copy that missed records.
  if (state.isInvalidated) void client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
}

/** The held copy, when it may be drawn at once on going back to the thread (see the header). */
export function showableThread(client: QueryClient, threadId: string, now: number = Date.now()): HeldThread | null {
  const state = client.getQueryState<HeldThread>(inboxKeys.thread(threadId));
  if (!state?.data || state.isInvalidated || now - state.dataUpdatedAt > THREAD_KEEP_MS) return null;
  if (state.data.run !== undefined) return null;
  return state.data;
}

/** Whether the copy held may have missed something (a gap, or a record it could not take). */
export function isThreadStale(client: QueryClient, threadId: string): boolean {
  return client.getQueryState(inboxKeys.thread(threadId))?.isInvalidated ?? true;
}

export function staleThread(client: QueryClient, threadId: string): void {
  void client.invalidateQueries({ queryKey: inboxKeys.thread(threadId), exact: true, refetchType: 'none' });
}

/** A gap in the stream, or a record that may change any thread (a project's): every held thread is stale. */
export function staleThreads(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: inboxKeys.threads(), refetchType: 'none' });
}

export function dropThread(client: QueryClient, threadId: string): void {
  client.removeQueries({ queryKey: inboxKeys.thread(threadId), exact: true });
}

/** Keep only the threads `keep` says (the list's rows, say), besides those a pane shows. */
export function pruneThreads(client: QueryClient, keep: (threadId: string) => boolean): void {
  for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
    const threadId = query.queryKey[2];
    if (typeof threadId === 'string' && !keep(threadId) && query.getObserversCount() === 0) client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

/** At most THREAD_KEEP threads no pane shows; the least recently read go first. */
function trimThreads(client: QueryClient): void {
  const idle = client
    .getQueryCache()
    .findAll({ queryKey: inboxKeys.threads() })
    .filter((query) => query.getObserversCount() === 0)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of idle.slice(THREAD_KEEP)) client.removeQueries({ queryKey: query.queryKey, exact: true });
}

/** The thread held for `threadId` (null: none, or no thread), redrawn when it changes. Never reads: App reads it. */
export function useHeldThread(threadId: string | null): HeldThread | null {
  const { data } = useQuery<HeldThread>({ queryKey: inboxKeys.thread(threadId ?? ''), queryFn: skipToken, notifyOnChangeProps: ['data'] });
  return threadId && data ? data : null;
}
