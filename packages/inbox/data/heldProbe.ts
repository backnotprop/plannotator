import type { QueryClient } from '@tanstack/react-query';
import { inboxApi, type ListModel, type ThreadModel } from '../api';
import { inboxUrl } from '../inboxUrl';
import { createInboxQueryClient } from './client';
import { inboxKeys } from './keys';
import { heldList } from './queries/list';
import { showableThread } from './queries/thread';

export interface HeldProbeRead {
  busy: number;
  threads: { threadId: string; held: ThreadModel; fresh: ThreadModel }[];
  list: { held: ListModel; fresh: ListModel } | null;
}

export interface HeldProbe {
  read?: () => Promise<HeldProbeRead | null>;
}

const WHOLE_LIST = inboxUrl('/threads', 'archived=exclude&snoozed=exclude&machines=1&since=');

async function readHeld(client: QueryClient): Promise<HeldProbeRead | null> {
  try {
    const threads: HeldProbeRead['threads'] = [];
    for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
      const threadId = query.queryKey[2];
      const held = typeof threadId === 'string' ? showableThread(client, threadId) : null;
      if (typeof threadId === 'string' && held) threads.push({ threadId, held, fresh: await inboxApi.thread(threadId) });
    }
    const list = heldList(client);
    const fresh = list ? ((await (await fetch(WHOLE_LIST, { headers: { Accept: 'application/json' } })).json()) as ListModel) : null;
    return { busy: client.isFetching() + client.isMutating(), threads, list: list && fresh ? { held: list, fresh } : null };
  } catch {
    return null;
  }
}

export function probedInboxQueryClient(): QueryClient {
  const client = createInboxQueryClient();
  const probe = (globalThis as { __plannotatorInboxHeld?: unknown }).__plannotatorInboxHeld;
  if (probe && typeof probe === 'object') (probe as HeldProbe).read = () => readHeld(client);
  return client;
}
