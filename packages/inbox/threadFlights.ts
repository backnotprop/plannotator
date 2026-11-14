import type { InboxThread } from '@plannotator/core/inbox-types';
import type { ThreadModel } from './api';

export interface ThreadFlight {
  promise: Promise<InboxThread | null>;
  again: boolean;
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
  if (given) return read(threadId, given);
  const out = flights.get(threadId);
  if (out) {
    out.again = true;
    return out.promise;
  }
  const flight: ThreadFlight = { promise: Promise.resolve(null), again: false };
  let landed = false;
  flight.promise = read(threadId).then((thread) => {
    landed = thread !== null;
    return thread;
  }).finally(() => {
    flights.delete(threadId);
    const stale = landed && stillStale(threadId);
    const tries = stale ? (staleAgain.get(threadId) ?? 0) + 1 : 0;
    if (tries === 0) staleAgain.delete(threadId);
    else staleAgain.set(threadId, tries);
    if (flight.again || (stale && tries <= STALE_AGAIN_MAX)) void joinThreadRead(flights, threadId, undefined, read, stillStale);
  });
  flights.set(threadId, flight);
  return flight.promise;
}
