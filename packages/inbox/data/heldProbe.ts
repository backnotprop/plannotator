import type { QueryClient } from '@tanstack/react-query';
import { inboxApi, type ListModel, type ThreadModel } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';
import { createInboxQueryClient } from './client';
import { inboxKeys } from './keys';
import { heldList } from './queries/list';
import { heldThread, isThreadStale, showableThread, threadReadsOut } from './queries/thread';

export interface HeldProbeRead {
  error?: string;
  busy: number;
  reading: number;
  threads: { threadId: string; held: ThreadModel; fresh: ThreadModel; note?: string }[];
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
    const reading = open ? threadReadsOut(open) : 0;
    for (const query of client.getQueryCache().findAll({ queryKey: inboxKeys.threads() })) {
      const threadId = query.queryKey[2];
      if (typeof threadId !== 'string') continue;
      const held = showableThread(client, threadId) ?? (threadId === open ? (heldThread(client, threadId) ?? null) : null);
      if (threadId === open && isThreadStale(client, threadId)) stale += 1;
      if (!held) continue;
      const fresh = await inboxApi.thread(threadId).catch((cause: unknown) => {
        if (machineOf(threadId)) return null;
        throw cause;
      });
      if (!fresh) continue;
      const state = client.getQueryState(inboxKeys.thread(threadId));
      const note = `open ${threadId === open}, stale ${isThreadStale(client, threadId)}, reads out ${threadReadsOut(threadId)}, held cursor ${held.cursor}, fresh cursor ${fresh.cursor}, applied ${JSON.stringify((held as { applied?: unknown }).applied ?? null)}, updated ${Date.now() - (state?.dataUpdatedAt ?? 0)} ms ago`;
      threads.push({ threadId, held, fresh, note });
    }
    const list = heldList(client);
    const fresh = list ? ((await (await fetch(WHOLE_LIST, { headers: { Accept: 'application/json' } })).json()) as ListModel) : null;
    return { busy: client.isFetching() + client.isMutating() + stale, reading, threads, list: list && fresh ? { held: list, fresh } : null };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause), busy: 1, reading: 0, threads: [], list: null };
  }
}

export function probedInboxQueryClient(): QueryClient {
  const client = createInboxQueryClient();
  const probe = (globalThis as { __plannotatorInboxHeld?: unknown }).__plannotatorInboxHeld;
  if (probe && typeof probe === 'object') (probe as HeldProbe).read = () => readHeld(client);
  return client;
}
