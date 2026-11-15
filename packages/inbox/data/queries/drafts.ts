import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';
import type { InboxReplyDraftRow } from '@plannotator/core/inbox-types';
import { inboxApi, type DraftView } from '../../api';
import { inboxKeys } from '../keys';

export type DraftsModel = Awaited<ReturnType<typeof inboxApi.drafts>>;

const NO_REPLIES: InboxReplyDraftRow[] = [];

export async function readDrafts(client: QueryClient): Promise<void> {
  const next = await inboxApi.drafts();
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), next);
}

export function changeDrafts(client: QueryClient, change: (drafts: DraftView[]) => DraftView[]): void {
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), (held) => (held ? { ...held, drafts: change(held.drafts) } : { serverSession: '', drafts: change([]), replies: NO_REPLIES }));
}

export function heldReplyDrafts(client: QueryClient): InboxReplyDraftRow[] {
  return client.getQueryData<DraftsModel>(inboxKeys.drafts())?.replies ?? NO_REPLIES;
}

export function useDrafts(): { drafts: DraftView[] | null; replies: InboxReplyDraftRow[] } {
  const { data } = useQuery<DraftsModel>({ queryKey: inboxKeys.drafts(), queryFn: skipToken, gcTime: Infinity, notifyOnChangeProps: ['data'] });
  return { drafts: data?.drafts ?? null, replies: data?.replies ?? NO_REPLIES };
}
