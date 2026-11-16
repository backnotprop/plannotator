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

/** Each thread on screen (`shown`) left stale by any path is read after `ms`, unless a read made it current meanwhile. */
export function watchStaleOpen(client: QueryClient, shown: () => readonly string[], read: (threadId: string) => void, ms = STALE_OPEN_MS): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const arm = (threadId: string) => {
    if (timers.has(threadId) || !heldThread(client, threadId) || !isThreadStale(client, threadId)) return;
    timers.set(
      threadId,
      setTimeout(() => {
        timers.delete(threadId);
        if (shown().includes(threadId) && heldThread(client, threadId) && isThreadStale(client, threadId)) read(threadId);
      }, ms),
    );
  };
  const stop = client.getQueryCache().subscribe((event) => {
    const threadId = event.query.queryKey[2];
    if (event.query.queryKey[1] === 'thread' && typeof threadId === 'string' && shown().includes(threadId)) arm(threadId);
  });
  return () => {
    stop();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

export function useStaleOpenRead(client: QueryClient, shown: () => readonly string[], read: (threadId: string) => void): void {
  const latest = useRef({ shown, read });
  latest.current = { shown, read };
  useEffect(() => watchStaleOpen(client, () => latest.current.shown(), (id) => latest.current.read(id)), [client]);
}
