/**
 * The window's one query client and the defaults it runs on (TanStack Query 5).
 *
 * The window talks to its own Inbox: on this computer, or over a tailnet from a phone or a laptop on a poor link.
 * The live stream (sharedEvents.ts) says what changed, so time never decides that held data went stale:
 *  - `staleTime: Infinity`: a held thread is current while the stream is heard (its records are applied in place);
 *    a gap in the stream marks every held thread stale (`staleThreads`), and the open one is read again. A timer would
 *    only re-read for nothing on a good stream and add traffic on a poor one.
 *  - `gcTime` THREAD_KEEP_MS (5 min): a thread left is kept that long for going back to it, and never more than
 *    THREAD_KEEP threads (queries/thread.ts trims). The server refreshes a repo's links on a read, so an older copy is
 *    not shown anyway.
 *  - `retry: false`: reads keep the window's own schedule (250 ms to 5 s, woken when another read lands, a 404 or a
 *    refusal never retried, App.tsx `THREAD_READ_RETRY_MS`); writes carry idempotency keys and say their own errors.
 *  - `networkMode: 'always'`: `navigator.onLine` says nothing about the Inbox (loopback works offline; a hotel's
 *    captive portal says online). A write is sent, and fails or lands, as before; never parked by the library.
 *  - no refetch on focus or reconnect: the stream's catch-up reads once after a gap (`onCatchUp`), and a read per
 *    query on every focus would multiply reads on a poor link.
 *  - structural sharing on (the default): a read keeps every unchanged part as the same object, so a message that
 *    did not change is the same object and its part does not draw again (it replaced shareUnchanged.ts).
 */
import { QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';

/** How many threads left are kept for going back to them, and for how long. */
export const THREAD_KEEP = 8;
export const THREAD_KEEP_MS = 5 * 60_000;

export function createInboxQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: THREAD_KEEP_MS,
        retry: false,
        networkMode: 'always',
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      },
      mutations: { retry: 0, networkMode: 'always' },
    },
  });
}

let alone: QueryClient | null = null;

/**
 * The window's client (InboxApp provides it). A pane mounted on its own, outside the window (a DOM test of the thread
 * pane), saves and sends through a client of its own, so its writes still land and say their errors.
 */
export function useInboxQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? (alone ??= createInboxQueryClient());
}
