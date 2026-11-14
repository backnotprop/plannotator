import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { heldThread, isThreadStale } from './data/queries/thread';
import type { ThreadModel } from './api';

export interface ThreadFlight {
  promise: Promise<InboxThread | null>;
  next: Promise<InboxThread | null> | null;
  settleNext: ((read: Promise<InboxThread | null>) => void) | null;
}

const STALE_AGAIN_MAX = 3;
const staleAgain = new Map<string, number>();

export function joinThreadRead(
  flights: Map<string, ThreadFlight>,
  threadId: string,
  given: ThreadModel | undefined,
  read: (threadId: string, given?: ThreadModel) => Promise<InboxThread | null>,
  stillStale: (threadId: string) => boolean = () => false,
): Promise<InboxThread | null> {
  if (given)
    return read(threadId, given).then((thread) => {
      if (thread !== null && stillStale(threadId)) void joinThreadRead(flights, threadId, undefined, read, stillStale);
      return thread;
    });
  const out = flights.get(threadId);
  if (out) {
    if (!out.next) out.next = new Promise((resolve) => (out.settleNext = (p) => resolve(p)));
    return out.next;
  }
  const flight: ThreadFlight = { promise: Promise.resolve(null), next: null, settleNext: null };
  let landed = false;
  flight.promise = read(threadId)
    .then((thread) => {
      landed = thread !== null;
      return thread;
    })
    .finally(() => {
      flights.delete(threadId);
      const stale = landed && stillStale(threadId);
      const tries = stale ? (staleAgain.get(threadId) ?? 0) + 1 : 0;
      if (tries === 0) staleAgain.delete(threadId);
      else staleAgain.set(threadId, tries);
      if (flight.settleNext) flight.settleNext(joinThreadRead(flights, threadId, undefined, read, stillStale));
      else if (stale && tries <= STALE_AGAIN_MAX) void joinThreadRead(flights, threadId, undefined, read, stillStale);
    });
  flights.set(threadId, flight);
  return flight.promise;
}

export const STALE_OPEN_MS = 1500;

export function watchStaleOpen(client: QueryClient, open: () => string | null, read: (threadId: string) => void, ms = STALE_OPEN_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    const threadId = open();
    if (!threadId || timer || !heldThread(client, threadId) || !isThreadStale(client, threadId)) return;
    timer = setTimeout(() => {
      timer = null;
      if (open() === threadId && heldThread(client, threadId) && isThreadStale(client, threadId)) read(threadId);
    }, ms);
  };
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[1] === 'thread' && event.query.queryKey[2] === open()) arm();
  });
  return () => {
    stop();
    if (timer) clearTimeout(timer);
  };
}

export function useStaleOpenRead(client: QueryClient, route: { readonly current: { thread: string | null } }, read: (threadId: string) => void): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => watchStaleOpen(client, () => route.current.thread, (id) => latest.current(id)), [client, route]);
}
