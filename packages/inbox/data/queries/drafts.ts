import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';
import type { InboxReplyDraftRow } from '@plannotator/core/inbox-types';
import { inboxApi, type DraftView } from '../../api';
import { inboxKeys } from '../keys';

export type DraftsModel = Awaited<ReturnType<typeof inboxApi.drafts>>;

const NO_REPLIES: InboxReplyDraftRow[] = [];

/** Per window's client, when the drafts list that it holds now was asked for (absent: never read). */
const repliesAskedAt = new WeakMap<QueryClient, number>();

export async function readDrafts(client: QueryClient): Promise<void> {
  const asked = Date.now();
  const next = await inboxApi.drafts();
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), next);
  repliesAskedAt.set(client, Math.max(asked, repliesAskedAt.get(client) ?? 0));
}

export function changeDrafts(client: QueryClient, change: (drafts: DraftView[]) => DraftView[]): void {
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), (held) => (held ? { ...held, drafts: change(held.drafts) } : { serverSession: '', drafts: change([]), replies: NO_REPLIES }));
}

export function heldReplyDrafts(client: QueryClient): InboxReplyDraftRow[] {
  return client.getQueryData<DraftsModel>(inboxKeys.drafts())?.replies ?? NO_REPLIES;
}

/**
 * Whether this thread's saved reply draft holds words, as the drafts list says. Null: not known, because the list was
 * never read (a model `changeDrafts` built holds no replies) or was asked for before `since` (a save that ended then).
 */
export function replyDraftHasWords(client: QueryClient, threadId: string, since = 0): boolean | null {
  const held = client.getQueryData<DraftsModel>(inboxKeys.drafts());
  const asked = repliesAskedAt.get(client);
  if (!held || asked === undefined) return null;
  if ((held.replies ?? NO_REPLIES).some((row) => row.thread_id === threadId && (row.reply_preview ?? '').trim() !== '')) return true;
  return asked < since ? null : false;
}

export function useDrafts(): { drafts: DraftView[] | null; replies: InboxReplyDraftRow[] } {
  const { data } = useQuery<DraftsModel>({ queryKey: inboxKeys.drafts(), queryFn: skipToken, gcTime: Infinity, notifyOnChangeProps: ['data'] });
  return { drafts: data?.drafts ?? null, replies: data?.replies ?? NO_REPLIES };
}
