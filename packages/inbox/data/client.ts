import { QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { inboxKeys } from './keys';

export const THREAD_KEEP = 8;
export const THREAD_KEEP_MS = 5 * 60_000;

export function createInboxQueryClient(): QueryClient {
  const client = new QueryClient({
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
  client.setQueryDefaults(inboxKeys.list(), { gcTime: Infinity, structuralSharing: false });
  return client;
}

let alone: QueryClient | null = null;

export function useInboxQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? (alone ??= createInboxQueryClient());
}
