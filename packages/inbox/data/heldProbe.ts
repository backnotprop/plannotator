import type { QueryClient } from '@tanstack/react-query';
import { inboxApi, type ListModel, type ThreadModel } from '../api';
import { inboxUrl } from '../inboxUrl';
import { createInboxQueryClient } from './client';
import { inboxKeys } from './keys';
import { heldList } from './queries/list';
import { heldThread, isThreadStale, showableThread } from './queries/thread';

export interface HeldProbeRead {
  error?: string;
  busy: number;
  threads: { threadId: string; held: ThreadModel; fresh: ThreadModel }[];
  list: { held: ListModel; fresh: ListModel } | null;
}

export interface HeldProbe {
  read?: () => Promise<HeldProbeRead | null>;
}

const WHOLE_LIST = inboxUrl('/threads', 'archived=exclude&snoozed=exclude&machines=1&since=');

const openThread = (): string | null => {
  const match = /(?:^#|&)thread=([^&]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
};

async function readHeld(client: QueryClient): Promise<HeldProbeRead> {
  try {
    const threads: HeldProbeRead['threads'] = [];
    const open = openThread();
    let stale = 0;
    for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
      const threadId = query.queryKey[2];
      if (typeof threadId !== 'string') continue;
      const held = showableThread(client, threadId) ?? (threadId === open ? (heldThread(client, threadId) ?? null) : null);
      if (threadId === open && isThreadStale(client, threadId)) stale += 1;
      if (held) threads.push({ threadId, held, fresh: await inboxApi.thread(threadId) });
    }
    const list = heldList(client);
    const fresh = list ? ((await (await fetch(WHOLE_LIST, { headers: { Accept: 'application/json' } })).json()) as ListModel) : null;
    return { busy: client.isFetching() + client.isMutating() + stale, threads, list: list && fresh ? { held: list, fresh } : null };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause), busy: 1, threads: [], list: null };
  }
}

export function probedInboxQueryClient(): QueryClient {
  const client = createInboxQueryClient();
  const probe = (globalThis as { __plannotatorInboxHeld?: unknown }).__plannotatorInboxHeld;
  if (probe && typeof probe === 'object') (probe as HeldProbe).read = () => readHeld(client);
  return client;
}
