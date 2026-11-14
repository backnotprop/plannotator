import type { InboxThread } from '@plannotator/core/inbox-types';
import type { ThreadModel } from './api';

export interface ThreadFlight {
  promise: Promise<InboxThread | null>;
  again: boolean;
}

export function joinThreadRead(
  flights: Map<string, ThreadFlight>,
  threadId: string,
  given: ThreadModel | undefined,
  read: (threadId: string, given?: ThreadModel) => Promise<InboxThread | null>,
): Promise<InboxThread | null> {
  if (given) return read(threadId, given);
  const out = flights.get(threadId);
  if (out) {
    out.again = true;
    return out.promise;
  }
  const flight: ThreadFlight = { promise: Promise.resolve(null), again: false };
  flight.promise = read(threadId).finally(() => {
    flights.delete(threadId);
    if (flight.again) void joinThreadRead(flights, threadId, undefined, read);
  });
  flights.set(threadId, flight);
  return flight.promise;
}
